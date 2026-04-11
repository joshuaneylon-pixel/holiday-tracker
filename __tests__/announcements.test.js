const request = require('supertest');
const { createTestEnv } = require('./setup');

let env;
beforeEach(async () => { env = await createTestEnv(); });

describe('GET /api/announcements', () => {
  test('returns empty array when no announcements exist', async () => {
    const res = await request(env.app)
      .get('/api/announcements')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns announcements after one is created', async () => {
    await request(env.app)
      .post('/api/announcements')
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ title: 'Hello', message: 'World' });

    const res = await request(env.app)
      .get('/api/announcements')
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].title).toBe('Hello');
    expect(res.body[0].author_name).toBeDefined();
  });

  test('unauthenticated request is rejected', async () => {
    const res = await request(env.app).get('/api/announcements');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/announcements', () => {
  test('admin can create an announcement', async () => {
    const res = await request(env.app)
      .post('/api/announcements')
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ title: 'Test Title', message: 'Test message body' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('Test Title');
    expect(res.body.message).toBe('Test message body');
    expect(res.body.created_by).toBe(env.admin.id);
  });

  test('rejects missing title', async () => {
    const res = await request(env.app)
      .post('/api/announcements')
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ message: 'No title here' });
    expect(res.status).toBe(400);
  });

  test('rejects missing message', async () => {
    const res = await request(env.app)
      .post('/api/announcements')
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ title: 'No message here' });
    expect(res.status).toBe(400);
  });

  test('employee cannot create announcement', async () => {
    const res = await request(env.app)
      .post('/api/announcements')
      .set('Authorization', `Bearer ${env.empToken}`)
      .send({ title: 'Hi', message: 'Unauthorised' });
    expect(res.status).toBe(403);
  });

  test('manager cannot create announcement', async () => {
    const res = await request(env.app)
      .post('/api/announcements')
      .set('Authorization', `Bearer ${env.mgrToken}`)
      .send({ title: 'Hi', message: 'Unauthorised' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/announcements/:id', () => {
  async function createAnnouncement() {
    const res = await request(env.app)
      .post('/api/announcements')
      .set('Authorization', `Bearer ${env.adminToken}`)
      .send({ title: 'To delete', message: 'Bye' });
    return res.body;
  }

  test('admin can delete an announcement', async () => {
    const ann = await createAnnouncement();
    const res = await request(env.app)
      .delete(`/api/announcements/${ann.id}`)
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify it's gone
    const listRes = await request(env.app)
      .get('/api/announcements')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(listRes.body.length).toBe(0);
  });

  test('returns 404 for non-existent announcement', async () => {
    const res = await request(env.app)
      .delete('/api/announcements/99999')
      .set('Authorization', `Bearer ${env.adminToken}`);
    expect(res.status).toBe(404);
  });

  test('employee cannot delete announcement', async () => {
    const ann = await createAnnouncement();
    const res = await request(env.app)
      .delete(`/api/announcements/${ann.id}`)
      .set('Authorization', `Bearer ${env.empToken}`);
    expect(res.status).toBe(403);
  });

  test('manager cannot delete announcement', async () => {
    const ann = await createAnnouncement();
    const res = await request(env.app)
      .delete(`/api/announcements/${ann.id}`)
      .set('Authorization', `Bearer ${env.mgrToken}`);
    expect(res.status).toBe(403);
  });
});
