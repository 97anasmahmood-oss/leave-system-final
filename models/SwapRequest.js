const mongoose = require('mongoose');

const swapRequestSchema = new mongoose.Schema({
  requester_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  target_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  my_leave_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Leave' },
  their_leave_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Leave' },
  reason: { type: String, default: '' },
  target_status: { type: String, default: 'pending' },
  target_note: { type: String, default: '' },
  status: { type: String, default: 'pending' },
  admin_note: { type: String, default: '' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

module.exports = mongoose.model('SwapRequest', swapRequestSchema);

