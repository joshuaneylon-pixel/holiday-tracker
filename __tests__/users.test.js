const request = require('supertest');
const { createTestEnv } = require('./setup');

let env;
beforeEach(async () => { env = await createTestEnv(); });

describe('GET /api/users', () => {
  test('admin can list all users', async () => {
    const res = await request(env.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4); // admin + mgr + emp + emp2
  });

  test('manager sees only their team members', async () => {
    const res = await request(env.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${env.mgrToken}`);
    expect(res.status).toBe(200);
    const emails = res.body.map(u => u.email);
    expect(emails).toContain('employee@test.com');
    expect(emails).not.toContain('frank@test.com'); // different team
  });

  test('employee cannot list users', async () => {
    const res = await request(env.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(403);
  });

  test('unauthenticated request is rejected', async () => {
    const res = await request(env.app).get('/api/users');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/users', () => {
  test('admin can create a new user', async () => {
    const res = await request(env.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ name: 'New User', email: 'new@test.com', password: 'NewPass1!', role: 'employee' });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('new@test.com');
  });

  test('rejects duplicate email', async () => {
    const res = await request(env.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ name: 'Dup', email: 'employee@test.com', password: 'Pass1!', role: 'employee' });
    expect(res.status).toBe(409);
  });

  test('employee cannot create users', async () => {
    const res = await request(env.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ name: 'X', email: 'x@test.com', password: 'Pass1!', role: 'employee' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/users/:id', () => {
  test('admin can update any user name', async () => {
    const res = await request(env.app)
      .patch(`/api/users/${env.emp.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });

  test('manager can update team member', async () => {
    const res = await request(env.app)
      .patch(`/api/users/${env.emp.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ name: 'Manager Updated' });
    expect(res.status).toBe(200);
  });

  test('manager cannot update user outside their team', async () => {
    const res = await request(env.app)
      .patch(`/api/users/${env.emp2.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ name: 'Hacked' });
    expect(res.status).toBe(403);
  });

  test('employee cannot update another user', async () => {
    const res = await request(env.app)
      .patch(`/api/users/${env.emp2.id}`)
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ name: 'Hacked' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/users/:id', () => {
  test('admin can delete a user', async () => {
    const res = await request(env.app)
      .delete(`/api/users/${env.emp2.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
  });

  test('admin cannot delete themselves', async () => {
    const res = await request(env.app)
      .delete(`/api/users/${env.admin.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(400);
  });

  test('employee cannot delete users', async () => {
    const res = await request(env.app)
      .delete(`/api/users/${env.emp2.id}`)
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(403);
  });
});
