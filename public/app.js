// ─── Constants ────────────────────────────────────────────────────────────────

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

const TYPE_COLORS = { annual: '#C41230', unpaid: '#D97706', other: '#7C3AED' };
const TYPE_LABELS = { annual: 'Annual Leave', unpaid: 'Unpaid Leave', other: 'Other' };

// ─── State ────────────────────────────────────────────────────────────────────

const S = {
  user:  null,
  token: localStorage.getItem('ht_token') || null,
  view:  'dashboard',
  // Personal calendar
  myYear:  new Date().getFullYear(),
  myMonth: new Date().getMonth() + 1,
  // Team calendar
  teamYear:  new Date().getFullYear(),
  teamMonth: new Date().getMonth() + 1,
  // Requests tab
  reqTab: 'pending',
  reqTeamFilter: null,
  staffTeamFilter: null,
  // Team filter
  teamFilter: null,
  // Data cache
  myHolidays:      [],
  teamHolidays:    [],
  allHolidays:     [],
  allUsers:        [],
  allTeams:        [],
  publicHolidays:  [],
  announcements:   [],
  teamsConfig:     [],
  selectedUserId:  null,
  staffTab:        'staff',
  // Who's Off widget
  wioView:         'today',  // 'today' | 'week'
};

// ─── Modal / ephemeral state ──────────────────────────────────────────────────
let _modalTeams  = [];   // teams being toggled in the user edit modal
let _holBehalfOf = null; // userId to book a holiday on behalf of (null = self)
let _profileUser = null;      // enriched user data for the current profile view
let _profileHolidays = [];    // holidays for the current profile view

// ─── API ──────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (S.token) opts.headers['Authorization'] = `Bearer ${S.token}`;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`/api${path}`, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

