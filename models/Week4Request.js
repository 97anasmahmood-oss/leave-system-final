const mongoose = require('mongoose');

const week4RequestSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  month_number: Number,
  year: { type: Number, default: 2026 },
  reason: { type: String, default: '' },
  status: { type: String, default: 'pending' },
  admin_note: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('Week4Request', week4RequestSchema);

