const { mongoose } = require('../database/mongo');

const userSchema = new mongoose.Schema({
  employee_id: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  is_admin: { type: Boolean, default: false },
  annual_leave_weeks: { type: Number, default: 3 },
  carried_over_days: { type: Number, default: 0 },
  allow_week4: { type: Boolean, default: false },
  admin_notes: { type: String, default: '' },
  avatar_url: { type: String, default: '' },
  accent_color: { type: String, default: '#B22234' },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);

