const { mongoose } = require('../database/mongo');

const settingSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Setting', settingSchema);

