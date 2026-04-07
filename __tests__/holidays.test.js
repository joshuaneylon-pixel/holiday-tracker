const request = require('supertest');
const { createTestEnv } = require('./setup');

let env;
beforeEach(async () => { env = await createTestEnv(); });

// Helper: create a holiday request for a given user token
async function submitHoliday(app, token, overrides = {}) {
  return request(app)
    .post('/api/holidays')
    .set('Authorization', `Bearer ${token}`)
    .send({ start_date: '2026-08-04', end_date: '2026-08-06', type: 'annual', ...overrides });
}

// Helper: get the first holiday ID for a given user
function firstHolidayId(db, userId) {
  return db.prepare('SELECT id FROM holidays WHERE user_id = ? LIMIT 1').get(userId)?.id;
}

describe('POST /api/holidays', () => {
  test('employee can submit a holiday request', async () => {
    const res = await submitHoliday(env.app, env.empToken);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
  });

  test('admin can book on behalf of another user', async () => {
    const res = await submitHoliday(env.app, env.adminToken, { on_behalf_of: env.emp.id });
    expect(res.status).toBe(201);
  });

  test('manager can book on behalf of team member', async () => {
    const res = await submitHoliday(env.app, env.mgrToken, { on_behalf_of: env.emp.id });
    expect(res.status).toBe(201);
  });

  test('manager cannot book on behalf of user outside team', async () => {
    const res = await submitHoliday(env.app, env.mgrToken, { on_behalf_of: env.emp2.id });
    expect(res.status).toBe(403);
  });

  test('employee cannot book on behalf of another user', async () => {
    const res = await submitHoliday(env.app, env.empToken, { on_behalf_of: env.emp2.id });
    expect(res.status).toBe(403);
  });

  test('rejects missing dates', async () => {
    const res = await request(env.app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ type: 'annual' });
    expect(res.status).toBe(400);
  });

  test('rejects end date before start date', async () => {
    const res = await submitHoliday(env.app, env.empToken, {
      start_date: '2026-08-10', end_date: '2026-08-05'
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/holidays/:id/status — approve/reject', () => {
  let holidayId;
  beforeEach(async () => {
    await submitHoliday(env.app, env.empToken);
    holidayId = firstHolidayId(env.db, env.emp.id);
  });

  test('admin can approve a holiday', async () => {
    const res = await request(env.app)
      .patch(`/api/holidays/${holidayId}/status`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  test('manager can approve team member holiday', async () => {
    const res = await request(env.app)
      .patch(`/api/holidays/${holidayId}/status`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(200);
  });

  test('manager cannot approve holiday for user outside team', async () => {
    await submitHoliday(env.app, env.emp2Token);
    const outId = firstHolidayId(env.db, env.emp2.id);
    const res = await request(env.app)
      .patch(`/api/holidays/${outId}/status`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(403);
  });

  test('employee cannot approve holidays', async () => {
    const res = await request(env.app)
      .patch(`/api/holidays/${holidayId}/status`)
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(403);
  });

  test('admin can reject a holiday', async () => {
    const res = await request(env.app)
      .patch(`/api/holidays/${holidayId}/status`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ status: 'rejected' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });
});

describe('DELETE /api/holidays/:id', () => {
  let holidayId;
  beforeEach(async () => {
    await submitHoliday(env.app, env.empToken);
    holidayId = firstHolidayId(env.db, env.emp.id);
  });

  test('employee can cancel their own pending request', async () => {
    const res = await request(env.app)
      .delete(`/api/holidays/${holidayId}`)
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(200);
  });

  test('employee cannot cancel another user\'s request', async () => {
    await submitHoliday(env.app, env.emp2Token);
    const otherId = firstHolidayId(env.db, env.emp2.id);
    const res = await request(env.app)
      .delete(`/api/holidays/${otherId}`)
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(403);
  });

  test('admin can cancel any request', async () => {
    const res = await request(env.app)
      .delete(`/api/holidays/${holidayId}`)
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/holidays', () => {
  beforeEach(async () => {
    await submitHoliday(env.app, env.empToken);
    await submitHoliday(env.app, env.emp2Token, { start_date: '2026-09-01', end_date: '2026-09-03' });
  });

  test('employee only sees their own holidays', async () => {
    const res = await request(env.app)
      .get('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(200);
    res.body.forEach(h => expect(h.user_id).toBe(env.emp.id));
  });

  test('manager sees only their team holidays', async () => {
    const res = await request(env.app)
      .get('/api/holidays')
      .set('Authorization', `Bearer ${env.mgrToken}`);
    expect(res.status).toBe(200);
    const userIds = [...new Set(res.body.map(h => h.user_id))];
    expect(userIds).not.toContain(env.emp2.id);
  });

  test('admin sees all holidays', async () => {
    const res = await request(env.app)
      .get('/api/holidays')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
    const userIds = res.body.map(h => h.user_id);
    expect(userIds).toContain(env.emp.id);
    expect(userIds).toContain(env.emp2.id);
  });
});
