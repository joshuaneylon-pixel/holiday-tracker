const request = require('supertest');
const { createTestEnv } = require('./setup');

let env;
beforeEach(async () => { env = await createTestEnv(); });

// Helper: create a public holiday via the API
async function createPH(app, token, overrides = {}) {
  return request(app)
    .post('/api/public-holidays')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Test Holiday', date: '2026-12-25', ...overrides });
}

// ─── GET /api/public-holidays ─────────────────────────────────────────────────

describe('GET /api/public-holidays', () => {
  test('returns empty array when none defined', async () => {
    const res = await request(env.app)
      .get('/api/public-holidays')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns public holidays ordered by date', async () => {
    await createPH(env.app, env.adminToken, { name: 'Christmas', date: '2026-12-25' });
    await createPH(env.app, env.adminToken, { name: 'New Year', date: '2026-01-01' });
    const res = await request(env.app)
      .get('/api/public-holidays')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body[0].date).toBe('2026-01-01');
  });

  test('filters by year', async () => {
    await createPH(env.app, env.adminToken, { name: 'Christmas 2026', date: '2026-12-25' });
    await createPH(env.app, env.adminToken, { name: 'New Year 2027', date: '2027-01-01' });
    const res = await request(env.app)
      .get('/api/public-holidays?year=2026')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Christmas 2026');
  });

  test('requires auth', async () => {
    const res = await request(env.app).get('/api/public-holidays');
    expect(res.status).toBe(401);
  });
});

// ─── POST /api/public-holidays ────────────────────────────────────────────────

describe('POST /api/public-holidays', () => {
  test('admin can add a public holiday', async () => {
    const res = await createPH(env.app, env.adminToken);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test Holiday');
    expect(res.body.date).toBe('2026-12-25');
  });

  test('returns 403 for manager', async () => {
    const res = await createPH(env.app, env.mgrToken);
    expect(res.status).toBe(403);
  });

  test('returns 403 for employee', async () => {
    const res = await createPH(env.app, env.empToken);
    expect(res.status).toBe(403);
  });

  test('returns 400 when name is missing', async () => {
    const res = await createPH(env.app, env.adminToken, { name: undefined, date: '2026-12-25' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when date is missing', async () => {
    const res = await createPH(env.app, env.adminToken, { name: 'Holiday', date: undefined });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid date format', async () => {
    const res = await createPH(env.app, env.adminToken, { name: 'Holiday', date: '25/12/2026' });
    expect(res.status).toBe(400);
  });

  test('returns 409 when date already exists', async () => {
    await createPH(env.app, env.adminToken);
    const res = await createPH(env.app, env.adminToken, { name: 'Another Holiday' });
    expect(res.status).toBe(409);
  });
});

// ─── DELETE /api/public-holidays/:id ─────────────────────────────────────────

describe('DELETE /api/public-holidays/:id', () => {
  test('admin can delete a public holiday', async () => {
    const ph = (await createPH(env.app, env.adminToken)).body;
    const res = await request(env.app)
      .delete(`/api/public-holidays/${ph.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('returns 403 for employee', async () => {
    const ph = (await createPH(env.app, env.adminToken)).body;
    const res = await request(env.app)
      .delete(`/api/public-holidays/${ph.id}`)
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(403);
  });

  test('returns 404 for unknown id', async () => {
    const res = await request(env.app)
      .delete('/api/public-holidays/99999')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/holidays — public holiday deduction ────────────────────────────

describe('POST /api/holidays — public holiday interaction', () => {
  test('rejects a request where all dates are public holidays (single weekday)', async () => {
    // 2026-12-25 is a Friday
    await createPH(env.app, env.adminToken, { name: 'Christmas', date: '2026-12-25' });
    const res = await request(env.app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ start_date: '2026-12-25', end_date: '2026-12-25', type: 'annual' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/public holiday/i);
  });

  test('accepts a request where only some dates are public holidays', async () => {
    // Book Mon 2026-12-21 → Fri 2026-12-25, with Christmas (Fri) as a PH
    await createPH(env.app, env.adminToken, { name: 'Christmas', date: '2026-12-25' });
    const res = await request(env.app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ start_date: '2026-12-21', end_date: '2026-12-25', type: 'annual' });
    expect(res.status).toBe(201);
  });
});

// ─── GET /api/auth/me — used_days reflects public holiday deduction ───────────

describe('GET /api/auth/me — used_days with public holidays', () => {
  test('approved holiday overlapping a public holiday deducts fewer days', async () => {
    // Approve a 5-workday holiday (Mon 2026-08-03 to Fri 2026-08-07)
    const hRes = await request(env.app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ start_date: '2026-08-03', end_date: '2026-08-07', type: 'annual' });
    const hId = hRes.body.id;

    await request(env.app)
      .patch(`/api/holidays/${hId}/status`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ status: 'approved' });

    // Without PH: 5 days used
    const before = await request(env.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(before.body.usedDays).toBe(5);

    // Add a PH on Wednesday 2026-08-05 (inside that range)
    await createPH(env.app, env.adminToken, { name: 'Summer Bank Holiday', date: '2026-08-05' });

    // Now: 4 days used
    const after = await request(env.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(after.body.usedDays).toBe(4);
  });

  test('approved holiday with no PH overlap is unchanged', async () => {
    const hRes = await request(env.app)
      .post('/api/holidays')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ start_date: '2026-08-03', end_date: '2026-08-07', type: 'annual' });
    const hId = hRes.body.id;

    await request(env.app)
      .patch(`/api/holidays/${hId}/status`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ status: 'approved' });

    // PH outside the holiday range
    await createPH(env.app, env.adminToken, { name: 'Christmas', date: '2026-12-25' });

    const res = await request(env.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.body.usedDays).toBe(5);
  });
});

// ─── GET /api/holidays/team — includes public holiday pseudo-events ───────────

describe('GET /api/holidays/team — public holiday pseudo-events', () => {
  test('includes public holidays when querying by date', async () => {
    await createPH(env.app, env.adminToken, { name: 'Christmas', date: '2026-12-25' });
    const res = await request(env.app)
      .get('/api/holidays/team?date=2026-12-25')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(200);
    const ph = res.body.find(h => h.is_public_holiday);
    expect(ph).toBeDefined();
    expect(ph.user_name).toBe('Christmas');
    expect(ph.type).toBe('public_holiday');
  });

  test('includes public holidays when querying by year/month', async () => {
    await createPH(env.app, env.adminToken, { name: 'Christmas', date: '2026-12-25' });
    const res = await request(env.app)
      .get('/api/holidays/team?year=2026&month=12')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(200);
    const ph = res.body.find(h => h.is_public_holiday);
    expect(ph).toBeDefined();
  });
});
