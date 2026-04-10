const express = require('express');
const session = require('express-session');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function run() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('leave_system_test');
  process.env.SESSION_SECRET = 'smoke-secret';

  const { connectMongo, mongoose } = require('../database/mongo');
  await connectMongo();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  }));

  app.use('/auth', require('../routes/auth'));
  app.use('/admin', require('../routes/admin'));
  app.use('/employee', require('../routes/employee'));

  const admin = request.agent(app);
  const emp = request.agent(app);

  // 1) Admin login (seeded by ensureDefaults in database/mongo.js)
  let r = await admin.post('/auth/login').send({ employee_id: 'admin', password: 'admin@2024' });
  if (!r.body?.success) throw new Error('Admin login failed: ' + JSON.stringify(r.body));

  // 2) Add employee
  r = await admin.post('/admin/employees/add').send({ employee_id: '1001', name: 'Emp One', password: 'pass', annual_leave_weeks: 3, carried_over_days: 2, allow_week4: 0 });
  if (!r.body?.success) throw new Error('Add employee failed: ' + JSON.stringify(r.body));

  // 3) Employee login
  r = await emp.post('/auth/login').send({ employee_id: '1001', password: 'pass' });
  if (!r.body?.success) throw new Error('Employee login failed: ' + JSON.stringify(r.body));

  // 4) Submit leave (week mode)
  r = await emp.post('/employee/submit-leave').send({ month_number: 1, week_number: 1, employee_note: 'smoke' });
  if (!r.body?.success) throw new Error('Submit leave failed: ' + JSON.stringify(r.body));

  // 5) Read my leaves
  r = await emp.get('/employee/my-leaves');
  if (!r.body?.success || !Array.isArray(r.body.leaves) || r.body.leaves.length < 1) {
    throw new Error('My leaves read failed: ' + JSON.stringify(r.body));
  }

  // 6) Simulate restart (disconnect/reconnect) and re-read
  await mongoose.disconnect();
  await connectMongo();

  r = await emp.get('/employee/my-leaves');
  if (!r.body?.success || !Array.isArray(r.body.leaves) || r.body.leaves.length < 1) {
    throw new Error('My leaves after reconnect failed: ' + JSON.stringify(r.body));
  }

  await mongoose.disconnect();
  await mongod.stop();

  console.log('SMOKE_OK');
}

run().catch((e) => {
  console.error('SMOKE_FAIL', e);
  process.exit(1);
});

