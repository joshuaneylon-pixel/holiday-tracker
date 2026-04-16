const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ht-secret-change-in-production';

// ─── Email ────────────────────────────────────────────────────────────────────

let _mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  try {
    const nodemailer = require('nodemailer');
    _mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    console.log('  ✦  Email notifications enabled');
  } catch (e) { console.warn('[email] nodemailer unavailable:', e.message); }
}

function sendEmail(to, subject, html) {
  if (!_mailer || !to) return;
  _mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, html })
    .catch(err => console.error('[email] Failed to send:', err.message));
}

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

  CREATE TABLE IF NOT EXISTS public_holidays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    date       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    message    TEXT    NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS teams (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                        TEXT    NOT NULL UNIQUE,
    manager_id                  INTEGER REFERENCES users(id),
    admin_id                    INTEGER REFERENCES users(id),
    requires_secondary_approval INTEGER NOT NULL DEFAULT 0
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

// Migrate: add carry_allowed, base_days, last_reset_year to quotas
try { db.exec(`ALTER TABLE quotas ADD COLUMN carry_allowed INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE quotas ADD COLUMN base_days INTEGER NOT NULL DEFAULT 25`); } catch (_) {}
try { db.exec(`ALTER TABLE quotas ADD COLUMN last_reset_year INTEGER DEFAULT NULL`); } catch (_) {}
// Sync base_days to match total_days for any rows where they differ (new column defaulted to 25)
db.prepare(`UPDATE quotas SET base_days = total_days WHERE base_days != total_days`).run();
// Mark existing rows as already reset this year so the first deploy doesn't trigger a reset
db.prepare(`UPDATE quotas SET last_reset_year = ? WHERE last_reset_year IS NULL`).run(new Date().getFullYear());

// Migrate: add manager_approved_by/at columns to holidays
try { db.exec(`ALTER TABLE holidays ADD COLUMN manager_approved_by INTEGER REFERENCES users(id)`); } catch (_) {}
try { db.exec(`ALTER TABLE holidays ADD COLUMN manager_approved_at TEXT`); } catch (_) {}

// Migrate: add rejection_reason column to holidays
try { db.exec(`ALTER TABLE holidays ADD COLUMN rejection_reason TEXT DEFAULT NULL`); } catch (_) {}

// Migrate: populate teams table from distinct team_members entries
{
  const distinctTeams = db.prepare(`SELECT DISTINCT team FROM team_members`).all();
  for (const { team } of distinctTeams) {
    db.prepare(`INSERT OR IGNORE INTO teams (name) VALUES (?)`).run(team);
    const mgr = db.prepare(`
      SELECT u.id FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      WHERE tm.team = ? AND u.role = 'manager' LIMIT 1
    `).get(team);
    if (mgr) db.prepare(`UPDATE teams SET manager_id = ? WHERE name = ? AND manager_id IS NULL`).run(mgr.id, team);
  }
}


// Seed default admin on first run
const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('Admin123!', 10);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO users (name, email, password_hash, role, avatar_color) VALUES (?,?,?,'admin','#C41230')`
  ).run('Admin', 'admin@company.com', hash);
  db.prepare('INSERT INTO quotas (user_id, total_days, base_days, last_reset_year) VALUES (?,25,25,?)').run(lastInsertRowid, new Date().getFullYear());
}

performAnnualReset();

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

function holidayRequiresSecondary(holidayUserId) {
  const rows = db.prepare(`
    SELECT t.requires_secondary_approval
    FROM teams t
    JOIN team_members tm ON tm.team = t.name
    WHERE tm.user_id = ?
  `).all(holidayUserId);
  return rows.some(r => r.requires_secondary_approval);
}

// ─── Quota/Days Helpers ───────────────────────────────────────────────────────

function countPublicHolidayOverlap(startDate, endDate) {
  const rows = db.prepare(
    `SELECT date FROM public_holidays WHERE date >= ? AND date <= ?`
  ).all(startDate, endDate);
  return rows.filter(r => {
    const dow = new Date(r.date + 'T00:00:00').getDay();
    return dow !== 0 && dow !== 6;
  }).length;
}

function getUsedDaysForYear(userId, year) {
  const rows = db.prepare(`
    SELECT start_date, end_date, half_day FROM holidays
    WHERE user_id = ? AND status = 'approved'
      AND CAST(strftime('%Y', start_date) AS INTEGER) = ?
  `).all(userId, year);
  return rows.reduce((sum, h) => {
    const raw = db.prepare('SELECT workdays(?,?) AS w').get(h.start_date, h.end_date).w;
    const phOverlap = countPublicHolidayOverlap(h.start_date, h.end_date);
    const deductible = Math.max(0, raw - phOverlap);
    return sum + (h.half_day ? deductible * 0.5 : deductible);
  }, 0);
}

function getUsedDays(userId) {
  return getUsedDaysForYear(userId, new Date().getFullYear());
}

function enrichUser(u) {
  const quota    = db.prepare('SELECT total_days, base_days, carry_allowed FROM quotas WHERE user_id = ?').get(u.id);
  const usedDays = getUsedDays(u.id);
  const teams    = getUserTeams(u.id);
  return { ...u, teams, total_days: quota?.total_days ?? 0, base_days: quota?.base_days ?? 0, carry_allowed: quota?.carry_allowed ?? 0, used_days: usedDays };
}

function performAnnualReset() {
  const currentYear = new Date().getFullYear();
  const prevYear    = currentYear - 1;

  const quotas = db.prepare(
    'SELECT user_id, total_days, base_days, carry_allowed FROM quotas WHERE last_reset_year IS NULL OR last_reset_year < ?'
  ).all(currentYear);

  if (quotas.length === 0) return;

  const updateStmt = db.prepare(
    'UPDATE quotas SET total_days = ?, last_reset_year = ? WHERE user_id = ?'
  );

  db.transaction(() => {
    for (const q of quotas) {
      let newTotal = q.base_days;
      if (q.carry_allowed) {
        const prevUsed  = getUsedDaysForYear(q.user_id, prevYear);
        const remaining = Math.max(0, q.total_days - prevUsed);
        newTotal = q.base_days + remaining;
      }
      updateStmt.run(newTotal, currentYear, q.user_id);
    }
  })();

  console.log(`  ✦  Annual reset applied for ${quotas.length} user(s) (year ${currentYear})`);
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

  const quota    = db.prepare('SELECT total_days, base_days, carry_allowed FROM quotas WHERE user_id = ?').get(req.user.id);
  const usedDays = getUsedDays(req.user.id);
  const teams    = getUserTeams(req.user.id);

  let pendingCount = 0;
  let offTodayCount = null; // extra stat for managers/admins
  const today = new Date().toISOString().split('T')[0];

  if (req.user.role === 'admin') {
    pendingCount = db.prepare("SELECT COUNT(*) AS n FROM holidays WHERE status='pending'").get().n;
    offTodayCount = db.prepare(
      "SELECT COUNT(*) AS n FROM holidays WHERE status='approved' AND start_date<=? AND end_date>=?"
    ).get(today, today).n;
  } else if (req.user.role === 'manager') {
    const ids = getManagedUserIds(req.user.id);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      pendingCount = db.prepare(`SELECT COUNT(*) AS n FROM holidays WHERE status='pending' AND user_id IN (${ph})`).get(...ids).n;
      offTodayCount = db.prepare(`SELECT COUNT(*) AS n FROM holidays WHERE status='approved' AND start_date<=? AND end_date>=? AND user_id IN (${ph})`).get(today, today, ...ids).n;
    }
  }

  res.json({ ...user, teams, quota: quota || { total_days: 0 }, usedDays, pendingCount, offTodayCount });
});

// ─── Users ────────────────────────────────────────────────────────────────────

app.get('/api/users', auth, adminOrManager, (req, res) => {
  let users = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.department, u.job_title, u.avatar_color, u.created_at,
           COALESCE(q.total_days, 0) AS total_days,
           COALESCE(q.carry_allowed, 0) AS carry_allowed
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

app.post('/api/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can add staff' });
  const { name, email, password, role = 'employee', department = '', job_title = '', total_days = 25, carry_allowed = 0, teams = [] } = req.body || {};
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password are required' });

  const COLORS = ['#C41230','#1D4ED8','#059669','#D97706','#7C3AED','#DB2777','#0891B2','#65A30D','#EA580C','#0F766E'];
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];

  try {
    const hash = bcrypt.hashSync(password, 10);
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (name,email,password_hash,role,department,job_title,avatar_color) VALUES (?,?,?,?,?,?,?)'
    ).run(name, email.toLowerCase().trim(), hash, role, department, job_title, color);

    db.prepare('INSERT INTO quotas (user_id,total_days,base_days,carry_allowed,last_reset_year) VALUES (?,?,?,?,?)').run(lastInsertRowid, total_days, total_days, carry_allowed ? 1 : 0, new Date().getFullYear());
    setUserTeams(lastInsertRowid, teams);

    const user = db.prepare('SELECT id,name,email,role,department,job_title,avatar_color FROM users WHERE id=?').get(lastInsertRowid);
    res.status(201).json({ ...user, teams: getUserTeams(lastInsertRowid), total_days, base_days: total_days, carry_allowed: carry_allowed ? 1 : 0, used_days: 0 });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Email already in use' });
    throw e;
  }
});

app.patch('/api/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can edit staff' });
  const id = parseInt(req.params.id);
  const { name, email, role, department, job_title, password, avatar_color, total_days, carry_allowed, teams } = req.body || {};

  const user = db.prepare('SELECT id,name,email,role,department,job_title,avatar_color FROM users WHERE id=?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Only admins can edit a manager's or admin's quota
  if (total_days !== undefined && !canEditQuota(req.user, id))
    return res.status(403).json({ error: 'Only admins can edit this user\'s allowance' });

  // Only admins can change roles
  if (role !== undefined && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Only admins can change roles' });

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

  if (total_days !== undefined || carry_allowed !== undefined) {
    const existing = db.prepare('SELECT total_days, base_days, carry_allowed FROM quotas WHERE user_id = ?').get(id)
                     || { total_days: 25, base_days: 25, carry_allowed: 0 };
    const newTotal = total_days !== undefined ? total_days : existing.total_days;
    const newBase  = total_days !== undefined ? total_days : existing.base_days;
    const newCarry = carry_allowed !== undefined ? (carry_allowed ? 1 : 0) : existing.carry_allowed;
    db.prepare(
      'INSERT INTO quotas (user_id,total_days,base_days,carry_allowed) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET total_days=excluded.total_days, base_days=excluded.base_days, carry_allowed=excluded.carry_allowed'
    ).run(id, newTotal, newBase, newCarry);
  }

  if (Array.isArray(teams)) setUserTeams(id, teams);

  const updated = db.prepare('SELECT id,name,email,role,department,job_title,avatar_color FROM users WHERE id=?').get(id);
  const quota   = db.prepare('SELECT total_days, base_days, carry_allowed FROM quotas WHERE user_id=?').get(id);
  res.json({ ...updated, teams: getUserTeams(id), total_days: quota?.total_days ?? 0, base_days: quota?.base_days ?? 0, carry_allowed: quota?.carry_allowed ?? 0, used_days: getUsedDays(id) });
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
           rv.name AS reviewed_by_name,
           mv.name AS manager_approved_by_name,
           workdays(h.start_date, h.end_date) AS days
    FROM holidays h
    JOIN users u ON u.id = h.user_id
    LEFT JOIN users rv ON rv.id = h.reviewed_by
    LEFT JOIN users mv ON mv.id = h.manager_approved_by
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
           mv.name AS manager_approved_by_name,
           (SELECT GROUP_CONCAT(tm.team,'|||') FROM team_members tm WHERE tm.user_id=h.user_id) AS user_teams_raw
           FROM holidays h
           JOIN users u ON u.id = h.user_id
           LEFT JOIN users rv ON rv.id = h.reviewed_by
           LEFT JOIN users mv ON mv.id = h.manager_approved_by
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
  } else if (req.query.start_date && req.query.end_date) {
    q += ' AND h.start_date<=? AND h.end_date>=?'; p.push(req.query.end_date, req.query.start_date);
  }

  q += ' ORDER BY u.name';
  const rows = db.prepare(q).all(...p).map(row => ({
    ...row,
    user_teams: (row.user_teams_raw || '').split('|||').filter(Boolean)
  }));

  // Append public holiday pseudo-events for the same date range
  let phQuery = 'SELECT * FROM public_holidays WHERE 1=1';
  const phParams = [];
  if (date) {
    phQuery += ' AND date = ?'; phParams.push(date);
  } else if (req.query.start_date && req.query.end_date) {
    phQuery += ' AND date >= ? AND date <= ?'; phParams.push(req.query.start_date, req.query.end_date);
  } else if (year && month) {
    const y = parseInt(year), m = parseInt(month);
    const first = `${y}-${String(m).padStart(2,'0')}-01`;
    const last  = new Date(y, m, 0).toISOString().split('T')[0];
    phQuery += ' AND date >= ? AND date <= ?'; phParams.push(first, last);
  }
  const publicHols = db.prepare(phQuery).all(...phParams);
  const phRows = publicHols.map(ph => ({
    id: `ph-${ph.id}`,
    user_id: null,
    user_name: ph.name,
    avatar_color: '#059669',
    start_date: ph.date,
    end_date: ph.date,
    type: 'public_holiday',
    status: 'approved',
    half_day: null,
    notes: 'Public holiday',
    user_teams: [],
    is_public_holiday: true,
  }));

  res.json([...rows, ...phRows]);
});

app.get('/api/holidays/export/ics', auth, (req, res) => {
  const userId = (req.user.role === 'admin' && req.query.userId)
    ? parseInt(req.query.userId)
    : req.user.id;

  const holidays = db.prepare(
    `SELECT * FROM holidays WHERE user_id = ? AND status = 'approved' ORDER BY start_date`
  ).all(userId);

  const typeLabels = { annual: 'Annual Leave', unpaid: 'Unpaid Leave', other: 'Other' };
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15) + 'Z';

  const events = holidays.map(h => {
    const label = (typeLabels[h.type] || h.type) + (h.half_day ? ` (${h.half_day})` : '');
    const [ey, em, ed] = h.end_date.split('-').map(Number);
    const next = new Date(Date.UTC(ey, em - 1, ed + 1));
    const dtend = `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, '0')}${String(next.getUTCDate()).padStart(2, '0')}`;
    const dtstart = h.start_date.replace(/-/g, '');
    const lines = [
      'BEGIN:VEVENT',
      `UID:ht-${h.id}@holiday-tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dtstart}`,
      `DTEND;VALUE=DATE:${dtend}`,
      `SUMMARY:${label}`,
    ];
    if (h.notes) lines.push(`DESCRIPTION:${h.notes.replace(/[\\,;]/g, s => '\\' + s).replace(/\r?\n/g, '\\n')}`);
    lines.push('END:VEVENT');
    return lines.join('\r\n');
  });

  const cal = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Holiday Tracker//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="holidays.ics"');
  res.send(cal);
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

  const rawDays = db.prepare('SELECT workdays(?,?) AS w').get(start_date, end_date).w;
  const phOverlap = countPublicHolidayOverlap(start_date, end_date);
  if (Math.max(0, rawDays - phOverlap) === 0 && rawDays > 0) {
    return res.status(400).json({ error: 'Your selected dates consist entirely of public holidays. No leave days would be deducted.' });
  }

  const { lastInsertRowid } = db.prepare(
    'INSERT INTO holidays (user_id,start_date,end_date,type,notes,half_day) VALUES (?,?,?,?,?,?)'
  ).run(targetUserId, start_date, end_date, type, notes, half_day || null);

  const h = db.prepare(
    'SELECT h.*,u.name AS user_name,u.avatar_color FROM holidays h JOIN users u ON u.id=h.user_id WHERE h.id=?'
  ).get(lastInsertRowid);

  // Notify approvers of the new request (fire-and-forget)
  if (_mailer) {
    const requesterName = h.user_name || 'An employee';
    const typeLabel = { annual: 'Annual Leave', unpaid: 'Unpaid Leave', other: 'Other' }[type] || type;
    const admins = db.prepare("SELECT email FROM users WHERE role='admin'").all().map(r => r.email);
    const mgrTeams = getUserTeams(targetUserId);
    const mgrEmails = mgrTeams.length
      ? db.prepare(`SELECT DISTINCT u.email FROM users u JOIN team_members tm ON tm.user_id=u.id WHERE tm.team IN (${mgrTeams.map(() => '?').join(',')}) AND u.role='manager'`).all(...mgrTeams).map(r => r.email)
      : [];
    const recipients = [...new Set([...admins, ...mgrEmails])].join(',');
    sendEmail(
      recipients,
      `New holiday request from ${requesterName}`,
      `<p><strong>${requesterName}</strong> has requested <strong>${typeLabel}</strong> from <strong>${start_date}</strong> to <strong>${end_date}</strong>.</p><p>Please log in to review and approve or reject the request.</p>`
    );
  }

  res.status(201).json(h);
});

app.patch('/api/holidays/:id/status', auth, adminOrManager, (req, res) => {
  const { status, rejection_reason } = req.body || {};
  if (!['approved', 'rejected'].includes(status))
    return res.status(400).json({ error: 'Status must be approved or rejected' });

  const id = parseInt(req.params.id);
  const h  = db.prepare('SELECT * FROM holidays WHERE id=?').get(id);
  if (!h) return res.status(404).json({ error: 'Not found' });

  if (!canManageUser(req.user, h.user_id))
    return res.status(403).json({ error: 'You can only manage holidays for your team members' });

  // Managers cannot finalise a request already awaiting admin secondary approval
  if (h.status === 'manager_approved' && req.user.role === 'manager')
    return res.status(403).json({ error: 'This request is awaiting admin approval' });

  let storedStatus = status;
  if (status === 'approved' && req.user.role === 'manager' && holidayRequiresSecondary(h.user_id)) {
    // Intermediate approval — route to admin secondary queue
    db.prepare(`
      UPDATE holidays
      SET status='manager_approved',
          manager_approved_by=?,
          manager_approved_at=datetime('now')
      WHERE id=?
    `).run(req.user.id, id);
    storedStatus = 'manager_approved';
  } else {
    // Final approval or rejection
    db.prepare(`UPDATE holidays SET status=?, reviewed_at=datetime('now'), reviewed_by=?, rejection_reason=? WHERE id=?`)
      .run(status, req.user.id, status === 'rejected' ? (rejection_reason || null) : null, id);
  }

  const updated = db.prepare(`
    SELECT h.*, u.name AS user_name, u.avatar_color, u.department,
           u.email AS user_email,
           rv.name  AS reviewed_by_name,
           mv.name  AS manager_approved_by_name,
           (SELECT GROUP_CONCAT(tm.team,'|||') FROM team_members tm WHERE tm.user_id=h.user_id) AS user_teams_raw
    FROM holidays h
    JOIN users u ON u.id = h.user_id
    LEFT JOIN users rv ON rv.id = h.reviewed_by
    LEFT JOIN users mv ON mv.id = h.manager_approved_by
    WHERE h.id=?
  `).get(id);

  // Notify the employee of the decision (fire-and-forget)
  if (_mailer && updated.user_email) {
    const typeLabel = { annual: 'Annual Leave', unpaid: 'Unpaid Leave', other: 'Other' }[updated.type] || updated.type;
    let subj, body;
    if (storedStatus === 'manager_approved') {
      subj = 'Holiday request: manager approved';
      body = `<p>Your <strong>${typeLabel}</strong> request (${updated.start_date} → ${updated.end_date}) has been approved by your manager and is now awaiting final admin approval.</p>`;
    } else if (storedStatus === 'approved') {
      subj = 'Holiday request approved';
      body = `<p>Your <strong>${typeLabel}</strong> request (${updated.start_date} → ${updated.end_date}) has been <strong style="color:#059669">approved</strong>. Enjoy your time off!</p>`;
    } else {
      subj = 'Holiday request rejected';
      body = `<p>Your <strong>${typeLabel}</strong> request (${updated.start_date} → ${updated.end_date}) has been <strong style="color:#C41230">rejected</strong>.</p>${updated.rejection_reason ? `<p>Reason: ${updated.rejection_reason}</p>` : ''}`;
    }
    sendEmail(updated.user_email, subj, body);
  }

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
  const { total_days, carry_allowed } = req.body || {};
  const userId = parseInt(req.params.userId);
  if (!canEditQuota(req.user, userId)) return res.status(403).json({ error: 'Forbidden' });
  if (carry_allowed !== undefined && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Only admins can change carry-over settings' });
  const existing = db.prepare('SELECT total_days, base_days, carry_allowed FROM quotas WHERE user_id = ?').get(userId)
                   || { total_days: 25, base_days: 25, carry_allowed: 0 };
  const newTotal = total_days !== undefined ? total_days : existing.total_days;
  const newBase  = total_days !== undefined ? total_days : existing.base_days;
  const newCarry = carry_allowed !== undefined ? (carry_allowed ? 1 : 0) : existing.carry_allowed;
  db.prepare(
    'INSERT INTO quotas (user_id,total_days,base_days,carry_allowed) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET total_days=excluded.total_days, base_days=excluded.base_days, carry_allowed=excluded.carry_allowed'
  ).run(userId, newTotal, newBase, newCarry);
  res.json({ user_id: userId, total_days: newTotal, base_days: newBase, carry_allowed: newCarry });
});

// ─── Public Holidays ──────────────────────────────────────────────────────────

app.get('/api/public-holidays', auth, (req, res) => {
  const { year } = req.query;
  let q = 'SELECT * FROM public_holidays';
  const p = [];
  if (year) { q += ' WHERE date LIKE ?'; p.push(`${year}-%`); }
  q += ' ORDER BY date ASC';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/public-holidays', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, date } = req.body || {};
  if (!name || !date) return res.status(400).json({ error: 'Name and date are required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
  try {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO public_holidays (name, date, created_by) VALUES (?,?,?)'
    ).run(name.trim(), date, req.user.id);
    res.status(201).json(db.prepare('SELECT * FROM public_holidays WHERE id=?').get(lastInsertRowid));
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'A public holiday already exists on that date' });
    throw e;
  }
});

app.delete('/api/public-holidays/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const id = parseInt(req.params.id);
  const ph = db.prepare('SELECT id FROM public_holidays WHERE id=?').get(id);
  if (!ph) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM public_holidays WHERE id=?').run(id);
  res.json({ success: true });
});

// ─── Announcements ────────────────────────────────────────────────────────────

app.get('/api/announcements', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.name AS author_name
    FROM announcements a
    JOIN users u ON u.id = a.created_by
    ORDER BY a.created_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/announcements', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { title, message } = req.body || {};
  if (!title || !message) return res.status(400).json({ error: 'title and message are required' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO announcements (title, message, created_by) VALUES (?,?,?)'
  ).run(title.trim(), message.trim(), req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM announcements WHERE id=?').get(lastInsertRowid));
});

app.delete('/api/announcements/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const info = db.prepare('DELETE FROM announcements WHERE id=?').run(parseInt(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ─── Teams Config ─────────────────────────────────────────────────────────────

app.get('/api/teams-config', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const rows = db.prepare(`
    SELECT t.*,
           mu.name AS manager_name,
           au.name AS admin_name
    FROM teams t
    LEFT JOIN users mu ON mu.id = t.manager_id
    LEFT JOIN users au ON au.id = t.admin_id
    ORDER BY t.name
  `).all();
  res.json(rows);
});

app.patch('/api/teams-config/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const id = parseInt(req.params.id);
  const team = db.prepare('SELECT id FROM teams WHERE id=?').get(id);
  if (!team) return res.status(404).json({ error: 'Not found' });

  const { manager_id, admin_id, requires_secondary_approval } = req.body || {};
  const fields = [];
  const vals   = [];
  if (manager_id !== undefined)                  { fields.push('manager_id=?');                  vals.push(manager_id || null); }
  if (admin_id !== undefined)                    { fields.push('admin_id=?');                    vals.push(admin_id || null); }
  if (requires_secondary_approval !== undefined) { fields.push('requires_secondary_approval=?'); vals.push(requires_secondary_approval ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

  vals.push(id);
  db.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id=?`).run(...vals);

  const updated = db.prepare(`
    SELECT t.*, mu.name AS manager_name, au.name AS admin_name
    FROM teams t
    LEFT JOIN users mu ON mu.id = t.manager_id
    LEFT JOIN users au ON au.id = t.admin_id
    WHERE t.id=?
  `).get(id);
  res.json(updated);
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

module.exports = { app, db, performAnnualReset };
