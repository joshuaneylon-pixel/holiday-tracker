const request = require('supertest');
const { createTestEnv } = require('./setup');

let env;
beforeEach(async () => { env = await createTestEnv(); });

describe('PUT /api/quotas/:userId', () => {
  test('admin can update a user quota', async () => {
    const res = await request(env.app)
      .put(`/api/quotas/${env.emp.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ total_days: 30 });
    expect(res.status).toBe(200);
    expect(res.body.total_days).toBe(30);
  });

  test('manager can update quota for team member', async () => {
    const res = await request(env.app)
      .put(`/api/quotas/${env.emp.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ total_days: 20 });
    expect(res.status).toBe(200);
    expect(res.body.total_days).toBe(20);
  });

  test('manager cannot update quota for user outside team', async () => {
    const res = await request(env.app)
      .put(`/api/quotas/${env.emp2.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ total_days: 30 });
    expect(res.status).toBe(403);
  });

  test('employee cannot update quotas', async () => {
    const res = await request(env.app)
      .put(`/api/quotas/${env.emp.id}`)
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ total_days: 100 });
    expect(res.status).toBe(403);
  });
});

describe('Working days calculation', () => {
  // Approve a holiday directly in the DB then check used_days via GET /api/auth/me
  function approveHoliday(db, holidayId, reviewerId) {
    db.prepare(`UPDATE holidays SET status='approved', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?`)
      .run(reviewerId, holidayId);
  }

  test('Mon-Fri week counts as 5 working days', async () => {
    // 2026-08-03 (Mon) to 2026-08-07 (Fri) = 5 working days
    const createRes = await request(env.app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ start_date: '2026-08-03', end_date: '2026-08-07', type: 'annual' });
    expect(createRes.status).toBe(201);
    approveHoliday(env.db, createRes.body.id, env.admin.id);

    const meRes = await request(env.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(meRes.body.usedDays).toBe(5);
  });

  test('weekend days are not counted', async () => {
    // 2026-08-07 (Fri) to 2026-08-10 (Mon) = 2 working days (Fri + Mon)
    const createRes = await request(env.app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ start_date: '2026-08-07', end_date: '2026-08-10', type: 'annual' });
    approveHoliday(env.db, createRes.body.id, env.admin.id);

    const meRes = await request(env.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(meRes.body.usedDays).toBe(2);
  });

  test('single day counts as 1 working day', async () => {
    const createRes = await request(env.app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ start_date: '2026-08-04', end_date: '2026-08-04', type: 'annual' });
    approveHoliday(env.db, createRes.body.id, env.admin.id);

    const meRes = await request(env.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(meRes.body.usedDays).toBe(1);
  });

  test('pending holidays do not count toward used days', async () => {
    await request(env.app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ start_date: '2026-08-04', end_date: '2026-08-08', type: 'annual' });
    // Not approved — used_days should still be 0
    const meRes = await request(env.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(meRes.body.usedDays).toBe(0);
  });
});
