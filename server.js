const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ht-secret-change-in-production';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ─────────────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'holiday.db');
const db = new Database(DB_PATH);

// Count working days (Mon–Fri) between two YYYY-MM-DD strings
db.function('workdays', (startStr, endStr) => {
  if (!startStr || !endStr) return 0;
  let count = 0;
  const end = new Date(endStr + 'T00:00:00');
  const cur = new Date(startStr + 'T00:00:00');
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
});

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    email         TEXT    UNIQUE NOT NULL,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'employee',
    department    TEXT    NOT NULL DEFAULT '',
    job_title     TEXT    NOT NULL DEFAULT '',
    avatar_color  TEXT    NOT NULL DEFAULT '#C41230',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    team    TEXT    NOT NULL,
    UNIQUE(user_id, team)
  );

  CREATE TABLE IF NOT EXISTS holidays (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    start_date   TEXT    NOT NULL,
    end_date     TEXT    NOT NULL,
    type         TEXT    NOT NULL DEFAULT 'annual',
    notes        TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL DEFAULT 'pending',
    half_day     TEXT    DEFAULT NULL,
    requested_at TEXT    NOT NULL DEFAULT (datetime('now')),
    reviewed_at  TEXT,
    reviewed_by  INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS quotas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id),
    total_days INTEGER NOT NULL DEFAULT 25
  );
`);

// Migrate any existing department strings → team_members rows
db.prepare(`
  INSERT OR IGNORE INTO team_members (user_id, team)
  SELECT id, department FROM users WHERE department != ''
`).run();

// Migrate: add half_day column if it doesn't exist yet
try { db.exec(`ALTER TABLE holidays ADD COLUMN half_day TEXT DEFAULT NULL`); } catch (_) {}

// Migrate: add job_title column if it doesn't exist yet
try { db.exec(`ALTER TABLE users ADD COLUMN job_title TEXT NOT NULL DEFAULT ''`); } catch (_) {}


// Seed default admin on first run
const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('Admin123!', 10);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO users (name, email, password_hash, role, avatar_color) VALUES (?,?,?,'admin','#C41230')`
  ).run('Admin', 'admin@company.com', hash);
  db.prepare('INSERT INTO quotas (user_id, total_days) VALUES (?,25)').run(lastInsertRowid);
}

// ─── Team Helpers ─────────────────────────────────────────────────────────────

function getUserTeams(userId) {
  return db.prepare('SELECT team FROM team_members WHERE user_id = ? ORDER BY team').all(userId).map(r => r.team);
}

function getManagedUserIds(managerId) {
  const teams = getUserTeams(managerId);
  if (teams.length === 0) return [];
  const ph = teams.map(() => '?').join(',');
  return db.prepare(`SELECT DISTINCT user_id FROM team_members WHERE team IN (${ph})`).all(...teams).map(r => r.user_id);
}

function setUserTeams(userId, teams) {
  db.prepare('DELETE FROM team_members WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT OR IGNORE INTO team_members (user_id, team) VALUES (?, ?)');
  for (const t of teams) {
    const name = (t || '').trim();
    if (name) insert.run(userId, name);
  }
}

// ─── Quota/Days Helpers ───────────────────────────────────────────────────────