async function loadPublicHolidays(year) {
  S.publicHolidays = await api('GET', `/public-holidays?year=${year}`);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function doLogin(email, password) {
  const { token, user } = await api('POST', '/auth/login', { email, password });
  S.token = token;
  S.user = user;
  localStorage.setItem('ht_token', token);
}

async function loadMe() {
  S.user = await api('GET', '/auth/me');
}

function logout() {
  S.token = null;
  S.user = null;
  localStorage.removeItem('ht_token');
  showLogin();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateShort(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtDateLong(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function countWorkdays(start, end, halfDay = null) {
  if (!start || !end || start > end) return 0;
  let count = 0;
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const endDate = new Date(ey, em - 1, ed);
  while (cur <= endDate) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return halfDay ? count * 0.5 : count;
}

function initials(name) {
  return (name || '').split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function statusLabel(h, role) {
  if (h.status === 'manager_approved') return role === 'employee' ? 'Pending' : 'Awaiting Admin';
  return cap(h.status);
}
function statusBadgeClass(h, role) {
  if (h.status === 'manager_approved' && role === 'employee') return 'badge-pending';
  return `badge-${h.status}`;
}

// Builds the "reviewed by" cell content showing both approvals when present.
function reviewedByCell(h) {
  const parts = [];
  if (h.manager_approved_by_name) {
    parts.push(`<span style="color:var(--text-2)">Mgr: ${escHtml(h.manager_approved_by_name)}</span><br><span style="color:var(--text-3)">${fmtDateShort(h.manager_approved_at?.split(' ')[0] || '')}</span>`);
  }
  if (h.reviewed_by_name) {
    const label = h.manager_approved_by_name ? 'Admin: ' : '';
    parts.push(`<span style="color:var(--text-2)">${label}${escHtml(h.reviewed_by_name)}</span><br><span style="color:var(--text-3)">${fmtDateShort(h.reviewed_at?.split(' ')[0] || '')}</span>`);
  }
  return parts.length ? parts.join('<br>') : '—';
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

function isPriv() { return S.user && ['admin', 'manager'].includes(S.user.role); }

function overlapsMonth(h, year, month) {
  const first = `${year}-${pad(month)}-01`;
  const last = new Date(year, month, 0).toISOString().split('T')[0];
  return h.start_date <= last && h.end_date >= first;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg, type = 'success') {
  const icons = { success: '✓', error: '✕', info: 'i' };
  const el = Object.assign(document.createElement('div'), { className: `toast ${type}` });
  el.innerHTML = `<span class="toast-icon">${icons[type] || '✓'}</span><span class="toast-msg">${escHtml(msg)}</span><button class="toast-dismiss" onclick="this.parentElement.remove()">✕</button>`;
  document.getElementById('toast-container').prepend(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 4000);
}

// ─── Login ────────────────────────────────────────────────────────────────────

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');

  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btn      = document.getElementById('login-btn');
    const errEl    = document.getElementById('login-error');

    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Signing in…`;

    try {
      await doLogin(email, password);
      await loadMe();
      showApp();
      navigate('dashboard');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  };

  document.getElementById('login-email').focus();
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  renderSidebar();
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function renderSidebar() {
  const u = S.user;
  if (!u) return;

  const pending = u.pendingCount || 0;
  const priv = isPriv();

  const items = [
    { id: 'dashboard',   label: 'Dashboard',      icon: iDashboard() },
    { id: 'my-holidays', label: 'My Holidays',     icon: iCalendar() },
    { id: 'team',        label: 'Team Calendar',   icon: iTeam() },
  ];

  if (priv) {
    items.push({ divider: 'Management' });
    items.push({ id: 'requests', label: 'Requests',     icon: iInbox(), badge: pending || null });
    items.push({ id: 'staff',    label: 'Manage Staff', icon: iUsers() });
    if (u.role === 'admin') {
      items.push({ action: 'openAnnouncementModal()', label: 'Post Announcement', icon: '<span style="font-size:15px;line-height:1">📢</span>' });
    }
  }

  const navActive = (id) => S.view === id || (S.view === 'user-profile' && id === 'staff');

  document.getElementById('sidebar-nav').innerHTML = items.map(item => {
    if (item.divider) return `<div class="nav-section-label">${item.divider}</div>`;
    if (item.action) return `
      <div class="nav-item" onclick="${item.action}">
        ${item.icon}
        <span>${item.label}</span>
      </div>`;
    return `
      <div class="nav-item ${navActive(item.id) ? 'active' : ''}" onclick="navigate('${item.id}')">
        ${item.icon}
        <span>${item.label}</span>
        ${item.badge ? `<span class="nav-badge">${item.badge}</span>` : ''}
      </div>`;
  }).join('');

  document.getElementById('sidebar-user').innerHTML = `
    <div class="avatar" style="background:${u.avatar_color || '#C41230'}">${initials(u.name)}</div>
    <div class="sidebar-user-info">
      <div class="sidebar-user-name">${escHtml(u.name)}</div>
      <div class="sidebar-user-role">${u.role}</div>
    </div>
    <button class="sidebar-logout-btn" onclick="logout()" title="Sign out">${iLogout()}</button>
  `;
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function navigate(view) {
  S.view = view;
  renderSidebar();

  const main = document.getElementById('main-content');
  main.classList.add('transitioning');
  await new Promise(r => setTimeout(r, 120));

  try {
    switch (view) {
      case 'dashboard':    await viewDashboard(); break;
      case 'my-holidays':  await viewMyHolidays(); break;
      case 'team':         await viewTeam(); break;
      case 'requests':     await viewRequests(); break;
      case 'staff':        await viewStaff(); break;
      case 'user-profile': await viewUserProfile(); break;
      default:             await viewDashboard();
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <p class="empty-state-title">Something went wrong</p>
        <p class="empty-state-text">${escHtml(err.message)}</p>
        <button class="btn btn-ghost" style="margin-top:16px" onclick="navigate('${view}')">Retry</button>
      </div>`;
  }

  main.classList.remove('transitioning');
}

// ─── View: Dashboard ──────────────────────────────────────────────────────────

async function viewDashboard() {
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="loading-view"><div class="spinner dark"></div></div>`;

  const u = S.user;
  const total     = u.quota?.total_days ?? u.total_days ?? 0;
  const used      = u.usedDays ?? u.used_days ?? 0;
  const remaining = Math.max(0, total - used);
  const pct       = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;

  const today = todayStr();
  const [myHols, rawTodayOff, , announcements] = await Promise.all([
    api('GET', `/holidays?userId=${u.id}`),
    api('GET', wioUrl(S.wioView, today)),
    loadPublicHolidays(S.myYear),
    api('GET', '/announcements'),
  ]);
  S.myHolidays = myHols;
  S.announcements = announcements;

  // Scope "who's off" to the user's own teams (employees/managers); admins see all
  const myTeams = u.teams || [];
  const todayOff = (myTeams.length === 0 || u.role === 'admin')
    ? rawTodayOff
    : rawTodayOff.filter(h => (h.user_teams || []).some(t => myTeams.includes(t)));
  const upcoming = S.myHolidays
    .filter(h => h.status === 'approved' && h.end_date >= today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
    .slice(0, 4);

  const pendingCount = S.myHolidays.filter(h => h.status === 'pending').length;

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1 class="view-title">Good ${greeting()}, ${escHtml(u.name.split(' ')[0])}</h1>
        <p class="view-subtitle">${fmtDateLong(today)}</p>
      </div>
      <button class="btn btn-primary" onclick="openHolidayModal()">${iPlus()} New Request</button>
    </div>

    ${buildAnnouncementsBanner(S.announcements)}

    <div class="stats-grid">
      <div class="stat-card red">
        <div class="stat-label">Total Allowance</div>
        <div class="stat-value">${total}</div>
        <div class="stat-sub">days this year</div>
      </div>
      <div class="stat-card green">
        <div class="stat-label">Remaining</div>
        <div class="stat-value">${remaining}</div>
        <div class="stat-sub">${used} day${used !== 1 ? 's' : ''} used so far</div>
      </div>
      <div class="stat-card amber">
        <div class="stat-label">Awaiting Approval</div>
        <div class="stat-value">${pendingCount}</div>
        <div class="stat-sub">pending request${pendingCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-label">Days Used</div>
        <div class="stat-value">${used}</div>
        <div class="stat-sub">${pct}% of allowance</div>
      </div>
      ${u.offTodayCount !== null && u.offTodayCount !== undefined ? `
      <div class="stat-card teal">
        <div class="stat-label">${u.role === 'admin' ? 'Company Off Today' : 'Team Off Today'}</div>
        <div class="stat-value">${u.offTodayCount}</div>
        <div class="stat-sub">approved leave${u.offTodayCount !== 1 ? 's' : ''} today</div>
      </div>` : ''}
    </div>

    <div class="dashboard-grid">
      <div class="dashboard-col">
        <div class="section">
          <div class="section-header">
            <h2 class="section-title">Upcoming Time Off</h2>
            <button class="btn btn-ghost btn-sm" onclick="navigate('my-holidays')">View all</button>
          </div>
          <div class="card">
            <div class="card-body">
              ${upcoming.length === 0
                ? `<div class="empty-state" style="padding:32px 0">
                    <div class="empty-state-icon">🏖️</div>
                    <p class="empty-state-title">No upcoming holidays</p>
                    <p class="empty-state-text">Submit a request to get started</p>
                   </div>`
                : upcoming.map(h => `
                  <div class="upcoming-item">
                    <div class="upcoming-date-box">
                      <div class="upcoming-month">${MONTHS_SHORT[parseInt(h.start_date.split('-')[1]) - 1]}</div>
                      <div class="upcoming-day">${parseInt(h.start_date.split('-')[2])}</div>
                    </div>
                    <div class="upcoming-info">
                      <div class="upcoming-type">${TYPE_LABELS[h.type] || cap(h.type)}</div>
                      <div class="upcoming-range">${fmtDateShort(h.start_date)} – ${fmtDateShort(h.end_date)} · ${countWorkdays(h.start_date, h.end_date)} days</div>
                    </div>
                    <span class="badge badge-approved"><span class="badge-dot"></span> Approved</span>
                  </div>`).join('')
              }
            </div>
          </div>
        </div>

        ${pendingCount > 0 ? `
        <div class="section">
          <div class="section-header"><h2 class="section-title">Pending Requests</h2></div>
          <div class="card">
            <div class="card-body">
              ${S.myHolidays.filter(h => h.status === 'pending').map(h => `
                <div class="upcoming-item">
                  <div class="upcoming-date-box">
                    <div class="upcoming-month">${MONTHS_SHORT[parseInt(h.start_date.split('-')[1]) - 1]}</div>
                    <div class="upcoming-day">${parseInt(h.start_date.split('-')[2])}</div>
                  </div>
                  <div class="upcoming-info">
                    <div class="upcoming-type">${TYPE_LABELS[h.type] || cap(h.type)}</div>
                    <div class="upcoming-range">${fmtDateShort(h.start_date)} – ${fmtDateShort(h.end_date)} · ${countWorkdays(h.start_date, h.end_date)} days</div>
                  </div>
                  <span class="badge badge-pending"><span class="badge-dot"></span> Pending</span>
                </div>`).join('')}
            </div>
          </div>
        </div>` : ''}
      </div>

      <div class="dashboard-col">
        <div class="card">
          <div class="card-header">
            <span class="card-title">${MONTHS[S.myMonth - 1]} ${S.myYear}</span>
            <div style="display:flex;gap:4px">
              <button class="cal-nav-btn" onclick="dashCalPrev()">${iChevL()}</button>
              <button class="cal-nav-btn" onclick="dashCalNext()">${iChevR()}</button>
            </div>
          </div>
          <div id="mini-cal-container"></div>
        </div>

        <div class="card">
          <div class="card-header"><span class="card-title">Holiday Usage</span></div>
          <div class="card-body">
            <div class="usage-row"><span>Used</span><strong>${used} / ${total} days</strong></div>
            <div class="quota-bar-wrap" style="height:8px;margin-bottom:6px">
              <div class="quota-bar-fill" style="width:${pct}%"></div>
            </div>
            <div style="display:flex;justify-content:space-between">
              <span style="font-size:11px;color:var(--text-3)">0 days</span>
              <span style="font-size:11px;color:var(--text-3)">${total} days</span>
            </div>
          </div>
        </div>

        ${buildWhoIsOffWidget(todayOff, myTeams, u.role)}
      </div>
    </div>
  `;

  const phForMiniMonth = S.publicHolidays
    .filter(ph => ph.date.startsWith(`${S.myYear}-${pad(S.myMonth)}`))
    .map(ph => ({ start_date: ph.date, end_date: ph.date, type: 'public_holiday', status: 'approved', is_public_holiday: true }));
  renderMiniCal([
    ...S.myHolidays.filter(h => overlapsMonth(h, S.myYear, S.myMonth)),
    ...phForMiniMonth,
  ]);
}

function dashCalPrev() {
  if (S.myMonth === 1) { S.myMonth = 12; S.myYear--; } else S.myMonth--;
  navigate('dashboard');
}

function dashCalNext() {
  if (S.myMonth === 12) { S.myMonth = 1; S.myYear++; } else S.myMonth++;
  navigate('dashboard');
}

function renderMiniCal(holidays) {
  const el = document.getElementById('mini-cal-container');
  if (!el) return;

  const y = S.myYear, m = S.myMonth;
  const firstDow = new Date(y, m - 1, 1).getDay();
  const offset = firstDow === 0 ? 6 : firstDow - 1;
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = todayStr();

  let html = `<div class="mini-cal-grid">`;
  html += DAYS.map(d => `<div class="mini-cal-dow">${d[0]}</div>`).join('');

  for (let i = 0; i < offset; i++) html += `<div class="mini-cal-day empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${pad(m)}-${pad(d)}`;
    const dow = new Date(y, m - 1, d).getDay();
    const dayHols = holidays.filter(h => h.start_date <= ds && h.end_date >= ds);
    const hasPending    = dayHols.some(h => h.status === 'pending' && !h.is_public_holiday);
    const hasApproved   = dayHols.some(h => h.status === 'approved' && !h.is_public_holiday);
    const hasPublicHol  = dayHols.some(h => h.is_public_holiday);
    const cls = ['mini-cal-day',
      (dow === 0 || dow === 6) ? 'weekend' : '',
      ds === today ? 'today' : '',
      hasPublicHol ? 'has-public-holiday' : '',
      hasApproved ? 'has-holiday' : hasPending ? 'has-holiday pending' : '',
    ].filter(Boolean).join(' ');
    const titleParts = [hasPublicHol ? dayHols.find(h => h.is_public_holiday)?.user_name || 'Public holiday' : '', hasApproved ? 'Approved holiday' : hasPending ? 'Pending request' : ''].filter(Boolean);
    html += `<div class="${cls}" title="${escHtml(titleParts.join(' · '))}">${d}</div>`;
  }

  html += '</div>';
  el.innerHTML = html;
}

// ─── View: My Holidays ────────────────────────────────────────────────────────

async function viewMyHolidays() {
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="loading-view"><div class="spinner dark"></div></div>`;

  [S.myHolidays] = await Promise.all([
    api('GET', `/holidays?userId=${S.user.id}`),
    loadPublicHolidays(S.myYear),
  ]);

  const phForMonth = S.publicHolidays
    .filter(ph => ph.date.startsWith(`${S.myYear}-${pad(S.myMonth)}`))
    .map(ph => ({ start_date: ph.date, end_date: ph.date, type: 'public_holiday', status: 'approved', is_public_holiday: true, user_name: ph.name }));
  const calHols  = [
    ...S.myHolidays.filter(h => overlapsMonth(h, S.myYear, S.myMonth)),
    ...phForMonth,
  ];
  const allSorted = [...S.myHolidays].sort((a, b) => b.start_date.localeCompare(a.start_date));

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1 class="view-title">My Holidays</h1>
        <p class="view-subtitle">Your personal time off schedule</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" onclick="exportIcs()">↓ Export .ics</button>
        <button class="btn btn-primary" onclick="openHolidayModal()">${iPlus()} New Request</button>
      </div>
    </div>

    <div class="section">
      <div class="calendar-wrap">
        <div class="calendar-nav">
          <button class="cal-nav-btn" onclick="myCalPrev()">${iChevL()}</button>
          <span class="calendar-nav-title">${MONTHS[S.myMonth - 1]} ${S.myYear}</span>
          <div class="calendar-nav-btns">
            <button class="cal-today-btn" onclick="myCalToday()">Today</button>
            <button class="cal-nav-btn" onclick="myCalNext()">${iChevR()}</button>
          </div>
        </div>
        ${buildCalendar(S.myYear, S.myMonth, calHols, false)}
        <div class="legend">
          ${Object.entries(TYPE_COLORS).map(([type, color]) => `
            <div class="legend-item">
              <div class="legend-dot" style="background:${color}"></div>
              ${TYPE_LABELS[type]}
            </div>`).join('')}
          <div class="legend-item">
            <div class="legend-dot" style="background:#D97706;opacity:0.5"></div>
            Pending approval
          </div>
          <div class="legend-item">
            <div class="legend-dot" style="background:#059669"></div>
            Public Holiday
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2 class="section-title">All Requests</h2>
        <span style="font-size:12px;color:var(--text-3)">${allSorted.length} total</span>
      </div>
      ${allSorted.length === 0
        ? `<div class="card"><div class="empty-state">
            <div class="empty-state-icon">📅</div>
            <p class="empty-state-title">No holiday requests yet</p>
            <p class="empty-state-text">Submit a request and it will appear here</p>
           </div></div>`
        : `<div class="holiday-list">${allSorted.map(h => holidayItem(h)).join('')}</div>`
      }
    </div>
  `;
}

function holidayItem(h, showUser = false) {
  const color     = TYPE_COLORS[h.type] || '#C41230';
  const barAlpha  = h.status === 'pending' ? '60' : '';
  const days      = countWorkdays(h.start_date, h.end_date, h.half_day);
  const canCancel = h.status === 'pending' || (isPriv() && h.status === 'approved');
  const hdLabel   = h.half_day ? ` · ${h.half_day} only` : '';
  const dayLabel  = days === 0.5 ? '½ day' : `${days} day${days !== 1 ? 's' : ''}`;

  return `
    <div class="holiday-item" id="hitem-${h.id}">
      <div class="holiday-item-bar" style="background:${color}${barAlpha}"></div>
      ${showUser
        ? `<div class="avatar" style="background:${h.avatar_color};width:32px;height:32px;font-size:11px">${initials(h.user_name || '')}</div>`
        : ''}
      <div class="holiday-item-dates">
        ${showUser ? `<div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:2px">${escHtml(h.user_name || '')}</div>` : ''}
        <div class="holiday-item-range">${fmtDate(h.start_date)}${h.half_day ? '' : ` → ${fmtDate(h.end_date)}`}${h.half_day ? `<span class="hd-badge">${h.half_day}</span>` : ''}</div>
        <div class="holiday-item-meta">${TYPE_LABELS[h.type] || cap(h.type)} · ${dayLabel}${hdLabel}${h.notes ? ` · ${escHtml(h.notes)}` : ''}${h.manager_approved_by_name ? ` · <span style="color:var(--text-3)">Mgr: ${escHtml(h.manager_approved_by_name)}</span>` : ''}${h.reviewed_by_name ? ` · <span style="color:var(--text-3)">${h.status === 'rejected' ? 'Rejected' : 'Approved'} by ${escHtml(h.reviewed_by_name)}</span>` : ''}${h.status === 'rejected' && h.rejection_reason ? `<span class="rejection-reason"> · Reason: ${escHtml(h.rejection_reason)}</span>` : ''}</div>
      </div>
      <div class="holiday-item-actions">
        <span class="badge ${statusBadgeClass(h, S.user?.role)}"><span class="badge-dot"></span>${statusLabel(h, S.user?.role)}</span>
        ${canCancel ? `<button class="btn btn-ghost btn-sm" onclick="cancelHoliday(${h.id})">Cancel</button>` : ''}
      </div>
    </div>`;
}

async function exportIcs() {
  try {
    const res = await fetch('/api/holidays/export/ics', {
      headers: { Authorization: `Bearer ${S.token}` },
    });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'holidays.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) { toast(err.message, 'error'); }
}

function myCalPrev() {
  if (S.myMonth === 1) { S.myMonth = 12; S.myYear--; } else S.myMonth--;
  navigate('my-holidays');
}

function myCalNext() {
  if (S.myMonth === 12) { S.myMonth = 1; S.myYear++; } else S.myMonth++;
  navigate('my-holidays');
}

function myCalToday() {
  S.myYear = new Date().getFullYear(); S.myMonth = new Date().getMonth() + 1;
  navigate('my-holidays');
}

// ─── View: Team Calendar ──────────────────────────────────────────────────────

async function viewTeam() {
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="loading-view"><div class="spinner dark"></div></div>`;

  const [holidays, teams] = await Promise.all([
    api('GET', `/holidays/team?year=${S.teamYear}&month=${S.teamMonth}`),
    api('GET', '/teams'),
  ]);
  S.teamHolidays = holidays;
  S.allTeams = teams;

  // If the active filter no longer maps to a known team, reset it
  if (S.teamFilter && !S.allTeams.includes(S.teamFilter)) S.teamFilter = null;

  const filtered = S.teamFilter
    ? S.teamHolidays.filter(h => (h.user_teams || []).includes(S.teamFilter))
    : S.teamHolidays;

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1 class="view-title">Team Calendar</h1>
        <p class="view-subtitle">Approved time off across the entire team</p>
      </div>
    </div>

    ${S.allTeams.length > 0 ? `
    <div class="team-filters" id="team-filters">
      <button class="team-pill ${!S.teamFilter ? 'active' : ''}" data-team="" onclick="setTeamFilter(null)">
        All Teams
        <span class="team-pill-count">${S.teamHolidays.length ? countUniqUsers(S.teamHolidays) : 0}</span>
      </button>
      ${S.allTeams.map(t => {
        const tHols = S.teamHolidays.filter(h => (h.user_teams || []).includes(t));
        return `
          <button class="team-pill ${S.teamFilter === t ? 'active' : ''}" data-team="${escHtml(t)}" onclick="setTeamFilter('${escHtml(t)}')">
            ${escHtml(t)}
            <span class="team-pill-count">${countUniqUsers(tHols)}</span>
          </button>`;
      }).join('')}
    </div>` : ''}

    <div class="section" id="team-cal-section">
      ${buildTeamCalSection(filtered)}
    </div>
  `;
}

function buildTeamCalSection(holidays) {
  const userMap = {};
  holidays.forEach(h => { if (h.user_id && !userMap[h.user_id]) userMap[h.user_id] = { id: h.user_id, name: h.user_name, color: h.avatar_color }; });
  const users = Object.values(userMap);

  const filterLabel = S.teamFilter ? ` · ${escHtml(S.teamFilter)}` : '';

  return `
    <div class="calendar-wrap">
      <div class="calendar-nav">
        <button class="cal-nav-btn" onclick="teamCalPrev()">${iChevL()}</button>
        <span class="calendar-nav-title">${MONTHS[S.teamMonth - 1]} ${S.teamYear}${filterLabel}</span>
        <div class="calendar-nav-btns">
          <button class="cal-today-btn" onclick="teamCalToday()">Today</button>
          <button class="cal-nav-btn" onclick="teamCalNext()">${iChevR()}</button>
        </div>
      </div>
      ${buildCalendar(S.teamYear, S.teamMonth, holidays, true)}
      <div class="legend">
        ${users.map(u => `
          <div class="legend-item">
            <div class="legend-dot" style="background:${u.color}"></div>
            ${escHtml(u.name)}
          </div>`).join('')}
        ${holidays.some(h => h.is_public_holiday) ? `
          <div class="legend-item">
            <div class="legend-dot" style="background:#059669"></div>
            Public Holiday
          </div>` : ''}
      </div>
    </div>
    ${holidays.length === 0 ? `
    <div class="card" style="margin-top:16px">
      <div class="empty-state">
        <div class="empty-state-icon">🏖️</div>
        <p class="empty-state-title">No approved holidays this month${S.teamFilter ? ` for ${escHtml(S.teamFilter)}` : ''}</p>
        <p class="empty-state-text">Approved requests will appear here</p>
      </div>
    </div>` : ''}
  `;
}

function setTeamFilter(name) {
  S.teamFilter = name || null;

  // Update pill active states
  document.querySelectorAll('.team-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.team === (name || ''));
  });

  // Re-render calendar section with filtered holidays
  const filtered = S.teamFilter
    ? S.teamHolidays.filter(h => (h.user_teams || []).includes(S.teamFilter))
    : S.teamHolidays;
  document.getElementById('team-cal-section').innerHTML = buildTeamCalSection(filtered);
}

function countUniqUsers(holidays) {
  return new Set(holidays.filter(h => !h.is_public_holiday).map(h => h.user_id)).size;
}

function teamCalPrev() {
  if (S.teamMonth === 1) { S.teamMonth = 12; S.teamYear--; } else S.teamMonth--;
  navigate('team');
}

function teamCalNext() {
  if (S.teamMonth === 12) { S.teamMonth = 1; S.teamYear++; } else S.teamMonth++;
  navigate('team');
}

function teamCalToday() {
  S.teamYear = new Date().getFullYear(); S.teamMonth = new Date().getMonth() + 1;
  navigate('team');
}

// ─── View: Requests ───────────────────────────────────────────────────────────

function buildAnnouncementsBanner(announcements) {
  if (!announcements || !announcements.length) return '';
  const isAdmin = S.user?.role === 'admin';
  return `
    <div class="announcements-banner">
      ${announcements.map(a => `
        <div class="announcement-item">
          <div class="announcement-body">
            <div class="announcement-title">${escHtml(a.title)}</div>
            <div class="announcement-message">${escHtml(a.message)}</div>
            <div class="announcement-meta">Posted by ${escHtml(a.author_name)} · ${fmtDate(a.created_at.slice(0, 10))}</div>
          </div>
          ${isAdmin ? `<button class="btn btn-ghost btn-sm ann-delete" onclick="deleteAnnouncement(${a.id})" title="Delete announcement">✕</button>` : ''}
        </div>
      `).join('')}
    </div>`;
}

function openAnnouncementModal() {
  showModal(`
    <div class="modal-header">
      <span class="modal-title">📢 Post Announcement</span>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-stack">
        <div class="field">
          <label class="field-label">Title</label>
          <input class="input" id="ann-title" maxlength="100" placeholder="Announcement title" />
        </div>
        <div class="field">
          <label class="field-label">Message</label>
          <textarea class="input" id="ann-message" rows="4" placeholder="Announcement message…" style="resize:vertical"></textarea>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitAnnouncement()">Post</button>
    </div>
  `);
}

async function submitAnnouncement() {
  const title = document.getElementById('ann-title').value.trim();
  const message = document.getElementById('ann-message').value.trim();
  if (!title || !message) return toast('Title and message are required', 'error');
  try {
    await api('POST', '/announcements', { title, message });
    closeModal();
    toast('Announcement posted');
    navigate('dashboard');
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteAnnouncement(id) {
  try {
    await api('DELETE', `/announcements/${id}`);
    toast('Announcement deleted');
    navigate('dashboard');
  } catch (err) { toast(err.message, 'error'); }
}

function wioUrl(view, today) {
  if (view === 'week') {
    const end = new Date();
    end.setDate(end.getDate() + 6);
    const endStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
    return `/holidays/team?start_date=${today}&end_date=${endStr}`;
  }
  return `/holidays/team?date=${today}`;
}

async function setWioView(view) {
  S.wioView = view;
  const u = S.user;
  const myTeams = u.teams || [];
  const today = todayStr();
  const rawData = await api('GET', wioUrl(view, today)).catch(() => []);
  const filtered = (myTeams.length === 0 || u.role === 'admin')
    ? rawData
    : rawData.filter(h => (h.user_teams || []).some(t => myTeams.includes(t)));
  const el = document.getElementById('wio-widget');
  if (el) el.outerHTML = buildWhoIsOffWidget(filtered, myTeams, u.role);
}

function buildWioRow(h) {
  if (h.is_public_holiday) {
    return `<div class="wio-row">
      <div style="background:#D1FAE5;color:#059669;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">🏛</div>
      <div class="wio-info">
        <div class="wio-name">${escHtml(h.user_name || 'Public Holiday')}</div>
        <div class="wio-meta" style="color:#059669">Public Holiday</div>
      </div>
    </div>`;
  }
  return `<div class="wio-row">
    <div class="avatar" style="background:${h.avatar_color};width:34px;height:34px;font-size:12px;flex-shrink:0">${initials(h.user_name || '')}</div>
    <div class="wio-info">
      <div class="wio-name">${escHtml(h.user_name || '')}</div>
      <div class="wio-meta">${TYPE_LABELS[h.type] || cap(h.type)}</div>
    </div>
    ${h.half_day ? `<span class="hd-badge">${h.half_day}</span>` : ''}
  </div>`;
}

function buildWioWeekBody(people) {
  const today = todayStr();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const dayPeople = people.filter(h => h.start_date <= ds && h.end_date >= ds);
    if (dayPeople.length > 0) days.push({ ds, dayPeople });
  }
  if (days.length === 0) {
    return `<div class="wio-empty"><span class="wio-empty-icon">🎉</span><p class="wio-empty-text">No one off in the next 7 days</p></div>`;
  }
  return `<div class="wio-list">${days.map(({ ds, dayPeople }) => `
    <div class="wio-day-group">
      <div class="wio-day-label">${fmtDateShort(ds)}</div>
      ${dayPeople.slice(0, 3).map(buildWioRow).join('')}
      ${dayPeople.length > 3 ? `<div class="wio-more" onclick="navigate('team')">+${dayPeople.length - 3} more</div>` : ''}
    </div>`).join('')}</div>`;
}

function buildWhoIsOffWidget(people, myTeams, role) {
  const view = S.wioView || 'today';
  const MAX = 4;

  const scopeLabel = role === 'admin'
    ? 'Company-wide'
    : myTeams.length === 1 ? escHtml(myTeams[0])
    : myTeams.length > 1  ? 'Your teams'
    : '';

  const countBadge = people.length > 0
    ? `<span class="wio-count">${people.length} off</span>`
    : '';

  let body;
  if (view === 'week') {
    body = buildWioWeekBody(people);
  } else {
    const shown = people.slice(0, MAX);
    const extra = people.length - MAX;
    body = people.length === 0
      ? `<div class="wio-empty"><span class="wio-empty-icon">🎉</span><p class="wio-empty-text">Everyone's in today</p></div>`
      : `<div class="wio-list">
          ${shown.map(buildWioRow).join('')}
          ${extra > 0 ? `<div class="wio-more" onclick="navigate('team')">${extra} more → View calendar</div>` : ''}
        </div>`;
  }

  const toggles = `<div class="wio-toggles">
    <button class="wio-toggle-btn ${view === 'today' ? 'active' : ''}" onclick="setWioView('today')">Today</button>
    <button class="wio-toggle-btn ${view === 'week' ? 'active' : ''}" onclick="setWioView('week')">Next 7 Days</button>
  </div>`;

  return `
    <div class="card wio-card" id="wio-widget">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div class="card-title">Who's Off</div>
          ${scopeLabel ? `<div style="font-size:11px;color:var(--text-3);margin-top:1px">${scopeLabel}</div>` : ''}
        </div>
        ${countBadge}
      </div>
      ${toggles}
      ${body}
    </div>`;
}

async function viewRequests() {
  if (!isPriv()) return navigate('dashboard');
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="loading-view"><div class="spinner dark"></div></div>`;
  const [holidays, teams] = await Promise.all([api('GET', '/holidays'), api('GET', '/teams')]);
  S.allHolidays = holidays;
  S.allTeams = teams;
  drawRequestsTable();
}

function drawRequestsTable() {
  const main = document.getElementById('main-content');
  const teamBase = S.reqTeamFilter
    ? S.allHolidays.filter(h => (h.user_teams || []).includes(S.reqTeamFilter))
    : S.allHolidays;
  const filtered = S.reqTab === 'all' ? teamBase
    : S.reqTab === 'secondary' ? teamBase.filter(h => h.status === 'manager_approved')
    : teamBase.filter(h => h.status === S.reqTab);
  const counts = { pending: 0, approved: 0, rejected: 0, secondary: 0 };
  teamBase.forEach(h => {
    if (h.status === 'manager_approved') counts.secondary++;
    else if (counts[h.status] !== undefined) counts[h.status]++;
  });

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1 class="view-title">Holiday Requests</h1>
        <p class="view-subtitle">Review and manage the team's requests</p>
      </div>
    </div>

    <div class="section">
      ${S.allTeams.length > 0 ? `
      <div class="team-filters" style="margin-bottom:16px">
        <button class="team-pill ${!S.reqTeamFilter ? 'active' : ''}" onclick="setReqTeamFilter(null)">All Teams</button>
        ${S.allTeams.map(t => `
          <button class="team-pill ${S.reqTeamFilter === t ? 'active' : ''}" onclick="setReqTeamFilter('${escHtml(t).replace(/'/g,"\\'")}')">
            ${escHtml(t)}
          </button>`).join('')}
      </div>` : ''}
      <div style="margin-bottom:16px">
        <div class="tabs">
          ${['pending','approved','rejected','all'].map(t => `
            <div class="tab ${S.reqTab === t ? 'active' : ''}" onclick="setReqTab('${t}')">
              ${cap(t)}${t !== 'all' && counts[t] > 0 ? ` (${counts[t]})` : t === 'all' ? ` (${teamBase.length})` : ''}
            </div>`).join('')}
          ${S.user?.role === 'admin' ? `
            <div class="tab ${S.reqTab === 'secondary' ? 'active' : ''}" onclick="setReqTab('secondary')" style="color:${counts.secondary > 0 ? 'var(--amber)' : ''}">
              Secondary${counts.secondary > 0 ? ` (${counts.secondary})` : ''}
            </div>` : ''}
        </div>
      </div>

      ${filtered.length === 0
        ? `<div class="card"><div class="empty-state">
            <div class="empty-state-icon">${S.reqTab === 'pending' || S.reqTab === 'secondary' ? '✓' : '📋'}</div>
            <p class="empty-state-title">No ${S.reqTab === 'all' ? '' : S.reqTab === 'secondary' ? 'secondary approval ' : S.reqTab + ' '}requests</p>
            <p class="empty-state-text">Nothing to display here</p>
           </div></div>`
        : `<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Dates</th>
                  <th>Type</th>
                  <th>Days</th>
                  <th>Notes</th>
                  <th>Status</th>
                  <th>Reviewed by</th>
                  <th style="text-align:right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map(h => {
                  const days = countWorkdays(h.start_date, h.end_date, h.half_day);
                  const dayLabel = days === 0.5 ? '½' : days;
                  return `
                    <tr id="req-${h.id}">
                      <td>
                        <div class="user-cell">
                          <div class="avatar" style="background:${h.avatar_color};width:30px;height:30px;font-size:11px">${initials(h.user_name)}</div>
                          <span>${escHtml(h.user_name)}</span>
                        </div>
                      </td>
                      <td>
                        <span style="font-weight:500">${fmtDateShort(h.start_date)}</span>
                        ${h.half_day ? `<span class="hd-badge">${h.half_day}</span>` : `<span style="color:var(--text-3)"> → </span><span style="font-weight:500">${fmtDateShort(h.end_date)}</span>`}
                      </td>
                      <td><span class="type-pill type-${h.type}">${TYPE_LABELS[h.type] || cap(h.type)}</span></td>
                      <td style="font-weight:600;font-feature-settings:'tnum'">${dayLabel}</td>
                      <td style="color:var(--text-2);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(h.notes) || '—'}</td>
                      <td><span class="badge ${statusBadgeClass(h, S.user?.role)}"><span class="badge-dot"></span>${statusLabel(h, S.user?.role)}</span></td>
                      <td style="font-size:12.5px">${reviewedByCell(h)}</td>
                      <td>
                        <div class="td-actions">
                          ${h.status === 'pending'
                            ? `<button class="btn btn-success btn-sm" onclick="reviewRequest(${h.id},'approved')">Approve</button>
                               <button class="btn btn-danger btn-sm" onclick="reviewRequest(${h.id},'rejected')">Reject</button>`
                            : h.status === 'manager_approved' && S.user?.role === 'admin'
                            ? `<button class="btn btn-success btn-sm" onclick="reviewRequest(${h.id},'approved')">Approve</button>
                               <button class="btn btn-danger btn-sm" onclick="reviewRequest(${h.id},'rejected')">Reject</button>`
                            : '<span style="color:var(--text-3);font-size:12px">—</span>'}
                        </div>
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`
      }
    </div>
  `;
}

function setReqTab(tab) { S.reqTab = tab; drawRequestsTable(); }
function setReqTeamFilter(team) { S.reqTeamFilter = team || null; drawRequestsTable(); }

async function reviewRequest(id, status) {
  let rejection_reason = null;
  if (status === 'rejected') {
    rejection_reason = prompt('Reason for rejection (optional):') ?? null;
    if (rejection_reason !== null && rejection_reason.trim() === '') rejection_reason = null;
  }
  try {
    const body = { status };
    if (rejection_reason) body.rejection_reason = rejection_reason;
    const updated = await api('PATCH', `/holidays/${id}/status`, body);
    const idx = S.allHolidays.findIndex(x => x.id === id);
    if (idx >= 0) S.allHolidays[idx] = { ...S.allHolidays[idx], ...updated };
    if (status === 'approved' || status === 'rejected') {
      S.user.pendingCount = Math.max(0, (S.user.pendingCount || 0) - 1);
      renderSidebar();
    }
    drawRequestsTable();
    toast(`Request ${status}`, status === 'approved' ? 'success' : 'info');
  } catch (err) { toast(err.message, 'error'); }
}

// ─── View: Staff ──────────────────────────────────────────────────────────────

async function viewStaff() {
  if (!isPriv()) return navigate('dashboard');
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="loading-view"><div class="spinner dark"></div></div>`;
  const fetches = [api('GET', '/users'), api('GET', '/teams')];
  if (S.user.role === 'admin') fetches.push(loadPublicHolidays(new Date().getFullYear()), api('GET', '/teams-config'));
  const [users, teams, , teamsConfig] = await Promise.all(fetches);
  S.allUsers = users;
  S.allTeams = teams;
  S.teamsConfig = teamsConfig || [];
  drawStaffView();
}

function drawStaffView() {
  const main = document.getElementById('main-content');
  const isAdmin = S.user.role === 'admin';

  const tabBar = isAdmin ? `
    <div class="tabs" style="margin-bottom:20px">
      <div class="tab ${S.staffTab === 'staff' ? 'active' : ''}" onclick="setStaffTab('staff')">Staff</div>
      <div class="tab ${S.staffTab === 'teams' ? 'active' : ''}" onclick="setStaffTab('teams')">Teams</div>
      <div class="tab ${S.staffTab === 'public-holidays' ? 'active' : ''}" onclick="setStaffTab('public-holidays')">Public Holidays</div>
    </div>` : '';

  const addBtn = !isAdmin
    ? ''
    : S.staffTab === 'staff'
      ? `<button class="btn btn-primary" onclick="openUserModal(null)">${iPlus()} Add Employee</button>`
      : S.staffTab === 'public-holidays'
      ? `<button class="btn btn-primary" onclick="openPublicHolidayModal()">${iPlus()} Add Public Holiday</button>`
      : '';

  const visibleUsers = S.staffTeamFilter
    ? S.allUsers.filter(u => (u.teams || []).includes(S.staffTeamFilter))
    : S.allUsers;

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1 class="view-title">Manage Staff</h1>
        <p class="view-subtitle">${!isAdmin || S.staffTab === 'staff' ? `${visibleUsers.length} team member${visibleUsers.length !== 1 ? 's' : ''}` : S.staffTab === 'teams' ? 'Team settings and secondary approval' : 'Company-wide public holidays'}</p>
      </div>
      ${addBtn}
    </div>
    ${tabBar}
    <div id="staff-tab-content"></div>
  `;

  if (S.staffTab === 'staff' || !isAdmin) {
    renderStaffTabContent();
  } else if (S.staffTab === 'teams') {
    renderTeamsConfigTabContent();
  } else {
    renderPublicHolidaysTabContent();
  }
}

function setStaffTab(tab) {
  S.staffTab = tab;
  drawStaffView();
}


function renderStaffTabContent() {
  const el = document.getElementById('staff-tab-content');
  if (!el) return;
  const visibleUsers = S.staffTeamFilter
    ? S.allUsers.filter(u => (u.teams || []).includes(S.staffTeamFilter))
    : S.allUsers;

  el.innerHTML = `
    ${S.allTeams.length > 0 ? `
    <div class="team-filters">
      <button class="team-pill ${!S.staffTeamFilter ? 'active' : ''}" onclick="setStaffTeamFilter(null)">All Teams</button>
      ${S.allTeams.map(t => `
        <button class="team-pill ${S.staffTeamFilter === t ? 'active' : ''}" onclick="setStaffTeamFilter('${escHtml(t).replace(/'/g,"\\'")}')">
          ${escHtml(t)}
        </button>`).join('')}
    </div>` : ''}

    ${visibleUsers.length === 0
      ? `<div class="card"><div class="empty-state">
          <div class="empty-state-icon">👥</div>
          <p class="empty-state-title">No team members yet</p>
          <p class="empty-state-text">Add employees to get started</p>
         </div></div>`
      : `<div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Team</th>
                <th>Allowance</th>
                <th>Used</th>
                <th>Remaining</th>
                <th style="text-align:right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${visibleUsers.map(u => {
                const rem = Math.max(0, (u.total_days || 0) - (u.used_days || 0));
                const pct = u.total_days > 0 ? Math.min(100, Math.round((u.used_days || 0) / u.total_days * 100)) : 0;
                const teams = u.teams || [];
                return `
                  <tr>
                    <td>
                      <div class="user-cell">
                        <div class="avatar" style="background:${u.avatar_color};width:32px;height:32px;font-size:12px">${initials(u.name)}</div>
                        <div class="user-cell-info">
                          <div class="user-cell-name">${escHtml(u.name)}</div>
                          ${u.job_title ? `<div class="user-cell-email" style="color:var(--text-2)">${escHtml(u.job_title)}</div>` : ''}
                          <div class="user-cell-email">${escHtml(u.email)}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span class="badge" style="background:${roleBg(u.role)};color:${roleColor(u.role)};border-color:${roleBorder(u.role)}">
                        ${cap(u.role)}
                      </span>
                    </td>
                    <td>
                      <div style="display:flex;flex-wrap:wrap;gap:4px">
                        ${teams.length > 0
                          ? teams.map(t => `<span class="team-tag-sm">${escHtml(t)}</span>`).join('')
                          : `<span style="color:var(--text-3)">—</span>`}
                      </div>
                    </td>
                    <td style="font-weight:600">${u.total_days || 0} days${u.carry_allowed ? ' <span title="Carry-over enabled" style="color:var(--text-3);font-size:11px;font-weight:400">↻</span>' : ''}</td>
                    <td>${u.used_days || 0} days</td>
                    <td>
                      <div style="display:flex;align-items:center;gap:10px">
                        <span style="font-weight:600;min-width:24px;font-feature-settings:'tnum'">${rem}</span>
                        <div class="quota-bar-wrap"><div class="quota-bar-fill" style="width:${pct}%"></div></div>
                      </div>
                    </td>
                    <td>
                      <div class="td-actions">
                        <button class="btn btn-ghost btn-sm" onclick="goToUserProfile(${u.id})" title="View holidays">${iPerson()} View</button>
                        ${S.user.role === 'admin' ? `<button class="btn btn-ghost btn-sm" onclick="openUserModal(${u.id})">Edit</button>` : ''}
                        ${S.user.role === 'admin' && u.id !== S.user.id
                          ? `<button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${escHtml(u.name)}')">Remove</button>`
                          : ''}
                      </div>
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`
    }
  `;
}

function renderTeamsConfigTabContent() {
  const el = document.getElementById('staff-tab-content');
  if (!el) return;
  const managers = S.allUsers.filter(u => u.role === 'manager');
  const admins   = S.allUsers.filter(u => u.role === 'admin');

  if (!S.teamsConfig.length) {
    el.innerHTML = `<div class="card"><div class="empty-state">
      <div class="empty-state-icon">🏢</div>
      <p class="empty-state-title">No teams yet</p>
      <p class="empty-state-text">Add employees to teams first</p>
    </div></div>`;
    return;
  }

  const userOption = (users, selectedId, placeholder) =>
    `<option value="">${placeholder}</option>` +
    users.map(u => `<option value="${u.id}" ${u.id === selectedId ? 'selected' : ''}>${escHtml(u.name)}</option>`).join('');

  el.innerHTML = `
    <div class="teams-config-list">
      ${S.teamsConfig.map(t => `
        <div class="card" style="margin-bottom:12px">
          <div class="card-body">
            <div class="teams-config-row">
              <div class="teams-config-name">${escHtml(t.name)}</div>
              <div class="teams-config-fields">
                <div class="field">
                  <label class="field-label">Manager</label>
                  <select class="input select-sm" onchange="updateTeamConfig(${t.id}, 'manager_id', this.value)">
                    ${userOption(managers, t.manager_id, 'None')}
                  </select>
                </div>
                <div class="field">
                  <label class="field-label">Admin</label>
                  <select class="input select-sm" onchange="updateTeamConfig(${t.id}, 'admin_id', this.value)">
                    ${userOption(admins, t.admin_id, 'None')}
                  </select>
                </div>
                <div class="field" style="justify-content:center">
                  <label class="field-label">Secondary Approval</label>
                  <label class="toggle-label">
                    <input type="checkbox" class="toggle-input" ${t.requires_secondary_approval ? 'checked' : ''}
                      onchange="updateTeamConfig(${t.id}, 'requires_secondary_approval', this.checked)">
                    <span class="toggle-track"></span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>`).join('')}
    </div>`;
}

async function updateTeamConfig(teamId, field, value) {
  try {
    const updated = await api('PATCH', `/teams-config/${teamId}`, { [field]: value === '' ? null : value === true || value === false ? value : isNaN(value) ? value : parseInt(value) });
    const idx = S.teamsConfig.findIndex(t => t.id === teamId);
    if (idx >= 0) S.teamsConfig[idx] = updated;
    toast('Team updated');
  } catch (err) { toast(err.message, 'error'); }
}

function renderPublicHolidaysTabContent() {
  const el = document.getElementById('staff-tab-content');
  if (!el) return;
  const phs = S.publicHolidays || [];
  const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  el.innerHTML = phs.length === 0
    ? `<div class="card"><div class="empty-state">
        <div class="empty-state-icon">🏛</div>
        <p class="empty-state-title">No public holidays defined</p>
        <p class="empty-state-text">Add bank holidays to exclude them from leave calculations</p>
       </div></div>`
    : `<div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Name</th><th>Day</th><th style="text-align:right">Actions</th></tr></thead>
          <tbody>
            ${phs.map(ph => {
              const dow = dowNames[new Date(ph.date + 'T00:00:00').getDay()];
              return `
                <tr>
                  <td style="font-weight:600;font-feature-settings:'tnum'">${fmtDate(ph.date)}</td>
                  <td>${escHtml(ph.name)}</td>
                  <td style="color:var(--text-3)">${dow}</td>
                  <td>
                    <div class="td-actions">
                      <button class="btn btn-danger btn-sm" onclick="deletePublicHoliday(${ph.id}, '${escHtml(ph.name).replace(/'/g, "\\'")}')">Remove</button>
                    </div>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
       </div>`;
}

function openPublicHolidayModal() {
  showModal(`
    <div class="modal-header">
      <span class="modal-title">Add Public Holiday</span>
      <button class="modal-close" onclick="closeModal()">${iX()}</button>
    </div>
    <div class="modal-body">
      <div class="form-stack">
        <div class="field">
          <label class="field-label">Holiday Name</label>
          <input type="text" class="input" id="ph-name" placeholder="e.g. Christmas Day" />
        </div>
        <div class="field">
          <label class="field-label">Date</label>
          <input type="date" class="input" id="ph-date" />
        </div>
        <div id="ph-err" class="modal-error hidden"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="ph-submit" onclick="submitPublicHoliday()">Add Holiday</button>
    </div>
  `);
  document.getElementById('ph-name').focus();
}

async function submitPublicHoliday() {
  const name  = document.getElementById('ph-name')?.value.trim();
  const date  = document.getElementById('ph-date')?.value;
  const errEl = document.getElementById('ph-err');
  const btn   = document.getElementById('ph-submit');

  if (!name || !date) {
    errEl.textContent = 'Name and date are required.';
    return errEl.classList.remove('hidden');
  }
  errEl.classList.add('hidden');
  btn.disabled = true;

  try {
    await api('POST', '/public-holidays', { name, date });
    closeModal();
    toast('Public holiday added');
    await loadPublicHolidays(date.split('-')[0]);
    renderPublicHolidaysTabContent();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
  }
}

async function deletePublicHoliday(id, name) {
  if (!confirm(`Remove "${name}" from public holidays?`)) return;
  try {
    await api('DELETE', `/public-holidays/${id}`);
    toast('Public holiday removed');
    await loadPublicHolidays(new Date().getFullYear());
    renderPublicHolidaysTabContent();
  } catch (err) { toast(err.message, 'error'); }
}


function roleBg(r)     { return { admin: '#FFF0F2', manager: '#FFF7ED', employee: '#F0FDF4' }[r] || '#F5F5F5'; }
function roleColor(r)  { return { admin: '#C41230', manager: '#C2410C', employee: '#15803D' }[r] || '#555'; }
function roleBorder(r) { return { admin: '#FECDD3', manager: '#FED7AA', employee: '#BBF7D0' }[r] || '#E5E5E5'; }

// ─── Calendar Builder ─────────────────────────────────────────────────────────

function buildCalendar(year, month, holidays, isTeam) {
  const firstDow     = new Date(year, month - 1, 1).getDay();
  const offset       = firstDow === 0 ? 6 : firstDow - 1;
  const daysInMonth  = new Date(year, month, 0).getDate();
  const today        = todayStr();

  let html = `<div class="cal-grid">`;
  html += DAYS.map(d => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < offset; i++) html += `<div class="cal-cell empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const ds       = `${year}-${pad(month)}-${pad(d)}`;
    const dow      = new Date(year, month - 1, d).getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isToday   = ds === today;
    const isPast    = ds < today;

    const dayHols = holidays.filter(h => h.start_date <= ds && h.end_date >= ds);
    const shown   = dayHols.slice(0, 3);
    const extra   = dayHols.length - 3;

    const cls = ['cal-cell', isWeekend ? 'weekend' : '', isToday ? 'today' : '', isPast ? 'past' : ''].filter(Boolean).join(' ');

    html += `
      <div class="${cls}">
        <span class="cal-day-num">${d}</span>
        <div class="cal-events">
          ${shown.map(h => {
            const hdSuffix = h.half_day ? ` · ${h.half_day}` : '';
            if (h.is_public_holiday) {
              return `<div class="cal-event cal-event-ph" title="${escHtml(h.user_name || 'Public Holiday')}">${escHtml(h.user_name || 'Holiday')}</div>`;
            }
            if (isTeam) {
              const inits = initials(h.user_name || '');
              const hdMark = h.half_day ? ` <span style="opacity:.75;font-size:8px">${h.half_day}</span>` : '';
              return `<div class="cal-event${h.half_day ? ' cal-event-half' : ''}" style="background:${h.avatar_color}" title="${escHtml(h.user_name)}: ${TYPE_LABELS[h.type] || h.type}${hdSuffix}">${inits}${hdMark}</div>`;
            } else {
              const color = TYPE_COLORS[h.type] || '#C41230';
              const alpha = h.status === 'pending' ? '70' : '';
              const lbl   = h.half_day ? h.half_day : (TYPE_LABELS[h.type] || '').split(' ')[0];
              return `<div class="cal-event${h.half_day ? ' cal-event-half' : ''}" style="background:${color}${alpha}" title="${TYPE_LABELS[h.type] || h.type} (${h.status})${hdSuffix}">${lbl}</div>`;
            }
          }).join('')}
          ${extra > 0 ? `<div class="cal-event more">+${extra}</div>` : ''}
        </div>
      </div>`;
  }

  html += '</div>';
  return html;
}

