const express = require('express');
const session = require('express-session');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Setting = require('../models/Setting');
const User = require('../models/User');
const Leave = require('../models/Leave');
const SwapRequest = require('../models/SwapRequest');

function assertOk(cond, msg) {
  if (!cond) throw new Error(msg);
}

function mkApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    secret: process.env.SESSION_SECRET || 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  }));
  app.use('/auth', require('../routes/auth'));
  app.use('/admin', require('../routes/admin'));
  app.use('/employee', require('../routes/employee'));
  return app;
}

async function login(agent, employee_id, password) {
  const r = await agent.post('/auth/login').send({ employee_id, password });
  assertOk(r.body?.success, `Login failed for ${employee_id}: ${JSON.stringify(r.body)}`);
  return r;
}

async function run() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('leave_system_full_check');
  process.env.SESSION_SECRET = 'full-check-secret';
  const { connectMongo } = require('../database/mongo');
  await connectMongo();

  const app = mkApp();
  const admin = request.agent(app);
  const empA = request.agent(app);
  const empB = request.agent(app);

  await login(admin, 'admin', 'admin@2024');

  // Ensure active year + capacity default.
  await admin.post('/admin/settings/year').send({ year: '2026' });
  await admin.post('/admin/settings/max-per-week').send({ max: 3 });

  // Employees
  let r = await admin.post('/admin/employees/add').send({
    employee_id: '2001', name: 'Emp A', password: 'pass', annual_leave_weeks: 3, carried_over_days: 2, allow_week4: 0,
  });
  assertOk(r.body?.success, `Add Emp A failed: ${JSON.stringify(r.body)}`);

  r = await admin.post('/admin/employees/add').send({
    employee_id: '2002', name: 'Emp B', password: 'pass', annual_leave_weeks: 3, carried_over_days: 0, allow_week4: 0,
  });
  assertOk(r.body?.success, `Add Emp B failed: ${JSON.stringify(r.body)}`);

  await login(empA, '2001', 'pass');
  await login(empB, '2002', 'pass');

  // 1) Leave ceiling follows admin setting (3 entries)
  for (let m = 1; m <= 3; m++) {
    r = await empA.post('/employee/submit-leave').send({ month_number: m, week_number: 1, employee_note: 'entry cap test' });
    assertOk(r.body?.success, `Entry ${m} should pass: ${JSON.stringify(r.body)}`);
  }
  r = await empA.post('/employee/submit-leave').send({ month_number: 4, week_number: 1, employee_note: 'entry cap test 4th' });
  assertOk(!r.body?.success, '4th leave entry should fail');

  // 2) Capacity per week
  r = await admin.post('/admin/week-capacity/set').send({ year: 2026, month_number: 6, week_number: 1, max_employees: 1 });
  assertOk(r.body?.success, `Set week capacity failed: ${JSON.stringify(r.body)}`);
  r = await empA.post('/employee/submit-leave').send({ month_number: 6, week_number: 1, employee_note: 'capacity owner' });
  assertOk(!r.body?.success, 'Emp A already at cap entries, should fail by quota before capacity');
  r = await empB.post('/employee/submit-leave').send({ month_number: 6, week_number: 1, employee_note: 'capacity owner' });
  assertOk(r.body?.success, `Emp B first on week should pass: ${JSON.stringify(r.body)}`);

  const empC = request.agent(app);
  r = await admin.post('/admin/employees/add').send({
    employee_id: '2003', name: 'Emp C', password: 'pass', annual_leave_weeks: 3, carried_over_days: 0, allow_week4: 0,
  });
  assertOk(r.body?.success, `Add Emp C failed: ${JSON.stringify(r.body)}`);
  await login(empC, '2003', 'pass');
  r = await empC.post('/employee/submit-leave').send({ month_number: 6, week_number: 1, employee_note: 'capacity blocked' });
  assertOk(!r.body?.success, 'Emp C should be blocked by capacity');

  // 3) Blocked period
  r = await admin.post('/admin/blocked/add').send({ type: 'week', year: 2026, month_number: 7, week_number: 2, reason: 'lock test' });
  assertOk(r.body?.success, `Add blocked period failed: ${JSON.stringify(r.body)}`);
  r = await empB.post('/employee/submit-leave').send({ month_number: 7, week_number: 2, employee_note: 'blocked test' });
  assertOk(!r.body?.success, 'Blocked week should reject leave');

  // 4) Week 4 permission flow
  r = await empB.post('/employee/submit-leave').send({ month_number: 8, week_number: 4, employee_note: 'week4 no perm' });
  assertOk(!r.body?.success, 'Week4 should fail without permission');
  r = await empB.post('/employee/request-week4').send({ month_number: 8, reason: 'need payroll week' });
  assertOk(r.body?.success, `Week4 request failed: ${JSON.stringify(r.body)}`);
  const req4 = await require('../models/Week4Request').findOne({ year: 2026, month_number: 8 }).lean();
  assertOk(!!req4, 'Week4 request row not found');
  r = await admin.post('/admin/week4-requests/approve').send({ id: String(req4._id), admin_note: 'approved for test' });
  assertOk(r.body?.success, `Week4 approve failed: ${JSON.stringify(r.body)}`);
  r = await empB.post('/employee/submit-leave').send({ month_number: 8, week_number: 4, employee_note: 'week4 with perm' });
  assertOk(r.body?.success, `Week4 should pass after permission: ${JSON.stringify(r.body)}`);

  // 5) Day leave consumption (with remaining week credits): should consume from weeks first.
  const empD = request.agent(app);
  r = await admin.post('/admin/employees/add').send({
    employee_id: '2004', name: 'Emp D', password: 'pass', annual_leave_weeks: 3, carried_over_days: 2, allow_week4: 1,
  });
  assertOk(r.body?.success, `Add Emp D failed: ${JSON.stringify(r.body)}`);
  await login(empD, '2004', 'pass');

  // With available week credits, day-mode leave must not touch carried_over_days.
  r = await empD.post('/employee/submit-leave').send({ start_date: '2026-10-11', end_date: '2026-10-12', employee_note: 'day mode carried' });
  assertOk(r.body?.success, `Day leave should pass: ${JSON.stringify(r.body)}`);
  const dUserAfter = await User.findOne({ employee_id: '2004' }).lean();
  assertOk((dUserAfter.carried_over_days || 0) === 2, `Expected carried_over_days to stay 2, got ${dUserAfter.carried_over_days}`);

  // 6) Cancel leave refund rules (when carried_days_used is 0, no carried refund expected)
  const dLeaves = await Leave.find({ user_id: dUserAfter._id, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).lean();
  const latestLeave = dLeaves[0];
  assertOk(!!latestLeave, 'Expected a leave to cancel');
  r = await empD.post('/employee/cancel-leave').send({ leave_id: String(latestLeave._id) });
  assertOk(r.body?.success, `Cancel leave failed: ${JSON.stringify(r.body)}`);
  const dUserAfterCancel = await User.findOne({ employee_id: '2004' }).lean();
  assertOk((dUserAfterCancel.carried_over_days || 0) === 2, `Cancel day leave should keep carried days unchanged here, got ${dUserAfterCancel.carried_over_days}`);

  // 7) Swap flow end-to-end
  const empE = request.agent(app);
  r = await admin.post('/admin/employees/add').send({
    employee_id: '2005', name: 'Emp E', password: 'pass', annual_leave_weeks: 3, carried_over_days: 0, allow_week4: 1,
  });
  assertOk(r.body?.success, `Add Emp E failed: ${JSON.stringify(r.body)}`);
  await login(empE, '2005', 'pass');

  r = await empD.post('/employee/submit-leave').send({ month_number: 11, week_number: 1, employee_note: 'swap D leave' });
  assertOk(r.body?.success, `Emp D swap leave failed: ${JSON.stringify(r.body)}`);
  r = await empE.post('/employee/submit-leave').send({ month_number: 12, week_number: 1, employee_note: 'swap E leave' });
  assertOk(r.body?.success, `Emp E swap leave failed: ${JSON.stringify(r.body)}`);

  const uD = await User.findOne({ employee_id: '2004' }).lean();
  const uE = await User.findOne({ employee_id: '2005' }).lean();
  const dSwapLeave = await Leave.findOne({ user_id: uD._id, month_number: 11, week_number: 1, status: { $ne: 'cancelled' } }).lean();
  const eSwapLeave = await Leave.findOne({ user_id: uE._id, month_number: 12, week_number: 1, status: { $ne: 'cancelled' } }).lean();
  assertOk(!!dSwapLeave && !!eSwapLeave, 'Swap leaves not found');

  r = await empD.post('/employee/request-swap').send({ my_leave_id: String(dSwapLeave._id), target_leave_id: String(eSwapLeave._id), reason: 'swap test' });
  assertOk(r.body?.success, `Swap request failed: ${JSON.stringify(r.body)}`);
  let incoming = await empE.get('/employee/incoming-swap-requests');
  assertOk(incoming.body?.success && incoming.body.requests?.length > 0, 'Target should receive swap request');

  const swapId = incoming.body.requests[0].id;
  r = await empE.post('/employee/swap-requests/respond').send({ id: swapId, action: 'accept', note: 'ok' });
  assertOk(r.body?.success, `Peer accept failed: ${JSON.stringify(r.body)}`);
  r = await admin.post('/admin/swap-requests/approve').send({ id: swapId, admin_note: 'approved' });
  assertOk(r.body?.success, `Admin swap approve failed: ${JSON.stringify(r.body)}`);

  const dLeaveAfterSwap = await Leave.findById(dSwapLeave._id).lean();
  const eLeaveAfterSwap = await Leave.findById(eSwapLeave._id).lean();
  assertOk(dLeaveAfterSwap.month_number === 12 && eLeaveAfterSwap.month_number === 11, 'Swap dates were not applied correctly');

  // 8) Admin can change annual_leave_weeks and quota follows that.
  const empBUser = await User.findOne({ employee_id: '2002' }).lean();
  r = await admin.post('/admin/employees/update').send({
    id: String(empBUser._id),
    name: empBUser.name,
    annual_leave_weeks: 4,
    carried_over_days: empBUser.carried_over_days || 0,
    allow_week4: !!empBUser.allow_week4,
    password: '',
  });
  assertOk(r.body?.success, `Admin employee update failed: ${JSON.stringify(r.body)}`);

  const bActiveLeaves = await Leave.countDocuments({ user_id: empBUser._id, status: { $ne: 'cancelled' } });
  if (bActiveLeaves < 4) {
    const needed = 4 - bActiveLeaves;
    const months = [1, 2, 3, 4, 5, 9, 10, 11, 12];
    let taken = 0;
    for (const m of months) {
      if (taken >= needed) break;
      const rr = await empB.post('/employee/submit-leave').send({ month_number: m, week_number: 2, employee_note: 'admin-updated-cap' });
      if (rr.body?.success) taken += 1;
    }
  }
  r = await empB.post('/employee/submit-leave').send({ month_number: 5, week_number: 3, employee_note: 'should fail after 4 entries' });
  assertOk(!r.body?.success, 'Emp B should be blocked after reaching updated cap 4');

  // Final quick health checks
  const yearSetting = await Setting.findOne({ key: 'active_year' }).lean();
  assertOk(String(yearSetting?.value) === '2026', 'Active year setting mismatch');
  const hasSwapRows = await SwapRequest.countDocuments({});
  assertOk(hasSwapRows >= 1, 'Expected at least one swap request row');

  await mongoose.disconnect();
  await mongod.stop();
  console.log('FULL_SYSTEM_CHECK_OK');
}

run().catch(async (e) => {
  console.error('FULL_SYSTEM_CHECK_FAIL', e.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
