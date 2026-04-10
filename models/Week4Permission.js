const mongoose = require('mongoose');

const week4PermissionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  year: { type: Number, required: true },
  month_number: { type: Number, required: true },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});

week4PermissionSchema.index({ user_id: 1, year: 1, month_number: 1 }, { unique: true });

module.exports = mongoose.model('Week4Permission', week4PermissionSchema);

