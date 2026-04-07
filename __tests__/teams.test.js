const request = require('supertest');
const { createTestEnv } = require('./setup');

let env;
beforeEach(async () => { env = await createTestEnv(); });

// Helper: approve a holiday directly in the DB
function approveHoliday(db, holidayId, reviewerId) {
  db.prepare(`UPDATE holidays SET status='approved', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?`)
    .run(reviewerId, holidayId);
}

async function submitAndApprove(app, db, token, adminId, overrides = {}) {
  const res = await request(app)
    .post('/api/holidays')
    .set('Authorization', `Bearer ${token}`)
    .send({ start_date: '2026-08-04', end_date: '2026-08-06', type: 'annual', ...overrides });
  approveHoliday(db, res.body.id, adminId);
  return res.body.id;
}

describe('GET /api/holidays/team — team calendar filtering', () => {
  beforeEach(async () => {
    // emp is in Design Team; also add them to Construction Team
    env.db.prepare('INSERT OR IGNORE INTO team_members (user_id, team) VALUES (?,?)').run(env.emp.id, 'Construction Team');
    // Submit and approve holidays for both employees
    await submitAndApprove(env.app, env.db, env.empToken, env.admin.id);
    await submitAndApprove(env.app, env.db, env.emp2Token, env.admin.id, {
      start_date: '2026-08-11', end_date: '2026-08-13'
    });
  });

  test('user in multiple teams appears on both team calendars', async () => {
    const designRes = await request(env.app)
      .get('/api/holidays/team?team=Design+Team')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(designRes.status).toBe(200);
    const designIds = designRes.body.map(h => h.user_id);
    expect(designIds).toContain(env.emp.id);

    const conRes = await request(env.app)
      .get('/api/holidays/team?team=Construction+Team')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(conRes.status).toBe(200);
    const conIds = conRes.body.map(h => h.user_id);
    expect(conIds).toContain(env.emp.id);   // emp is in both
    expect(conIds).toContain(env.emp2.id);  // emp2 is in Construction
  });

  test('filtering by Design Team excludes Construction-only users', async () => {
    const res = await request(env.app)
      .get('/api/holidays/team?team=Design+Team')
      .set('Authorization', `Bearer ${env.adminToken}`);
    const userIds = res.body.map(h => h.user_id);
    expect(userIds).not.toContain(env.emp2.id);
  });

  test('no team filter returns all approved holidays', async () => {
    const res = await request(env.app)
      .get('/api/holidays/team')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
    const userIds = res.body.map(h => h.user_id);
    expect(userIds).toContain(env.emp.id);
    expect(userIds).toContain(env.emp2.id);
  });

  test('manager only sees their own team holidays', async () => {
    const res = await request(env.app)
      .get('/api/holidays/team')
      .set('Authorization', `Bearer ${env.mgrToken}`);
    expect(res.status).toBe(200);
    const userIds = res.body.map(h => h.user_id);
    // Manager is in Design Team; emp2 is in Construction Team only (before beforeEach adds emp to both)
    // emp2 should NOT appear since they don't share a team with mgr
    userIds.forEach(id => expect(id).not.toBe(env.emp2.id));
  });

  test('each holiday response includes user_teams array', async () => {
    const res = await request(env.app)
      .get('/api/holidays/team')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
    res.body.forEach(h => {
      expect(Array.isArray(h.user_teams)).toBe(true);
    });
    // emp's holiday should list both teams
    const empHol = res.body.find(h => h.user_id === env.emp.id);
    expect(empHol.user_teams).toContain('Design Team');
    expect(empHol.user_teams).toContain('Construction Team');
  });
});

describe('GET /api/teams', () => {
  test('returns all known teams to admin', async () => {
    const res = await request(env.app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Design Team');
    expect(res.body).toContain('Construction Team');
  });

  test('manager sees only their teams', async () => {
    const res = await request(env.app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${env.mgrToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Design Team');
  });
});