function getUsedDays(userId) {
  return db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN half_day IS NOT NULL
        THEN workdays(start_date, end_date) * 0.5
        ELSE workdays(start_date, end_date)
      END
    ), 0) AS days
    FROM holidays
    WHERE user_id = ?
      AND status = 'approved'
      AND CAST(strftime('%Y', start_date) AS INTEGER) = CAST(strftime('%Y','now') AS INTEGER)
  `).get(userId).days;
}

function enrichUser(u) {
  const quota    = db.prepare('SELECT total_days FROM quotas WHERE user_id = ?').get(u.id);
  const usedDays = getUsedDays(u.id);
  const teams    = getUserTeams(u.id);
  return { ...u, teams, total_days: quota?.total_days ?? 0, used_days: usedDays };
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(h.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOrManager(req, res, next) {
  if (!['admin', 'manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Check whether req.user may act on holidayUserId (approve/reject/view)
function canManageUser(reqUser, targetUserId) {
  if (reqUser.role === 'admin') return true;
  if (reqUser.role === 'manager') {
    // Managers cannot manage admins
    const target = db.prepare('SELECT role FROM users WHERE id=?').get(targetUserId);
    if (target && target.role === 'admin') return false;
    return getManagedUserIds(reqUser.id).includes(targetUserId);
  }
  return false;
}

// Check whether req.user may edit a user's holiday allowance/quota
// Managers cannot edit their own or any other manager's/admin's quota
function canEditQuota(reqUser, targetUserId) {
  if (reqUser.role === 'admin') return true;
  if (reqUser.role === 'manager') {
    const target = db.prepare('SELECT role FROM users WHERE id=?').get(targetUserId);
    if (target && (target.role === 'manager' || target.role === 'admin')) return false;
    return getManagedUserIds(reqUser.id).includes(targetUserId);
  }
  return false;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  const { password_hash, ...safe } = user;
  res.json({ token, user: { ...safe, teams: getUserTeams(user.id) } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare(
    'SELECT id, name, email, role, department, job_title, avatar_color, created_at FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const quota    = db.prepare('SELECT total_days FROM quotas WHERE user_id = ?').get(req.user.id);
  const usedDays = getUsedDays(req.user.id);
  const teams    = getUserTeams(req.user.id);

  let pendingCount = 0;
  if (req.user.role === 'admin') {
    pendingCount = db.prepare("SELECT COUNT(*) AS n FROM holidays WHERE status='pending'").get().n;
  } else if (req.user.role === 'manager') {
    const ids = getManagedUserIds(req.user.id);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      pendingCount = db.prepare(`SELECT COUNT(*) AS n FROM holidays WHERE status='pending' AND user_id IN (${ph})`).get(...ids).n;
    }
  }

  res.json({ ...user, teams, quota: quota || { total_days: 0 }, usedDays, pendingCount });
});

// ─── Users ────────────────────────────────────────────────────────────────────

app.get('/api/users', auth, adminOrManager, (req, res) => {
  let users = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.department, u.job_title, u.avatar_color, u.created_at,
           COALESCE(q.total_days, 0) AS total_days
    FROM users u
    LEFT JOIN quotas q ON q.user_id = u.id
    ORDER BY u.name
  `).all();

  // For managers: only return users in their teams, never admins
  if (req.user.role === 'manager') {
    const ids = getManagedUserIds(req.user.id);
    users = users.filter(u => (ids.includes(u.id) || u.id === req.user.id) && u.role !== 'admin');
  }

  res.json(users.map(u => ({ ...u, teams: getUserTeams(u.id), used_days: getUsedDays(u.id) })));
});

app.post('/api/users', auth, adminOrManager, (req, res) => {
  const { name, email, password, role = 'employee', department = '', job_title = '', total_days = 25, teams = [] } = req.body || {};
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password are required' });

  const COLORS = ['#C41230','#1D4ED8','#059669','#D97706','#7C3AED','#DB2777','#0891B2','#65A30D','#EA580C','#0F766E'];
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];

  try {
    const hash = bcrypt.hashSync(password, 10);
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (name,email,password_hash,role,department,job_title,avatar_color) VALUES (?,?,?,?,?,?,?)'
    ).run(name, email.toLowerCase().trim(), hash, role, department, job_title, color);

    db.prepare('INSERT INTO quotas (user_id,total_days) VALUES (?,?)').run(lastInsertRowid, total_days);
    setUserTeams(lastInsertRowid, teams);

    const user = db.prepare('SELECT id,name,email,role,department,job_title,avatar_color FROM users WHERE id=?').get(lastInsertRowid);
    res.status(201).json({ ...user, teams: getUserTeams(lastInsertRowid), total_days, used_days: 0 });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Email already in use' });
    throw e;
  }
});

app.patch('/api/users/:id', auth, adminOrManager, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, email, role, department, job_title, password, avatar_color, total_days, teams } = req.body || {};

  // Managers can only edit their own team members
  if (req.user.role === 'manager' && id !== req.user.id && !canManageUser(req.user, id))
    return res.status(403).json({ error: 'Forbidden' });

  const user = db.prepare('SELECT id,name,email,role,department,job_title,avatar_color FROM users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Only admins can edit a manager's or admin's quota
  if (total_days !== undefined && !canEditQuota(req.user, id))
    return res.status(403).json({ error: 'Only admins can edit this user\'s allowance' });

  if (password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), id);

  db.prepare('UPDATE users SET name=?,email=?,role=?,department=?,job_title=?,avatar_color=? WHERE id=?').run(
    name ?? user.name,
    email ? email.toLowerCase().trim() : user.email,
    role ?? user.role,
    department ?? user.department,
    job_title ?? user.job_title,
    avatar_color ?? user.avatar_color,
    id
  );

  if (total_days !== undefined) {
    db.prepare(
      'INSERT INTO quotas (user_id,total_days) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET total_days=excluded.total_days'
    ).run(id, total_days);
  }

  if (Array.isArray(teams)) setUserTeams(id, teams);

  const updated = db.prepare('SELECT id,name,email,role,department,job_title,avatar_color FROM users WHERE id=?').get(id);
  const quota   = db.prepare('SELECT total_days FROM quotas WHERE user_id=?').get(id);
  res.json({ ...updated, teams: getUserTeams(id), total_days: quota?.total_days ?? 0, used_days: getUsedDays(id) });
});