// ─── Holiday Request Modal ────────────────────────────────────────────────────

function openHolidayModal(onBehalfOfId = null) {
  _holBehalfOf = (onBehalfOfId && onBehalfOfId !== S.user.id) ? onBehalfOfId : null;

  // Use the profile user's quota when booking on behalf, otherwise use own
  const bookFor   = _holBehalfOf ? _profileUser : S.user;
  const total     = bookFor?.quota?.total_days ?? bookFor?.total_days ?? 0;
  const used      = bookFor?.usedDays ?? bookFor?.used_days ?? 0;
  const remaining = Math.max(0, total - used);
  const today     = todayStr();
  const onBehalf  = _holBehalfOf && bookFor;

  showModal(`
    <div class="modal-header">
      <span class="modal-title">${iCalendar(16)} ${onBehalf ? `Book Holiday for ${escHtml(bookFor.name)}` : 'Request Time Off'}</span>
      <button class="modal-close" onclick="closeModal()">${iX()}</button>
    </div>
    <div class="modal-body">
      <div class="form-stack">
        <div class="form-row">
          <div class="field">
            <label class="field-label">Start Date</label>
            <input type="date" class="input" id="hol-start" min="${today}" />
          </div>
          <div class="field">
            <label class="field-label">End Date</label>
            <input type="date" class="input" id="hol-end" min="${today}" />
          </div>
        </div>
        <div id="hol-halfday-row" class="field hidden">
          <label class="field-label">Half Day</label>
          <div class="hd-toggle">
            <button type="button" class="hd-btn" id="hd-none"  onclick="setHalfDay(null);syncHolDates()" >Full Day</button>
            <button type="button" class="hd-btn" id="hd-am"    onclick="setHalfDay('AM');syncHolDates()" >AM Only</button>
            <button type="button" class="hd-btn" id="hd-pm"    onclick="setHalfDay('PM');syncHolDates()" >PM Only</button>
          </div>
        </div>
        <div class="field">
          <label class="field-label">Holiday Type</label>
          <select class="select" id="hol-type">
            <option value="annual">Annual Leave</option>
            <option value="unpaid">Unpaid Leave</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label">Notes <span style="color:var(--text-3);font-weight:400">(optional)</span></label>
          <textarea class="textarea input" id="hol-notes" placeholder="Any additional information…"></textarea>
        </div>
        <div class="days-info">
          <div class="days-info-item">
            <div class="days-info-value" id="days-req" style="color:var(--text-3)">—</div>
            <div class="days-info-label">Days Requested</div>
          </div>
          <div class="days-info-divider"></div>
          <div class="days-info-item">
            <div class="days-info-value">${remaining}</div>
            <div class="days-info-label">Days Remaining</div>
          </div>
          <div class="days-info-divider"></div>
          <div class="days-info-item">
            <div class="days-info-value" id="days-after" style="color:var(--text-3)">—</div>
            <div class="days-info-label">After Request</div>
          </div>
        </div>
        <div id="hol-warn" class="modal-warn hidden"></div>
        <div id="hol-err" class="modal-error hidden"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="hol-submit" onclick="submitHoliday()">${iCalendar(14)} Submit Request</button>
    </div>
  `);
  // Initialise "Full Day" as selected
  const noneBtn = document.getElementById('hd-none');
  if (noneBtn) noneBtn.classList.add('active');
  // Attach date listeners programmatically — more reliable than inline onchange/oninput
  ['hol-start', 'hol-end'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', syncHolDates);
      el.addEventListener('input',  syncHolDates);
    }
  });
  syncHolDates();
}

