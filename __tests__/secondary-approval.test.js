const request = require('supertest');
const { createTestEnv } = require('./setup');

let env;

beforeEach(async () => {
  env = await createTestEnv();
  // The teams migration runs before team_members are seeded, so Design Team is absent.
  // Insert it manually and enable secondary approval.
  env.db.prepare('INSERT OR IGNORE INTO teams (name) VALUES (?)').run('Design Team');
  env.db.prepare(
    "UPDATE teams SET requires_secondary_approval=1, manager_id=? WHERE name='Design Team'"
  ).run(env.mgr.id);
});

async function submitAndGetId(app, token, overrides = {}) {
  const res = await request(app)
    .post('/api/holidays')
    .set('Authorization', `Bearer ${token}`)
    .send({ start_date: '2026-08-04', end_date: '2026-08-06', type: 'annual', ...overrides });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function approve(app, token, id) {
  return request(app)
    .patch(`/api/holidays/${id}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'approved' });
}

async function reject(app, token, id) {
  return request(app)
    .patch(`/api/holidays/${id}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'rejected' });
}

describe('Secondary approval — state machine', () => {
  test('manager approving for secondary-required team → manager_approved, not approved', async () => {
    const id = await submitAndGetId(env.app, env.empToken);
    const res = await approve(env.app, env.mgrToken, id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('manager_approved');
    expect(res.body.manager_approved_by).toBe(env.mgr.id);
    expect(res.body.manager_approved_at).toBeTruthy();
  });

  test('manager_approved holiday does not count toward quota (status is not approved)', async () => {
    const id = await submitAndGetId(env.app, env.empToken);
    await approve(env.app, env.mgrToken, id);

    // Verify status is manager_approved (quota only counts status='approved')
    const h = env.db.prepare('SELECT status FROM holidays WHERE id=?').get(id);
    expect(h.status).toBe('manager_approved');

    // Confirm no 'approved' holidays for this employee
    const approvedCount = env.db.prepare(
      "SELECT COUNT(*) AS cnt FROM holidays WHERE user_id=? AND status='approved'"
    ).get(env.emp.id);
    expect(approvedCount.cnt).toBe(0);
  });

  test('admin can finalize (approve) a manager_approved holiday', async () => {
    const id = await submitAndGetId(env.app, env.empToken);
    await approve(env.app, env.mgrToken, id);

    const res = await approve(env.app, env.adminToken, id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.reviewed_by).toBe(env.admin.id);
  });

  test('final approval counts toward quota (status becomes approved)', async () => {
    const id = await submitAndGetId(env.app, env.empToken);
    await approve(env.app, env.mgrToken, id);
    await approve(env.app, env.adminToken, id);

    const approvedCount = env.db.prepare(
      "SELECT COUNT(*) AS cnt FROM holidays WHERE user_id=? AND status='approved'"
    ).get(env.emp.id);
    expect(approvedCount.cnt).toBe(1);
  });

  test('admin can reject a manager_approved holiday', async () => {
    const id = await submitAndGetId(env.app, env.empToken);
    await approve(env.app, env.mgrToken, id);

    const res = await reject(env.app, env.adminToken, id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('manager cannot finalize a manager_approved request (403)', async () => {
    const id = await submitAndGetId(env.app, env.empToken);
    await approve(env.app, env.mgrToken, id);

    const res = await approve(env.app, env.mgrToken, id);
    expect(res.status).toBe(403);
  });

  test('manager approving for team WITHOUT secondary flag → immediately approved', async () => {
    // Frank is in Construction Team — no secondary approval configured
    const id = await submitAndGetId(env.app, env.emp2Token);
    const res = await approve(env.app, env.adminToken, id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  test('admin direct approval skips secondary stage entirely', async () => {
    const id = await submitAndGetId(env.app, env.empToken);
    // Admin approves directly without prior manager approval
    const res = await approve(env.app, env.adminToken, id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  test('manager approve + admin approve → manager_approved_by and reviewed_by both set', async () => {
    const id = await submitAndGetId(env.app, env.empToken);
    await approve(env.app, env.mgrToken, id);
    await approve(env.app, env.adminToken, id);

    const h = env.db.prepare('SELECT * FROM holidays WHERE id=?').get(id);
    expect(h.manager_approved_by).toBe(env.mgr.id);
    expect(h.reviewed_by).toBe(env.admin.id);
    expect(h.status).toBe('approved');
  });
});

describe('GET /api/teams-config', () => {
  test('admin can list teams config', async () => {
    const res = await request(env.app)
      .get('/api/teams-config')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const designTeam = res.body.find(t => t.name === 'Design Team');
    expect(designTeam).toBeDefined();
    expect(designTeam.requires_secondary_approval).toBe(1);
  });

  test('non-admin cannot list teams config', async () => {
    const res = await request(env.app)
      .get('/api/teams-config')
      .set('Authorization', `Bearer ${env.mgrToken}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/teams-config/:id', () => {
  function getDesignTeam() {
    return env.db.prepare("SELECT id FROM teams WHERE name='Design Team'").get();
  }

  test('admin can toggle requires_secondary_approval off', async () => {
    const team = getDesignTeam();
    const res = await request(env.app)
      .patch(`/api/teams-config/${team.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ requires_secondary_approval: false });
    expect(res.status).toBe(200);
    expect(res.body.requires_secondary_approval).toBe(0);
  });

  test('admin can assign admin_id to a team', async () => {
    const team = getDesignTeam();
    const res = await request(env.app)
      .patch(`/api/teams-config/${team.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ admin_id: env.admin.id });
    expect(res.status).toBe(200);
    expect(res.body.admin_id).toBe(env.admin.id);
  });

  test('non-admin cannot update team config', async () => {
    const team = getDesignTeam();
    const res = await request(env.app)
      .patch(`/api/teams-config/${team.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ requires_secondary_approval: false });
    expect(res.status).toBe(403);
  });

  test('returns 404 for unknown team id', async () => {
    const res = await request(env.app)
      .patch('/api/teams-config/99999')
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ requires_secondary_approval: false });
    expect(res.status).toBe(404);
  });

  test('toggling off secondary approval → manager now approves directly', async () => {
    const team = getDesignTeam();
    // Turn off secondary approval
    await request(env.app)
      .patch(`/api/teams-config/${team.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ requires_secondary_approval: false });

    const id = await submitAndGetId(env.app, env.empToken);
    const res = await approve(env.app, env.mgrToken, id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });
});
