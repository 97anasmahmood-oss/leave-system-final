const mongoose = require('mongoose');

const occasionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  from_date: String,
  to_date: String,
  icon: { type: String, default: '🎉' },
  color: { type: String, default: '#e74c3c' },
  type: { type: String, default: 'occasion' },
}, { timestamps: true });

module.exports = mongoose.model('Occasion', occasionSchema);