function syncHolDates() {
  const startEl   = document.getElementById('hol-start');
  const endEl     = document.getElementById('hol-end');
  const reqEl     = document.getElementById('days-req');
  const aftEl     = document.getElementById('days-after');
  const hdRow     = document.getElementById('hol-halfday-row');
  if (!startEl || !endEl || !reqEl || !aftEl) return;

  const start = startEl.value, end = endEl.value;

  if (start) {
    endEl.min = start;
    if (end && end < start) endEl.value = start;
  }

  // Short-notice warning
  const warnEl = document.getElementById('hol-warn');
  if (warnEl) {
    if (start) {
      const daysUntil = Math.ceil((new Date(start + 'T00:00:00') - new Date()) / 86400000);
      if (daysUntil < 28) {
        warnEl.textContent = `⚠ This request starts in ${daysUntil} day${daysUntil !== 1 ? 's' : ''} — short-notice requests (under 28 days) may be rejected.`;
        warnEl.classList.remove('hidden');
      } else {
        warnEl.classList.add('hidden');
      }
    } else {
      warnEl.classList.add('hidden');
    }
  }

  // Show half-day toggle only for single-day bookings on a weekday
  const isSingleDay = start && end && start === end;
  if (hdRow) {
    if (isSingleDay) {
      const dow = new Date(start + 'T00:00:00').getDay();
      hdRow.classList.toggle('hidden', dow === 0 || dow === 6);
    } else {
      hdRow.classList.add('hidden');
      setHalfDay(null); // reset if multi-day
    }
  }

  if (start && end && start <= end) {
    const halfDay   = document.getElementById('hd-am')?.classList.contains('active') ? 'AM'
                    : document.getElementById('hd-pm')?.classList.contains('active') ? 'PM' : null;
    const rawDays   = countWorkdays(start, end);
    const phOverlap = (S.publicHolidays || []).filter(ph => {
      if (ph.date < start || ph.date > end) return false;
      const dow = new Date(ph.date + 'T00:00:00').getDay();
      return dow !== 0 && dow !== 6;
    }).length;
    const deductibleDays = halfDay ? Math.max(0, rawDays - phOverlap) * 0.5 : Math.max(0, rawDays - phOverlap);
    const bookFor   = _holBehalfOf ? _profileUser : S.user;
    const total     = bookFor?.quota?.total_days ?? bookFor?.total_days ?? 0;
    const usedD     = bookFor?.usedDays ?? bookFor?.used_days ?? 0;
    const remaining = Math.max(0, total - usedD);
    const after     = remaining - deductibleDays;
    reqEl.textContent = deductibleDays; reqEl.style.color = 'var(--text)';
    aftEl.textContent = after < 0 ? after : after; aftEl.style.color = after < 0 ? 'var(--red)' : 'var(--text)';
    if (deductibleDays === 0 && rawDays > 0 && warnEl) {
      warnEl.textContent = '⚠ Your selected dates consist entirely of public holidays — no leave days would be deducted.';
      warnEl.classList.remove('hidden');
    }
  } else {
    reqEl.textContent = '—'; reqEl.style.color = 'var(--text-3)';
    aftEl.textContent = '—'; aftEl.style.color = 'var(--text-3)';
  }
}

