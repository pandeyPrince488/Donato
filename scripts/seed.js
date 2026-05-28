/**
 * scripts/seed.js
 *
 * Idempotent demo seeder. Populates an empty database with:
 *   - 1 demo login                 demo@donato.test / DemoPass1234!
 *   - 12 donor profiles around Mumbai with varied blood groups, ages,
 *     and last-donation timestamps tuned to make Smart Match return
 *     a populated, varied list (some peak-freshness, some ineligible-by-recency
 *     so the filtering logic actually demonstrates itself).
 *
 * Bypasses Mongoose's password-hashing pre-save hook by pre-computing
 * two bcrypt hashes (one for the demo, one shared by all donors) and
 * using collection.insertMany. On Render's 0.1 CPU free tier, a per-user
 * bcrypt would take ~5 s each; this runs the whole seed in ~1 s.
 *
 * Run conditions:
 *   - Auto: app.js calls this when MongoDB connects AND there are zero
 *           users in the collection.
 *   - Manual: `node scripts/seed.js` (uses the same MONGODB_URI from .env).
 *   - Force-rewrite: set `SEED_FORCE=true` to wipe + reseed.
 */
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('@node-rs/bcrypt');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');
const Donation = require('../models/Donation');

// ---- Demo data ------------------------------------------------------------

const MUMBAI = { lat: 19.0596, lon: 72.8295 }; // Bandra (the demo user lives here)

// 12 donors around Mumbai with deliberately mixed profiles.
const DONORS = [
  { name: 'Aarav Sharma',   bg: 'O-',  age: 28, lat: 19.1136, lon: 72.8697, area: 'Andheri',     gender: 'Male',   daysSinceLast: 90 },   // peak freshness
  { name: 'Priya Patel',    bg: 'O+',  age: 32, lat: 19.0330, lon: 72.8479, area: 'Worli',       gender: 'Female', daysSinceLast: 120 },  // peak freshness
  { name: 'Rahul Mehta',    bg: 'A+',  age: 35, lat: 18.9750, lon: 72.8258, area: 'Colaba',      gender: 'Male',   daysSinceLast: null }, // never donated
  { name: 'Sneha Iyer',     bg: 'B+',  age: 26, lat: 19.0728, lon: 72.8826, area: 'Khar',        gender: 'Female', daysSinceLast: 200 },  // peak
  { name: 'Vikram Singh',   bg: 'A-',  age: 40, lat: 19.1075, lon: 72.9160, area: 'Powai',       gender: 'Male',   daysSinceLast: 60 },   // just-eligible
  { name: 'Anjali Joshi',   bg: 'O+',  age: 29, lat: 19.0596, lon: 72.9097, area: 'Sion',        gender: 'Female', daysSinceLast: 30 },   // INELIGIBLE — proves filter
  { name: 'Karan Kapoor',   bg: 'AB+', age: 33, lat: 18.9647, lon: 72.8186, area: 'Marine Dr.',  gender: 'Male',   daysSinceLast: 180 },
  { name: 'Riya Desai',     bg: 'B-',  age: 24, lat: 19.0596, lon: 72.8295, area: 'Bandra',      gender: 'Female', daysSinceLast: null }, // never donated, same city
  { name: 'Arjun Verma',    bg: 'O+',  age: 45, lat: 18.9220, lon: 72.8347, area: 'Lower Parel', gender: 'Male',   daysSinceLast: 75 },
  { name: 'Meera Nair',     bg: 'O-',  age: 31, lat: 19.1561, lon: 72.8542, area: 'Vile Parle',  gender: 'Female', daysSinceLast: 250 },
  { name: 'Rohan Bhatt',    bg: 'A+',  age: 38, lat: 19.2147, lon: 72.9697, area: 'Kandivali',   gender: 'Male',   daysSinceLast: 600 },  // freshness decay
  { name: 'Tara Reddy',     bg: 'AB-', age: 27, lat: 19.2183, lon: 73.0883, area: 'Thane',       gender: 'Female', daysSinceLast: 100 }   // far edge of radius
];

// ---- Seeder ---------------------------------------------------------------

async function seed({ force = false } = {}) {
  const existing = await User.countDocuments();
  if (existing > 0 && !force) {
    return { skipped: true, reason: `db already has ${existing} users` };
  }
  if (force) {
    await User.deleteMany({});
    await Donation.deleteMany({});
  }

  const demoHash = await bcrypt.hash('DemoPass1234!', 10);
  const donorHash = await bcrypt.hash('DonorDemo1!', 10);

  const now = Date.now();
  const baseUserDoc = {
    emailVerified: true,
    onboarded: true,
    createdAt: new Date(now),
    updatedAt: new Date(now)
  };

  // 1) Demo recipient (the recruiter logs in as this).
  const demoDoc = {
    ...baseUserDoc,
    email: 'demo@donato.test',
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

  // 2) Donor profiles.
  const donorDocs = DONORS.map((d, i) => ({
    ...baseUserDoc,
    email: `donor${i + 1}@donato.test`,
    password: donorHash,
    online: i % 3 === 0, // every third donor "online" so the badge is visible
    lastPing: new Date(now - (i % 3 === 0 ? 0 : 3600 * 1000)),
    profile: {
      name: d.name,
      phone: `+91 9${String(100000000 + i).padStart(9, '0')}`,
      age: d.age,
      gender: d.gender,
      bloodGroup: d.bg,
      address: {
        city: 'Mumbai',
        state: 'Maharashtra',
        country: 'India',
        postalCode: '400000'
      },
      location: { type: 'Point', coordinates: [d.lon, d.lat] }
    }
  }));

  // Insert all in two operations.
  await User.collection.insertOne(demoDoc);
  const inserted = await User.collection.insertMany(donorDocs);

  // 3) Donations — only for donors with daysSinceLast set.
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
  if (donations.length) await Donation.collection.insertMany(donations);

  return {
    skipped: false,
    users: 1 + DONORS.length,
    donations: donations.length,
    demo: { email: 'demo@donato.test', password: 'DemoPass1234!' }
  };
}

// ---- CLI entrypoint -------------------------------------------------------

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
    else console.log(`[seed] created ${result.users} users + ${result.donations} donations. Login: ${result.demo.email} / ${result.demo.password}`);
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
