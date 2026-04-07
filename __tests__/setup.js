/**
 * Shared test setup: creates an in-memory DB, seeds users, and returns auth tokens.
 * Uses jest.isolateModules() to get a fresh server+DB instance for each test.
 */

process.env.DB_PATH = ':memory:';

async function createTestEnv() {
  let app, db;

  // jest.isolateModules gives us a truly fresh module (and fresh :memory: DB) each call
  jest.isolateModules(() => {
    ({ app, db } = require('../server'));
  });

  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'ht-secret-change-in-production';

  const hash = (pw) => bcrypt.hashSync(pw, 4); // low rounds for speed

  // Admin was seeded by server init
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();

  // Manager
  const mgr = db.prepare(
    `INSERT INTO users (name, email, password_hash, role, avatar_color) VALUES (?,?,?,'manager','#555') RETURNING *`
  ).get('Manager Mary', 'manager@test.com', hash('Manager1!'));
  db.prepare('INSERT INTO quotas (user_id, total_days) VALUES (?,25)').run(mgr.id);
  db.prepare('INSERT OR IGNORE INTO team_members (user_id, team) VALUES (?,?)').run(mgr.id, 'Design Team');

  // Employee in manager's team
  const emp = db.prepare(
    `INSERT INTO users (name, email, password_hash, role, avatar_color) VALUES (?,?,?,'employee','#888') RETURNING *`
  ).get('Employee Eve', 'employee@test.com', hash('Employee1!'));
  db.prepare('INSERT INTO quotas (user_id, total_days) VALUES (?,25)').run(emp.id);
  db.prepare('INSERT OR IGNORE INTO team_members (user_id, team) VALUES (?,?)').run(emp.id, 'Design Team');

  // Employee outside manager's team
  const emp2 = db.prepare(
    `INSERT INTO users (name, email, password_hash, role, avatar_color) VALUES (?,?,?,'employee','#999') RETURNING *`
  ).get('Employee Frank', 'frank@test.com', hash('Frank1!'));
  db.prepare('INSERT INTO quotas (user_id, total_days) VALUES (?,25)').run(emp2.id);
  db.prepare('INSERT OR IGNORE INTO team_members (user_id, team) VALUES (?,?)').run(emp2.id, 'Construction Team');

  const makeToken = (user) => jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  return {
    app,
    db,
    admin, adminToken: makeToken(admin),
    mgr,   mgrToken:   makeToken(mgr),
    emp,   empToken:   makeToken(emp),
    emp2,  emp2Token:  makeToken(emp2),
  };
}

module.exports = { createTestEnv };