function setHalfDay(val) {
  ['none','am','pm'].forEach(k => {
    const el = document.getElementById(`hd-${k}`);
    if (el) el.classList.remove('active');
  });
  const activeId = val === 'AM' ? 'hd-am' : val === 'PM' ? 'hd-pm' : 'hd-none';
  const activeEl = document.getElementById(activeId);
  if (activeEl) activeEl.classList.add('active');
}

async function submitHoliday() {
  const start = document.getElementById('hol-start')?.value;
  const end   = document.getElementById('hol-end')?.value;
  const type  = document.getElementById('hol-type')?.value;
  const notes = document.getElementById('hol-notes')?.value;
  const errEl = document.getElementById('hol-err');
  const btn   = document.getElementById('hol-submit');

  if (!start || !end) {
    errEl.textContent = 'Please select start and end dates.';
    return errEl.classList.remove('hidden');
  }
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Submitting…`;

  try {
    const halfDay = document.getElementById('hd-am')?.classList.contains('active') ? 'AM'
                  : document.getElementById('hd-pm')?.classList.contains('active') ? 'PM' : null;
    const body = { start_date: start, end_date: end, type, notes };
    if (halfDay) body.half_day = halfDay;
    if (_holBehalfOf) body.on_behalf_of = _holBehalfOf;
    await api('POST', '/holidays', body);
    closeModal();
    toast(_holBehalfOf ? 'Holiday booked successfully' : 'Holiday request submitted successfully');
    _holBehalfOf = null;
    await loadMe();
    navigate(S.view);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.innerHTML = `${iCalendar(14)} Submit Request`;
  }
}

async function cancelHoliday(id) {
  if (!confirm('Cancel this holiday request?')) return;
  try {
    await api('DELETE', `/holidays/${id}`);
    toast('Holiday request cancelled');
    await loadMe();
    navigate(S.view);
  } catch (err) { toast(err.message, 'error'); }
}

// ─── User Modal ───────────────────────────────────────────────────────────────

function setStaffTeamFilter(team) { S.staffTeamFilter = team || null; renderStaffTabContent(); }

function openUserModal(userId) {
  const user   = userId ? S.allUsers.find(u => u.id === userId) : null;
  const isEdit = !!user;

  // Seed the modal team selection from the user's current teams
  _modalTeams = user?.teams ? [...user.teams] : [];

  const quotaReadOnly = S.user.role === 'manager' && (user?.role === 'manager' || user?.role === 'admin');

  showModal(`
    <div class="modal-header">
      <span class="modal-title">${isEdit ? 'Edit Employee' : 'Add Employee'}</span>
      <button class="modal-close" onclick="closeModal()">${iX()}</button>
    </div>
    <div class="modal-body">
      <div class="form-stack">
        <div class="form-row">
          <div class="field">
            <label class="field-label">Full Name</label>
            <input type="text" class="input" id="u-name" value="${escHtml(user?.name || '')}" placeholder="Jane Smith" />
          </div>
          <div class="field">
            <label class="field-label">Email Address</label>
            <input type="email" class="input" id="u-email" value="${escHtml(user?.email || '')}" placeholder="jane@company.com" />
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label class="field-label">${isEdit ? 'New Password' : 'Password'} ${isEdit ? '<span style="color:var(--text-3);font-weight:400">(leave blank to keep)</span>' : ''}</label>
            <input type="password" class="input" id="u-password" placeholder="${isEdit ? 'Leave blank to keep' : 'Min. 8 characters'}" />
          </div>
          ${S.user.role === 'admin'
            ? `<div class="field">
                <label class="field-label">Role</label>
                <select class="select" id="u-role">
                  <option value="employee" ${user?.role === 'employee' ? 'selected' : ''}>Employee</option>
                  <option value="manager"  ${user?.role === 'manager'  ? 'selected' : ''}>Manager</option>
                  <option value="admin"    ${user?.role === 'admin'    ? 'selected' : ''}>Admin</option>
                </select>
               </div>`
            : `<div class="field">
                <label class="field-label">Role</label>
                <div style="padding:8px 0">
                  <span class="badge" style="background:${roleBg(user?.role)};color:${roleColor(user?.role)};border-color:${roleBorder(user?.role)}">${cap(user?.role || 'employee')}</span>
                </div>
                <input type="hidden" id="u-role" value="${user?.role || 'employee'}" />
               </div>`
          }
        </div>
        <div class="field">
          <label class="field-label">Job Title</label>
          <input type="text" class="input" id="u-job-title" value="${escHtml(user?.job_title || '')}" placeholder="e.g. Senior Designer" />
        </div>
        <div class="field">
          <label class="field-label">Annual Leave Allowance (days)${quotaReadOnly ? ' <span style="color:var(--text-3);font-weight:400">(admin only)</span>' : ''}</label>
          <input type="number" class="input" id="u-quota" value="${user?.total_days ?? 25}" min="0" max="365" ${quotaReadOnly ? 'disabled' : ''} />
        </div>
        ${S.user.role === 'admin'
          ? `<div class="field">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;color:var(--text-1)">
                <input type="checkbox" id="u-carry" ${user?.carry_allowed ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer" />
                Allow unused days to carry over to next year
              </label>
            </div>`
          : ''}
        <div class="field">
          <label class="field-label">Teams <span style="color:var(--text-3);font-weight:400">(select all that apply)</span></label>
          <div class="team-picker-box">
            <div class="team-picker-chips" id="modal-team-chips">${renderModalTeamChips()}</div>
            <div class="team-picker-add">
              <input class="input" type="text" id="new-team-input" placeholder="Create new team…"
                onkeydown="if(event.key==='Enter'){event.preventDefault();addModalTeam()}" />
              <button class="btn btn-ghost btn-sm" type="button" onclick="addModalTeam()">Add</button>
            </div>
          </div>
        </div>
        <div id="u-err" class="modal-error hidden"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="u-submit" onclick="submitUser(${userId || 'null'})">
        ${isEdit ? 'Save Changes' : 'Add Employee'}
      </button>
    </div>
  `);

  document.getElementById('u-name').focus();
}

function renderModalTeamChips() {
  // All known teams (both global and any newly added in this modal session)
  const allKnown = [...new Set([...S.allTeams, ..._modalTeams])].sort();
  if (allKnown.length === 0) return `<span style="font-size:12px;color:var(--text-3)">No teams yet — type a name below to create one.</span>`;
  return allKnown.map(t => {
    const active = _modalTeams.includes(t);
    return `<button type="button" class="team-chip ${active ? 'active' : ''}" onclick="toggleModalTeam('${escHtml(t).replace(/'/g,"\\'")}')">
      ${escHtml(t)}${active ? ' ✓' : ''}
    </button>`;
  }).join('');
}

function toggleModalTeam(name) {
  if (_modalTeams.includes(name)) {
    _modalTeams = _modalTeams.filter(t => t !== name);
  } else {
    _modalTeams.push(name);
  }
  document.getElementById('modal-team-chips').innerHTML = renderModalTeamChips();
}

function addModalTeam() {
  const input = document.getElementById('new-team-input');
  const name  = input?.value.trim();
  if (!name) return;
  if (!_modalTeams.includes(name)) _modalTeams.push(name);
  if (!S.allTeams.includes(name))  S.allTeams.push(name);
  if (input) input.value = '';
  document.getElementById('modal-team-chips').innerHTML = renderModalTeamChips();
}

async function submitUser(userId) {
  const name        = document.getElementById('u-name')?.value.trim();
  const email       = document.getElementById('u-email')?.value.trim();
  const password    = document.getElementById('u-password')?.value;
  const role        = document.getElementById('u-role')?.value;
  const job_title   = document.getElementById('u-job-title')?.value.trim() || '';
  const quotaEl     = document.getElementById('u-quota');
  const total_days  = quotaEl?.disabled ? undefined : (parseInt(quotaEl?.value) || 0);
  const carryEl     = document.getElementById('u-carry');
  const carry_allowed = carryEl !== null ? (carryEl.checked ? 1 : 0) : undefined;
  const errEl       = document.getElementById('u-err');
  const btn         = document.getElementById('u-submit');

  if (!name || !email) {
    errEl.textContent = 'Name and email are required.';
    return errEl.classList.remove('hidden');
  }
  if (!userId && !password) {
    errEl.textContent = 'Password is required for new employees.';
    return errEl.classList.remove('hidden');
  }
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Saving…`;

  try {
    const body = { name, email, role, job_title, teams: _modalTeams };
    if (total_days !== undefined) body.total_days = total_days;
    if (carry_allowed !== undefined) body.carry_allowed = carry_allowed;
    if (password) body.password = password;

    if (userId) {
      const updated = await api('PATCH', `/users/${userId}`, body);
      const idx = S.allUsers.findIndex(u => u.id === userId);
      if (idx >= 0) S.allUsers[idx] = updated;
    } else {
      const created = await api('POST', '/users', body);
      S.allUsers.push(created);
    }

    // Refresh global team list in case new teams were created
    S.allTeams = await api('GET', '/teams');

    closeModal();
    toast(userId ? 'Employee updated successfully' : 'Employee added successfully');
    renderStaffTabContent();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.innerHTML = userId ? 'Save Changes' : 'Add Employee';
  }
}

