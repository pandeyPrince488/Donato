/**
 * scripts/seed.js
 *
 * Idempotent demo seeder. Populates the database with:
 *   - 1 demo login                 demo@donato.test / DemoPass1234!
 *   - 12 donor profiles around Mumbai with varied blood groups, ages,
 *     and last-donation timestamps tuned to make Smart Match return
 *     a populated, varied list (some peak-freshness, some ineligible-by-recency
 *     so the filtering logic actually demonstrates itself).
 *
 * Trigger:
 *   - Auto: app.js calls this on Mongo connect. The seeder only does work
 *           when the demo user (demo@donato.test) is missing.
 *   - Manual: `node scripts/seed.js` (uses MONGODB_URI from .env).
 *   - Force-reseed: SEED_FORCE=true wipes only the seed cohort
 *     (every user with an @donato.test email + their donations) and
 *     recreates them. Real user accounts are untouched.
 *
 * Safety: passwords for seed users are hashed once (per cohort) using the same
 * @node-rs/bcrypt library the User model uses, then bulk-inserted bypassing
 * Mongoose's pre-save hook for speed (Render free tier has 0.1 CPU).
 */
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('@node-rs/bcrypt');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');
const Donation = require('../models/Donation');

const MUMBAI = { lat: 19.0596, lon: 72.8295 }; // Bandra (the demo user lives here)
const DEMO_EMAIL = 'demo@donato.test';
const DEMO_PASSWORD = 'DemoPass1234!';
const DONOR_PASSWORD = 'DonorDemo1!';
const SEED_DOMAIN = '@donato.test';

const DONORS = [
  { name: 'Aarav Sharma',   bg: 'O-',  age: 28, lat: 19.1136, lon: 72.8697, area: 'Andheri',     gender: 'Male',   daysSinceLast: 90 },
  { name: 'Priya Patel',    bg: 'O+',  age: 32, lat: 19.0330, lon: 72.8479, area: 'Worli',       gender: 'Female', daysSinceLast: 120 },
  { name: 'Rahul Mehta',    bg: 'A+',  age: 35, lat: 18.9750, lon: 72.8258, area: 'Colaba',      gender: 'Male',   daysSinceLast: null },
  { name: 'Sneha Iyer',     bg: 'B+',  age: 26, lat: 19.0728, lon: 72.8826, area: 'Khar',        gender: 'Female', daysSinceLast: 200 },
  { name: 'Vikram Singh',   bg: 'A-',  age: 40, lat: 19.1075, lon: 72.9160, area: 'Powai',       gender: 'Male',   daysSinceLast: 60 },
  { name: 'Anjali Joshi',   bg: 'O+',  age: 29, lat: 19.0596, lon: 72.9097, area: 'Sion',        gender: 'Female', daysSinceLast: 30 },
  { name: 'Karan Kapoor',   bg: 'AB+', age: 33, lat: 18.9647, lon: 72.8186, area: 'Marine Dr.',  gender: 'Male',   daysSinceLast: 180 },
  { name: 'Riya Desai',     bg: 'B-',  age: 24, lat: 19.0596, lon: 72.8295, area: 'Bandra',      gender: 'Female', daysSinceLast: null },
  { name: 'Arjun Verma',    bg: 'O+',  age: 45, lat: 18.9220, lon: 72.8347, area: 'Lower Parel', gender: 'Male',   daysSinceLast: 75 },
  { name: 'Meera Nair',     bg: 'O-',  age: 31, lat: 19.1561, lon: 72.8542, area: 'Vile Parle',  gender: 'Female', daysSinceLast: 250 },
  { name: 'Rohan Bhatt',    bg: 'A+',  age: 38, lat: 19.2147, lon: 72.9697, area: 'Kandivali',   gender: 'Male',   daysSinceLast: 600 },
  { name: 'Tara Reddy',     bg: 'AB-', age: 27, lat: 19.2183, lon: 73.0883, area: 'Thane',       gender: 'Female', daysSinceLast: 100 }
];

async function wipeSeedCohort() {
  // Wipe only users whose email ends with @donato.test (the demo + 12 donors).
  // Their donations cascade by user-id match.
  const seedRegex = /@donato\.test$/i;
  const seedUsers = await User.find({ email: { $regex: seedRegex } }, { _id: 1 }).lean();
  const ids = seedUsers.map((u) => u._id);
  if (ids.length) {
    await Donation.deleteMany({ user: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
  }
  return ids.length;
}

async function seed({ force = false } = {}) {
  // Decide whether work is needed.
  const demoExists = await User.findOne({ email: DEMO_EMAIL }).lean();
  if (demoExists && !force) {
    return { skipped: true, reason: 'demo user already present' };
  }

  // Wipe any partial / stale seed users to avoid unique-email conflicts on insert.
  const wipedCount = await wipeSeedCohort();

  const demoHash  = await bcrypt.hash(DEMO_PASSWORD,  10);
  const donorHash = await bcrypt.hash(DONOR_PASSWORD, 10);

  const now = Date.now();
  const baseDoc = {
    emailVerified: true,
    onboarded: true,
    createdAt: new Date(now),
    updatedAt: new Date(now)
  };

  const demoDoc = {
    ...baseDoc,
    email: DEMO_EMAIL,
    password: demoHash,
    online: true,
    lastPing: new Date(now),
    profile: {
      name: 'Demo User',
      phone: '+91 90000 00000',
      age: 28,
      gender: 'Other',
      bloodGroup: 'O+',
      address: {
        street: 'Linking Road',
        city: 'Mumbai',
        state: 'Maharashtra',
        country: 'India',
        postalCode: '400050'
      },
      location: { type: 'Point', coordinates: [MUMBAI.lon, MUMBAI.lat] }
    }
  };

  const donorDocs = DONORS.map((d, i) => ({
    ...baseDoc,
    email: `donor${i + 1}@donato.test`,
    password: donorHash,
    online: i % 3 === 0,
    lastPing: new Date(now - (i % 3 === 0 ? 0 : 3600 * 1000)),
    profile: {
      name: d.name,
      phone: `+91 9${String(100000000 + i).padStart(9, '0')}`,
      age: d.age,
      gender: d.gender,
      bloodGroup: d.bg,
      address: { city: 'Mumbai', state: 'Maharashtra', country: 'India', postalCode: '400000' },
      location: { type: 'Point', coordinates: [d.lon, d.lat] }
    }
  }));

  await User.collection.insertOne(demoDoc);
  const inserted = await User.collection.insertMany(donorDocs, { ordered: false });

  const donations = [];
  DONORS.forEach((d, i) => {
    if (d.daysSinceLast == null) return;
    const ts = new Date(now - d.daysSinceLast * 86400000);
    donations.push({
      user: inserted.insertedIds[i],
      volume: { value: 450, unit: 'mL' },
      createdAt: ts,
      updatedAt: ts
    });
  });
  if (donations.length) {
    await Donation.collection.insertMany(donations, { ordered: false });
  }

  return {
    skipped: false,
    wiped: wipedCount,
    users: 1 + DONORS.length,
    donations: donations.length,
    demo: { email: DEMO_EMAIL, password: DEMO_PASSWORD }
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('[seed] MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    const result = await seed({ force: process.env.SEED_FORCE === 'true' });
    if (result.skipped) console.log(`[seed] skipped: ${result.reason}`);
    else console.log(`[seed] wiped ${result.wiped} stale seed users; created ${result.users} users + ${result.donations} donations. Login: ${result.demo.email} / ${result.demo.password}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[seed] fatal:', err);
    process.exit(1);
  });
}

module.exports = { seed };
