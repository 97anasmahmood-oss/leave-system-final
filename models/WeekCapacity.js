const { mongoose } = require('../database/mongo');

const weekCapacitySchema = new mongoose.Schema({
  year: Number,
  month_number: Number,
  week_number: Number,
  max_employees: { type: Number, default: 3 },
}, { timestamps: true });

module.exports = mongoose.model('WeekCapacity', weekCapacitySchema);

