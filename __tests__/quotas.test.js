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

  test('manager cannot update their own quota', async () => {
    const res = await request(env.app)
      .put(`/api/quotas/${env.mgr.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ total_days: 30 });
    expect(res.status).toBe(403);
  });

  test('manager cannot update another manager\'s quota', async () => {
    // Create a second manager via admin
    const created = await request(env.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ name: 'Manager Two', email: 'mgr2@test.com', password: 'Manager2!', role: 'manager', teams: ['Design Team'] });
    expect(created.status).toBe(201);

    const res = await request(env.app)
      .put(`/api/quotas/${created.body.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ total_days: 30 });
    expect(res.status).toBe(403);
  });

  test('admin can update a manager\'s quota', async () => {
    const res = await request(env.app)
      .put(`/api/quotas/${env.mgr.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ total_days: 28 });
    expect(res.status).toBe(200);
    expect(res.body.total_days).toBe(28);
  });
});

describe('PATCH /api/users/:id quota restriction', () => {
  test('manager cannot update their own allowance via PATCH', async () => {
    const res = await request(env.app)
      .patch(`/api/users/${env.mgr.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ total_days: 30 });
    expect(res.status).toBe(403);
  });

  test('admin can update a manager\'s allowance via PATCH', async () => {
    const res = await request(env.app)
      .patch(`/api/users/${env.mgr.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ total_days: 28 });
    expect(res.status).toBe(200);
    expect(res.body.total_days).toBe(28);
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

describe('Annual reset', () => {
  const currentYear = new Date().getFullYear();
  const prevYear    = currentYear - 1;

  function backdateReset(db, userId) {
    db.prepare('UPDATE quotas SET last_reset_year = ? WHERE user_id = ?').run(prevYear - 1, userId);
  }

  function insertApprovedHoliday(db, userId, reviewerId, startDate, endDate) {
    db.prepare(
      `INSERT INTO holidays (user_id, start_date, end_date, type, status, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, 'annual', 'approved', ?, datetime('now'))`
    ).run(userId, startDate, endDate, reviewerId);
  }

  test('non-carry-over user resets to base_days', () => {
    env.db.prepare('UPDATE quotas SET total_days=30, base_days=25, carry_allowed=0 WHERE user_id=?').run(env.emp.id);
    backdateReset(env.db, env.emp.id);

    env.performAnnualReset();

    const quota = env.db.prepare('SELECT total_days, last_reset_year FROM quotas WHERE user_id=?').get(env.emp.id);
    expect(quota.total_days).toBe(25);
    expect(quota.last_reset_year).toBe(currentYear);
  });

  test('carry-over user gets base_days plus remaining days from previous year', () => {
    // 25 base days, used 4 last year (Mon–Thu) → 21 remaining carry over
    env.db.prepare('UPDATE quotas SET total_days=25, base_days=25, carry_allowed=1 WHERE user_id=?').run(env.emp.id);
    backdateReset(env.db, env.emp.id);
    insertApprovedHoliday(env.db, env.emp.id, env.admin.id, `${prevYear}-08-04`, `${prevYear}-08-07`);

    env.performAnnualReset();

    const quota = env.db.prepare('SELECT total_days FROM quotas WHERE user_id=?').get(env.emp.id);
    expect(quota.total_days).toBe(46); // 25 base + 21 remaining
  });

  test('carry-over user with no remaining days resets to base_days only', () => {
    // Used all 25 days (5 full weeks); remaining = 0 so no carry-over bonus
    env.db.prepare('UPDATE quotas SET total_days=25, base_days=25, carry_allowed=1 WHERE user_id=?').run(env.emp.id);
    backdateReset(env.db, env.emp.id);
    insertApprovedHoliday(env.db, env.emp.id, env.admin.id, `${prevYear}-07-07`, `${prevYear}-08-08`);

    env.performAnnualReset();

    const quota = env.db.prepare('SELECT total_days FROM quotas WHERE user_id=?').get(env.emp.id);
    expect(quota.total_days).toBe(25);
  });

  test('reset is idempotent: running twice in the same year does not compound carry-over', () => {
    env.db.prepare('UPDATE quotas SET total_days=25, base_days=25, carry_allowed=1 WHERE user_id=?').run(env.emp.id);
    backdateReset(env.db, env.emp.id);
    insertApprovedHoliday(env.db, env.emp.id, env.admin.id, `${prevYear}-08-04`, `${prevYear}-08-07`); // 4 days used

    env.performAnnualReset(); // first run: 25 + 21 = 46
    env.performAnnualReset(); // second run: last_reset_year already = currentYear, no change

    const quota = env.db.prepare('SELECT total_days FROM quotas WHERE user_id=?').get(env.emp.id);
    expect(quota.total_days).toBe(46);
  });

  test('user with last_reset_year already set to current year is not affected', () => {
    env.db.prepare('UPDATE quotas SET total_days=25, base_days=25, carry_allowed=1, last_reset_year=? WHERE user_id=?').run(currentYear, env.emp.id);

    env.performAnnualReset();

    const quota = env.db.prepare('SELECT total_days FROM quotas WHERE user_id=?').get(env.emp.id);
    expect(quota.total_days).toBe(25);
  });

  test('admin can enable carry_allowed via PUT /api/quotas/:userId', async () => {
    const res = await request(env.app)
      .put(`/api/quotas/${env.emp.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ carry_allowed: 1 });
    expect(res.status).toBe(200);
    expect(res.body.carry_allowed).toBe(1);
  });

  test('manager cannot set carry_allowed via PUT /api/quotas/:userId', async () => {
    const res = await request(env.app)
      .put(`/api/quotas/${env.emp.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ carry_allowed: 1 });
    expect(res.status).toBe(403);
  });
});
