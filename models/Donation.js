const mongoose = require('mongoose');

const donation = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  volume: {
    value: { type: Number, required: true },
    unit: { type: String, default: 'mL' },
  },
},
{ timestamps: true });

const Donation = mongoose.model('Donation', donation);

module.exports = Donation;
