const mongoose = require('mongoose');

const blockedPeriodSchema = new mongoose.Schema({
  type: { type: String, default: 'week' },
  month_number: Number,
  week_number: Number,
  year: { type: Number, default: 2026 },
  day_date: String,
  reason: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('BlockedPeriod', blockedPeriodSchema);

