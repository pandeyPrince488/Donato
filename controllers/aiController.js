/**
 * aiController.js
 *
 * Bridges the Node web app to the Python AI service. Two responsibilities:
 *
 *   1. GET  /donors/smart            -- render the AI-ranked donor list
 *   2. POST /api/eligibility-chat    -- proxy chatbot questions, return JSON
 *
 * The AI service URL and bearer token are read from env. If the service is
 * unreachable, we fail soft (render an empty list with a banner, or return
 * a friendly error JSON) so the rest of the app keeps working.
 */

const User = require('../models/User');
const Donation = require('../models/Donation');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const AI_SERVICE_TOKEN = process.env.AI_SERVICE_TOKEN || '';
const DEFAULT_RADIUS_KM = 45;
const CANDIDATE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Tiny fetch wrapper with timeout + bearer auth + JSON in/out.
 */
async function callAiService(pathname, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${AI_SERVICE_URL}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${AI_SERVICE_TOKEN}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI service ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull a fast, bounded candidate set from Mongo using the existing 2dsphere
 * index on profile.location. We deliberately over-fetch (CANDIDATE_LIMIT) and
 * let the Python service do the ranking -- this keeps Mongo queries trivial
 * and ranking logic in one place.
 */
async function fetchCandidates(req, radiusKm) {
  const me = req.user;
  if (!me || !me.profile || !me.profile.location || !me.profile.location.coordinates) {
    return [];
  }
  const [lon, lat] = me.profile.location.coordinates;
  const query = {
    _id: { $ne: me._id },
    'profile.bloodGroup': { $exists: true, $ne: null },
    'profile.location': {
      $near: {
        $geometry: { type: 'Point', coordinates: [lon, lat] },
        $maxDistance: radiusKm * 1000
      }
    }
  };
  return User.find(query)
    .select('profile email online lastPing')
    .limit(CANDIDATE_LIMIT)
    .lean();
}

/**
 * Look up the last donation timestamp per user, in a single aggregation.
 * Returns a Map<userIdString, ISO string>.
 */
async function fetchLastDonations(userIds) {
  if (!userIds.length) return new Map();
  const docs = await Donation.aggregate([
    { $match: { user: { $in: userIds } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$user', last: { $first: '$createdAt' } } }
  ]);
  const m = new Map();
  docs.forEach((d) => m.set(String(d._id), d.last.toISOString()));
  return m;
}

function buildDonorPayload(user, lastDonationMap) {
  const [lon, lat] = user.profile.location.coordinates;
  return {
    user_id: String(user._id),
    blood_group: user.profile.bloodGroup,
    lat,
    lon,
    city: user.profile.address ? user.profile.address.city : null,
    age: user.profile.age || null,
    last_donation_at: lastDonationMap.get(String(user._id)) || null,
    // We don't yet track per-donor response rate; pass null and let the
    // Python service treat it as neutral 0.5.
    response_rate: null,
    is_online: !!user.online
  };
}

/**
 * GET /donors/smart
 */
exports.getSmartDonors = async (req, res, next) => {
  try {
    const me = req.user;
    const radiusKm = Number(req.query.radius) || DEFAULT_RADIUS_KM;

    if (!me.profile || !me.profile.bloodGroup) {
      return res.render('donors-smart', {
        title: 'Smart Donor Matches',
        needsProfile: 'bloodGroup',
        ranked: [],
        radiusKm
      });
    }
    if (!me.profile.location || !me.profile.location.coordinates) {
      return res.render('donors-smart', {
        title: 'Smart Donor Matches',
        needsProfile: 'location',
        ranked: [],
        radiusKm
      });
    }

    const candidates = await fetchCandidates(req, radiusKm);
    const candidateIds = candidates.map((u) => u._id);
    const lastDonationMap = await fetchLastDonations(candidateIds);
    const candidatePayload = candidates.map((u) => buildDonorPayload(u, lastDonationMap));
    const [lon, lat] = me.profile.location.coordinates;

    let aiResp;
    try {
      aiResp = await callAiService('/rank-donors', {
        recipient: {
          user_id: String(me._id),
          blood_group: me.profile.bloodGroup,
          lat,
          lon,
          city: me.profile.address ? me.profile.address.city : null,
          requested_at: new Date().toISOString()
        },
        candidates: candidatePayload,
        top_k: 10,
        radius_km: radiusKm,
        explain: true
      });
    } catch (err) {
      console.warn('[ai-service] rank-donors failed:', err.message);
      return res.render('donors-smart', {
        title: 'Smart Donor Matches',
        ranked: [],
        aiError: true,
        radiusKm,
        candidateCount: candidates.length
      });
    }

    // Re-hydrate each ranked donor with display data from Mongo.
    const byId = new Map(candidates.map((u) => [String(u._id), u]));
    const ranked = aiResp.ranked
      .map((r) => {
        const u = byId.get(r.user_id);
        if (!u) return null;
        return {
          _id: r.user_id,
          name: (u.profile && u.profile.name) || 'Anonymous Donor',
          bloodGroup: u.profile && u.profile.bloodGroup,
          city: u.profile && u.profile.address ? u.profile.address.city : null,
          email: u.email,
          online: !!u.online,
          score: r.score,
          distanceKm: r.distance_km,
          features: r.features,
          reason: r.reason
        };
      })
      .filter(Boolean);

    return res.render('donors-smart', {
      title: 'Smart Donor Matches',
      ranked,
      usedCppExt: aiResp.used_cpp_ext,
      modelNote: aiResp.model_explanation,
      radiusKm,
      candidateCount: candidates.length
    });
  } catch (err) {
    return next(err);
  }
};

/**
 * POST /api/eligibility-chat
 * Body: { question: string }
 */
exports.postEligibilityChat = async (req, res) => {
  try {
    const question = (req.body && req.body.question) || '';
    if (typeof question !== 'string' || question.trim().length < 2) {
      return res.status(400).json({ error: 'question must be at least 2 characters' });
    }
    if (question.length > 500) {
      return res.status(400).json({ error: 'question too long (max 500 chars)' });
    }
    const aiResp = await callAiService('/eligibility-chat', {
      question: question.trim(),
      top_k: 4
    });
    return res.json(aiResp);
  } catch (err) {
    console.warn('[ai-service] eligibility-chat failed:', err.message);
    return res.status(503).json({
      answer:
        'The eligibility assistant is temporarily unavailable. Please try again in a moment, '
        + 'or contact your local blood bank for guidance.',
      sources: [],
      grounded: false
    });
  }
};
