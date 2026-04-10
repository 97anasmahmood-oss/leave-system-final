const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.warn('MONGODB_URI is not set. MongoDB connection will fail until this value is provided.');
}

async function connectMongo() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is required for MongoDB connection');
  }

  if (mongoose.connection.readyState === 1) return mongoose.connection;

  await mongoose.connect(MONGODB_URI, {
    autoIndex: true,
  });

  await ensureDefaults();
  return mongoose.connection;
}

async function ensureDefaults() {
  // Models are required lazily to avoid circular deps.
  const User = require('../models/User');
  const Setting = require('../models/Setting');

  await User.updateOne(
    { employee_id: 'admin' },
    {
      $setOnInsert: {
        employee_id: 'admin',
        name: 'المسؤول',
        password: 'admin@2024',
        is_admin: true,
        annual_leave_weeks: 0,
        carried_over_days: 0,
        allow_week4: false,
      },
    },
    { upsert: true }
  );

  await Setting.updateOne(
    { key: 'active_year' },
    { $setOnInsert: { key: 'active_year', value: '2026' } },
    { upsert: true }
  );
  await Setting.updateOne(
    { key: 'default_max_per_week' },
    { $setOnInsert: { key: 'default_max_per_week', value: '3' } },
    { upsert: true }
  );
}

module.exports = {
  connectMongo,
};

