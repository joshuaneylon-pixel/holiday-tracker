const request = require('supertest');
const { createTestEnv } = require('./setup');

let env;
beforeEach(async () => { env = await createTestEnv(); });

describe('POST /api/auth/login', () => {
  test('returns token on valid credentials', async () => {
    const res = await request(env.app)
      .post('/api/auth/login')
      .send({ email: 'admin@company.com', password: 'Admin123!' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('admin');
  });

  test('rejects wrong password', async () => {
    const res = await request(env.app)
      .post('/api/auth/login')
      .send({ email: 'admin@company.com', password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  test('rejects unknown email', async () => {
    const res = await request(env.app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'Admin123!' });
    expect(res.status).toBe(401);
  });

  test('rejects missing fields', async () => {
    const res = await request(env.app)
      .post('/api/auth/login')
      .send({ email: 'admin@company.com' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /api/auth/me', () => {
  test('returns current user with valid token', async () => {
    const res = await request(env.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('admin@company.com');
  });

  test('rejects request with no token', async () => {
    const res = await request(env.app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('rejects invalid token', async () => {
    const res = await request(env.app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalidtoken');
    expect(res.status).toBe(401);
  });
});
