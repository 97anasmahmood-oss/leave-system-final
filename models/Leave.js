const { mongoose } = require('../database/mongo');

const leaveSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  week_number: Number,
  month_number: Number,
  year: { type: Number, default: 2026 },
  start_date: String,
  end_date: String,
  status: { type: String, default: 'approved' },
  employee_note: { type: String, default: '' },
  cancel_reason: { type: String, default: '' },
  cancelled_by: { type: String, default: '' },
  leave_unit: { type: String, default: 'week' },
  days_count: { type: Number, default: 5 },
  carried_days_used: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Leave', leaveSchema);