app.delete('/api/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can remove staff' });
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.prepare('DELETE FROM team_members WHERE user_id=?').run(id);
  db.prepare('DELETE FROM holidays WHERE user_id=?').run(id);
  db.prepare('DELETE FROM quotas WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ success: true });
});

// ─── User Holiday Profile ─────────────────────────────────────────────────────

app.get('/api/users/:id/profile', auth, adminOrManager, (req, res) => {
  const targetId = parseInt(req.params.id);

  if (!canManageUser(req.user, targetId))
    return res.status(403).json({ error: 'You can only view members of your teams' });

  const user     = db.prepare('SELECT id,name,email,role,department,job_title,avatar_color,created_at FROM users WHERE id=?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const holidays = db.prepare(`
    SELECT h.*, u.name AS user_name, u.avatar_color,
           rv.name AS reviewed_by_name
    FROM holidays h
    JOIN users u ON u.id = h.user_id
    LEFT JOIN users rv ON rv.id = h.reviewed_by
    WHERE h.user_id = ?
    ORDER BY h.start_date DESC
  `).all(targetId);

  res.json({ user: enrichUser(user), holidays });
});

// ─── Holidays ─────────────────────────────────────────────────────────────────

app.get('/api/holidays', auth, (req, res) => {
  const { userId, status } = req.query;
  const isAdmin = req.user.role === 'admin';

  let q = `SELECT h.*, u.name AS user_name, u.avatar_color, u.department,
           rv.name AS reviewed_by_name,
           (SELECT GROUP_CONCAT(tm.team,'|||') FROM team_members tm WHERE tm.user_id=h.user_id) AS user_teams_raw
           FROM holidays h
           JOIN users u ON u.id = h.user_id
           LEFT JOIN users rv ON rv.id = h.reviewed_by
           WHERE 1=1`;
  const p = [];

  if (!['admin', 'manager'].includes(req.user.role)) {
    // Employees see only their own
    q += ' AND h.user_id=?'; p.push(req.user.id);
  } else if (req.user.role === 'manager') {
    // Managers see only their team members
    const ids = getManagedUserIds(req.user.id);
    if (ids.length === 0) return res.json([]);
    const ph = ids.map(() => '?').join(',');
    q += ` AND h.user_id IN (${ph})`; p.push(...ids);
    if (userId) { q += ' AND h.user_id=?'; p.push(parseInt(userId)); }
  } else if (userId) {
    // Admin filtering by specific user
    q += ' AND h.user_id=?'; p.push(parseInt(userId));
  }

  if (status) { q += ' AND h.status=?'; p.push(status); }
  q += ' ORDER BY h.start_date DESC';
  const rows = db.prepare(q).all(...p).map(row => ({
    ...row,
    user_teams: (row.user_teams_raw || '').split('|||').filter(Boolean)
  }));
  res.json(rows);
});

app.get('/api/holidays/team', auth, (req, res) => {
  const { year, month, team, date } = req.query;
  let q = `SELECT h.*, u.name AS user_name, u.avatar_color, u.department,
           (SELECT GROUP_CONCAT(tm.team, '|||') FROM team_members tm WHERE tm.user_id = h.user_id) AS user_teams_raw,
           rv.name AS reviewed_by_name
           FROM holidays h
           JOIN users u ON u.id = h.user_id
           LEFT JOIN users rv ON rv.id = h.reviewed_by
           WHERE h.status='approved'`;
  const p = [];

  // Managers only see their team
  if (req.user.role === 'manager') {
    const ids = getManagedUserIds(req.user.id);
    if (ids.length === 0) return res.json([]);
    const ph = ids.map(() => '?').join(',');
    q += ` AND h.user_id IN (${ph})`; p.push(...ids);
  }

  if (team) {
    q += ' AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id=h.user_id AND tm.team=?)';
    p.push(team);
  }

  if (year && month) {
    const y = parseInt(year), m = parseInt(month);
    const first = `${y}-${String(m).padStart(2,'0')}-01`;
    const last  = new Date(y, m, 0).toISOString().split('T')[0];
    q += ' AND h.start_date<=? AND h.end_date>=?'; p.push(last, first);
  }

  if (date) {
    q += ' AND h.start_date<=? AND h.end_date>=?'; p.push(date, date);
  }

  q += ' ORDER BY u.name';
  const rows = db.prepare(q).all(...p).map(row => ({
    ...row,
    user_teams: (row.user_teams_raw || '').split('|||').filter(Boolean)
  }));
  res.json(rows);
});

app.post('/api/holidays', auth, (req, res) => {
  const { start_date, end_date, type = 'annual', notes = '', on_behalf_of, half_day = null } = req.body || {};
  if (!start_date || !end_date) return res.status(400).json({ error: 'Start and end date required' });
  if (start_date > end_date)    return res.status(400).json({ error: 'Start must be before or equal to end date' });
  if (half_day && !['AM', 'PM'].includes(half_day)) return res.status(400).json({ error: 'half_day must be AM or PM' });
  if (half_day && start_date !== end_date) return res.status(400).json({ error: 'Half-day bookings must be a single day' });

  // Allow admin/manager to book on behalf of another user
  let targetUserId = req.user.id;
  if (on_behalf_of && parseInt(on_behalf_of) !== req.user.id) {
    if (!['admin', 'manager'].includes(req.user.role))
      return res.status(403).json({ error: 'Forbidden' });
    const targetId = parseInt(on_behalf_of);
    if (req.user.role === 'manager' && !canManageUser(req.user, targetId))
      return res.status(403).json({ error: 'You can only manage holidays for your team members' });
    targetUserId = targetId;
  }

  const overlap = db.prepare(`
    SELECT id FROM holidays WHERE user_id=? AND status!='rejected'
    AND start_date<=? AND end_date>=?
  `).get(targetUserId, end_date, start_date);
  if (overlap) return res.status(409).json({ error: 'Dates overlap with an existing request' });

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO holidays (user_id,start_date,end_date,type,notes,half_day) VALUES (?,?,?,?,?,?)'
  ).run(targetUserId, start_date, end_date, type, notes, half_day || null);

  const h = db.prepare(
    'SELECT h.*,u.name AS user_name,u.avatar_color FROM holidays h JOIN users u ON u.id=h.user_id WHERE h.id=?'
  ).get(lastInsertRowid);
  res.status(201).json(h);
});

app.patch('/api/holidays/:id/status', auth, adminOrManager, (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected'].includes(status))
    return res.status(400).json({ error: 'Status must be approved or rejected' });

  const id = parseInt(req.params.id);
  const h  = db.prepare('SELECT * FROM holidays WHERE id=?').get(id);
  if (!h) return res.status(404).json({ error: 'Not found' });

  if (!canManageUser(req.user, h.user_id))
    return res.status(403).json({ error: 'You can only manage holidays for your team members' });

  db.prepare(`UPDATE holidays SET status=?, reviewed_at=datetime('now'), reviewed_by=? WHERE id=?`)
    .run(status, req.user.id, id);

  const updated = db.prepare(`
    SELECT h.*, u.name AS user_name, u.avatar_color, u.department,
           rv.name AS reviewed_by_name,
           (SELECT GROUP_CONCAT(tm.team,'|||') FROM team_members tm WHERE tm.user_id=h.user_id) AS user_teams_raw
    FROM holidays h
    JOIN users u ON u.id = h.user_id
    LEFT JOIN users rv ON rv.id = h.reviewed_by
    WHERE h.id=?
  `).get(id);
  res.json({ ...updated, user_teams: (updated.user_teams_raw || '').split('|||').filter(Boolean) });
});

app.delete('/api/holidays/:id', auth, (req, res) => {
  const id = parseInt(req.params.id);
  const h  = db.prepare('SELECT * FROM holidays WHERE id=?').get(id);
  if (!h) return res.status(404).json({ error: 'Not found' });

  const isOwner = h.user_id === req.user.id;
  const isPriv  = ['admin', 'manager'].includes(req.user.role);

  if (!isOwner && !isPriv) return res.status(403).json({ error: 'Forbidden' });
  if (!isOwner && isPriv && !canManageUser(req.user, h.user_id)) return res.status(403).json({ error: 'Forbidden' });
  if (isOwner && !isPriv && h.status !== 'pending')
    return res.status(400).json({ error: 'Only pending requests can be cancelled' });

  db.prepare('DELETE FROM holidays WHERE id=?').run(id);
  res.json({ success: true });
});

// ─── Quotas ───────────────────────────────────────────────────────────────────

app.put('/api/quotas/:userId', auth, adminOrManager, (req, res) => {
  const { total_days } = req.body || {};
  const userId = parseInt(req.params.userId);
  if (!canEditQuota(req.user, userId)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(
    'INSERT INTO quotas (user_id,total_days) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET total_days=excluded.total_days'
  ).run(userId, total_days);
  res.json({ user_id: userId, total_days });
});

// ─── Teams ────────────────────────────────────────────────────────────────────

app.get('/api/teams', auth, (req, res) => {
  let teams;
  if (req.user.role === 'admin') {
    teams = db.prepare('SELECT DISTINCT team FROM team_members ORDER BY team').all().map(r => r.team);
  } else {
    // Managers and employees only see their own teams
    teams = getUserTeams(req.user.id);
  }
  res.json(teams);
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  ✦  Holiday Tracker  →  http://localhost:${PORT}`);
    console.log(`     Default admin: admin@company.com  /  Admin123!\n`);
  });
}

module.exports = { app, db };