async function deleteUser(id, name) {
  if (!confirm(`Remove ${name} from the system? This will also delete all their holiday data.`)) return;
  try {
    await api('DELETE', `/users/${id}`);
    S.allUsers = S.allUsers.filter(u => u.id !== id);
    toast(`${name} removed`);
    renderStaffTabContent();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── View: User Profile ───────────────────────────────────────────────────────

function goToUserProfile(userId) {
  S.selectedUserId = userId;
  navigate('user-profile');
}

async function viewUserProfile() {
  if (!isPriv() || !S.selectedUserId) return navigate('staff');
  const main = document.getElementById('main-content');
  main.innerHTML = `<div class="loading-view"><div class="spinner dark"></div></div>`;

  const { user, holidays } = await api('GET', `/users/${S.selectedUserId}/profile`);
  _profileUser = user;
  _profileHolidays = holidays;

  const total     = user.total_days ?? 0;
  const used      = user.used_days ?? 0;
  const remaining = Math.max(0, total - used);
  const pct       = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;

  const sorted  = [...holidays].sort((a, b) => b.start_date.localeCompare(a.start_date));
  const pending = sorted.filter(h => h.status === 'pending').length;

  main.innerHTML = `
    <div class="profile-header">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="navigate('staff')">${iArrowLeft()} Back to Staff</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${S.user.role === 'admin' ? `<button class="btn btn-secondary" onclick="printUserSummary()">&#128438; Print Summary</button>` : ''}
        <button class="btn btn-primary" onclick="openHolidayModal(${user.id})">${iPlus()} Book Holiday</button>
      </div>
    </div>

    <div class="profile-card">
      <div class="profile-user">
        <div class="avatar profile-avatar" style="background:${user.avatar_color}">${initials(user.name)}</div>
        <div class="profile-user-info">
          <h2 class="profile-name">${escHtml(user.name)}</h2>
          <div class="profile-meta">
            <span class="badge" style="background:${roleBg(user.role)};color:${roleColor(user.role)};border-color:${roleBorder(user.role)}">${cap(user.role)}</span>
            ${user.job_title ? `<span style="color:var(--text-2)">${escHtml(user.job_title)}</span> &middot; ` : ''}${escHtml(user.email)}
          </div>
          ${(user.teams || []).length > 0 ? `
          <div class="profile-teams">
            ${user.teams.map(t => `<span class="team-tag-sm">${escHtml(t)}</span>`).join('')}
          </div>` : ''}
        </div>
      </div>
      <div class="profile-stats">
        <div class="profile-stat">
          <div class="profile-stat-value">${total}</div>
          <div class="profile-stat-label">Allowance</div>
        </div>
        <div class="profile-stat-sep"></div>
        <div class="profile-stat">
          <div class="profile-stat-value" style="color:var(--green)">${remaining}</div>
          <div class="profile-stat-label">Remaining</div>
        </div>
        <div class="profile-stat-sep"></div>
        <div class="profile-stat">
          <div class="profile-stat-value">${used}</div>
          <div class="profile-stat-label">Used</div>
        </div>
        <div class="profile-stat-sep"></div>
        <div class="profile-stat">
          <div class="profile-stat-value" style="color:${pending > 0 ? 'var(--amber)' : 'var(--text-3)'}">${pending}</div>
          <div class="profile-stat-label">Pending</div>
        </div>
      </div>
    </div>

    <div class="section" style="margin-top:24px">
      <div class="quota-bar-wrap" style="height:6px;margin-bottom:6px">
        <div class="quota-bar-fill" style="width:${pct}%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-3)">
        <span>${used} days used</span><span>${remaining} days remaining of ${total}</span>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2 class="section-title">Holiday History</h2>
        <span style="font-size:12px;color:var(--text-3)">${sorted.length} request${sorted.length !== 1 ? 's' : ''}</span>
      </div>

      ${sorted.length === 0
        ? `<div class="card"><div class="empty-state">
            <div class="empty-state-icon">📅</div>
            <p class="empty-state-title">No holiday requests</p>
            <p class="empty-state-text">No records found for ${escHtml(user.name)}</p>
           </div></div>`
        : `<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dates</th>
                  <th>Type</th>
                  <th>Days</th>
                  <th>Notes</th>
                  <th>Submitted</th>
                  <th>Status</th>
                  <th>Reviewed by</th>
                  <th style="text-align:right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${sorted.map(h => {
                  const days = countWorkdays(h.start_date, h.end_date, h.half_day);
                  const dayLabel = days === 0.5 ? '½' : days;
                  return `
                    <tr id="prof-row-${h.id}">
                      <td>
                        <span style="font-weight:500">${fmtDateShort(h.start_date)}</span>
                        ${h.half_day ? `<span class="hd-badge">${h.half_day}</span>` : `<span style="color:var(--text-3)"> → </span><span style="font-weight:500">${fmtDateShort(h.end_date)}</span>`}
                      </td>
                      <td><span class="type-pill type-${h.type}">${TYPE_LABELS[h.type] || cap(h.type)}</span></td>
                      <td style="font-weight:600;font-feature-settings:'tnum'">${dayLabel}</td>
                      <td style="color:var(--text-2);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(h.notes) || '—'}</td>
                      <td style="color:var(--text-2);font-size:12.5px">${fmtDateShort(h.requested_at?.split(' ')[0] || '')}</td>
                      <td><span class="badge ${statusBadgeClass(h, S.user?.role)}"><span class="badge-dot"></span>${statusLabel(h, S.user?.role)}</span></td>
                      <td style="font-size:12.5px">${reviewedByCell(h)}</td>
                      <td>
                        <div class="td-actions">
                          ${h.status === 'pending' ? `
                            <button class="btn btn-success btn-sm" onclick="profileReview(${h.id},'approved')">Approve</button>
                            <button class="btn btn-danger btn-sm" onclick="profileReview(${h.id},'rejected')">Reject</button>` : ''}
                          ${h.status !== 'rejected' ? `
                            <button class="btn btn-ghost btn-sm" onclick="profileCancel(${h.id})">Cancel</button>` : ''}
                        </div>
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`
      }
    </div>
  `;
}

function countWorkdays(startStr, endStr) {
  let count = 0;
  const end = new Date(endStr + 'T00:00:00');
  const cur = new Date(startStr + 'T00:00:00');
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function printUserSummary() {
  const user = _profileUser;
  const holidays = _profileHolidays;
  if (!user) return;

  const total     = user.total_days ?? 0;
  const used      = user.used_days ?? 0;
  const remaining = Math.max(0, total - used);
  const teams     = (user.teams || []).join(', ') || '—';
  const sorted    = [...holidays].sort((a, b) => b.start_date.localeCompare(a.start_date));

  const rows = sorted.map(h => `
    <tr>
      <td>${h.type.charAt(0).toUpperCase() + h.type.slice(1)}</td>
      <td>${h.start_date}</td>
      <td>${h.end_date}</td>
      <td>${h.half_day ? 0.5 : countWorkdays(h.start_date, h.end_date)}${h.half_day ? ` (${h.half_day})` : ''}</td>
      <td>${h.status.charAt(0).toUpperCase() + h.status.slice(1)}${h.manager_approved_by_name ? ` · Mgr: ${h.manager_approved_by_name}${h.manager_approved_at ? ` on ${new Date(h.manager_approved_at).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'})}` : ''}` : ''}${h.reviewed_by_name ? ` · ${h.manager_approved_by_name ? 'Admin: ' : ''}${h.reviewed_by_name}${h.reviewed_at ? ` on ${new Date(h.reviewed_at).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'})}` : ''}` : ''}</td>
      <td>${h.notes || ''}</td>
    </tr>`).join('');

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Holiday Summary — ${user.name}</title>
  <style>
    body { font-family: sans-serif; font-size: 12pt; color: #111; margin: 32px; }
    h1 { font-size: 18pt; margin: 0 0 4px; }
    .meta { color: #555; margin-bottom: 24px; font-size: 10pt; }
    .stats { display: flex; gap: 32px; margin-bottom: 28px; }
    .stat { text-align: center; }
    .stat-val { font-size: 22pt; font-weight: 700; }
    .stat-lbl { font-size: 9pt; color: #555; text-transform: uppercase; letter-spacing: .05em; }
    table { border-collapse: collapse; width: 100%; }
    th { background: #f0f0f0; text-align: left; padding: 6px 10px; font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; }
    td { padding: 6px 10px; border-bottom: 1px solid #e0e0e0; font-size: 10pt; }
    @media print { body { margin: 16px; } }
  </style>
</head>
<body>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;border-bottom:2px solid #C41230;padding-bottom:16px">
    <div>
      <div style="font-size:10pt;text-transform:uppercase;letter-spacing:.08em;color:#C41230;font-weight:600;margin-bottom:4px">Holidays Taken Report</div>
      <h1 style="margin:0">${user.name}</h1>
    </div>
    <img src="/PND-logo-red-1.png" style="height:48px;width:auto">
  </div>
  <div class="meta">
    ${user.role.charAt(0).toUpperCase() + user.role.slice(1)}
    ${user.job_title ? ` &middot; ${user.job_title}` : ''}
    &middot; ${user.email}
    &middot; Teams: ${teams}
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-val">${total}</div><div class="stat-lbl">Allowance</div></div>
    <div class="stat"><div class="stat-val">${used}</div><div class="stat-lbl">Used</div></div>
    <div class="stat"><div class="stat-val">${remaining}</div><div class="stat-lbl">Remaining</div></div>
  </div>
  <table>
    <thead><tr><th>Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th><th>Notes</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="color:#888;text-align:center">No holidays on record</td></tr>'}</tbody>
  </table>
  <p style="margin-top:24px;font-size:9pt;color:#999">Generated ${new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</p>
</body>
</html>`);
  win.document.close();
  setTimeout(() => { win.print(); }, 300);
}

async function profileReview(id, status) {
  try {
    await api('PATCH', `/holidays/${id}/status`, { status });
    if (status === 'approved' || status === 'rejected') {
      S.user.pendingCount = Math.max(0, (S.user.pendingCount || 0) - 1);
      renderSidebar();
    }
    toast(`Holiday ${status}`);
    navigate('user-profile');
  } catch (err) { toast(err.message, 'error'); }
}

async function profileCancel(id) {
  if (!confirm('Cancel this holiday request?')) return;
  try {
    await api('DELETE', `/holidays/${id}`);
    toast('Holiday cancelled');
    navigate('user-profile');
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Modal Helpers ────────────────────────────────────────────────────────────

function showModal(html) {
  document.getElementById('modal').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

// ─── Icon SVGs ────────────────────────────────────────────────────────────────

function svg(d, s = 16) {
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">${d}</svg>`;
}

function iDashboard() { return svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'); }
function iCalendar(s = 16) { return svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>', s); }
function iTeam()     { return svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'); }
function iInbox()     { return svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'); }
function iMegaphone() { return svg('<path d="M18 8a2 2 0 0 1 0 4"/><path d="M4 11v2a1 1 0 0 0 1 1h1l2 4a1 1 0 0 0 2 0v-4h2l7-5V6L12 1H9L7 5H5a1 1 0 0 0-1 1v2z"/>'); }
function iUsers()    { return svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'); }
function iLogout()   { return svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>', 14); }
function iChevL()    { return svg('<polyline points="15 18 9 12 15 6"/>', 14); }
function iChevR()    { return svg('<polyline points="9 18 15 12 9 6"/>', 14); }
function iPlus(s=14)   { return svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', s); }
function iX()          { return svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 14); }
function iArrowLeft()  { return svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>', 14); }
function iPerson()     { return svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', 14); }

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  if (S.token) {
    try {
      await loadMe();
      showApp();
      navigate('dashboard');
    } catch {
      S.token = null;
      localStorage.removeItem('ht_token');
      showLogin();
    }
  } else {
    showLogin();
  }
}

init();
