"""
Smart Donor Matcher.

Pipeline:

  request (recipient + candidate donors)
      |
      v
  feature extraction (distance, freshness, response history, ABO/Rh compat,
                      same-city bonus, age sweet-spot, time-of-day)
      |
      v
  scoring (weighted sum today; pluggable for a learned model tomorrow)
      |
      v
  top-K selection
      |
      v
  LLM explanation per donor (Groq, one batched call)

The Haversine distance + feature scoring is the hot path -- if the optional
C++ extension is available (see cpp_ext/), we use it; otherwise we fall back
to a pure-Python implementation that gives identical results.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional

from pydantic import BaseModel, Field

from llm_client import get_llm_client

# ---------------------------------------------------------------------------
# C++ hot-path: import if available, otherwise mark unavailable.
# ---------------------------------------------------------------------------
USE_CPP = False
if os.getenv("DISABLE_CPP_EXT", "false").lower() != "true":
    try:
        import donato_ext  # type: ignore

        USE_CPP = True
    except Exception:  # ImportError or build error -> Python fallback
        USE_CPP = False


# ---------------------------------------------------------------------------
# Request / response schemas (validated by Pydantic, sent by the Node app).
# ---------------------------------------------------------------------------
class Recipient(BaseModel):
    user_id: str
    blood_group: str = Field(..., description="One of A+, A-, B+, B-, AB+, AB-, O+, O-")
    lat: float
    lon: float
    city: Optional[str] = None
    requested_at: Optional[str] = Field(
        default=None, description="ISO timestamp; used for time-of-day feature"
    )


class Donor(BaseModel):
    user_id: str
    blood_group: str
    lat: float
    lon: float
    city: Optional[str] = None
    age: Optional[int] = None
    last_donation_at: Optional[str] = Field(
        default=None, description="ISO timestamp of donor's last donation, if any"
    )
    response_rate: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Historical accept rate, 0..1"
    )
    is_online: Optional[bool] = False


class RankRequest(BaseModel):
    recipient: Recipient
    candidates: List[Donor]
    top_k: int = Field(default=5, ge=1, le=50)
    radius_km: float = Field(default=45.0, gt=0)
    explain: bool = Field(
        default=True, description="If true, ask the LLM to generate a one-line reason per donor"
    )


class RankedDonor(BaseModel):
    user_id: str
    score: float = Field(..., ge=0.0, le=1.0)
    distance_km: float
    features: dict
    reason: Optional[str] = None


class RankResponse(BaseModel):
    model_config = {"protected_namespaces": ()}

    ranked: List[RankedDonor]
    used_cpp_ext: bool
    model_explanation: Optional[str] = None  # high-level note (e.g. "LLM disabled")


# ---------------------------------------------------------------------------
# Blood-group compatibility (recipient -> set of donor groups they can accept).
# ---------------------------------------------------------------------------
COMPATIBLE_DONORS: dict[str, set[str]] = {
    "O-": {"O-"},
    "O+": {"O-", "O+"},
    "A-": {"O-", "A-"},
    "A+": {"O-", "O+", "A-", "A+"},
    "B-": {"O-", "B-"},
    "B+": {"O-", "O+", "B-", "B+"},
    "AB-": {"O-", "A-", "B-", "AB-"},
    "AB+": {"O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"},
}


def haversine_km_py(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km. Pure Python fallback for the C++ ext."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Feature extraction.
#
# Every feature lives in [0, 1] so the weighted sum produces a 0..1 score that
# is easy to threshold and reason about.
# ---------------------------------------------------------------------------
def _days_since(iso_ts: Optional[str]) -> Optional[float]:
    if not iso_ts:
        return None
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - dt).total_seconds() / 86400.0


def _freshness_score(last_donation_iso: Optional[str]) -> float:
    """
    Donors must wait >= 56 days between whole-blood donations in most
    guidelines. Score peaks once they cross that window and decays gently
    for very stale donors (less likely to still be active).
    """
    days = _days_since(last_donation_iso)
    if days is None:
        return 0.5  # unknown -> neutral
    if days < 56:
        return 0.0  # ineligible right now
    if days <= 365:
        return 1.0
    # gentle decay over 5 years -> 0.3
    return max(0.3, 1.0 - (days - 365) / (365 * 4) * 0.7)


def _age_score(age: Optional[int]) -> float:
    """Bell-shaped score, peak around 25-45."""
    if age is None:
        return 0.5
    if age < 18 or age > 65:
        return 0.0
    if 25 <= age <= 45:
        return 1.0
    # linear ramp on either side
    if age < 25:
        return 0.5 + (age - 18) / 7 * 0.5
    return 0.5 + (65 - age) / 20 * 0.5


def _distance_score(km: float, radius: float) -> float:
    if km >= radius:
        return 0.0
    # closer == better, linear
    return 1.0 - (km / radius)


def _compatibility_score(recipient_bg: str, donor_bg: str) -> float:
    return 1.0 if donor_bg in COMPATIBLE_DONORS.get(recipient_bg, set()) else 0.0


# Feature weights — tuned by hand. In a real system these come from a learned
# model trained on (matched, donated) labels. The interview talking point is
# precisely this: "today it's weighted sum, tomorrow it's LightGBM."
WEIGHTS = {
    "compatibility": 0.30,
    "distance": 0.25,
    "freshness": 0.15,
    "response_rate": 0.15,
    "online": 0.05,
    "age": 0.05,
    "same_city": 0.05,
}


def _score_one(features: dict) -> float:
    # Hard gate: incompatible blood = 0 regardless of other features.
    if features["compatibility"] == 0.0:
        return 0.0
    # Hard gate: ineligible by recency = 0.
    if features["freshness"] == 0.0:
        return 0.0
    s = sum(features[k] * w for k, w in WEIGHTS.items())
    return max(0.0, min(1.0, s))


def _extract_features(
    recipient: Recipient, donor: Donor, distance_km: float, radius_km: float
) -> dict:
    return {
        "compatibility": _compatibility_score(recipient.blood_group, donor.blood_group),
        "distance": _distance_score(distance_km, radius_km),
        "freshness": _freshness_score(donor.last_donation_at),
        "response_rate": donor.response_rate if donor.response_rate is not None else 0.5,
        "online": 1.0 if donor.is_online else 0.0,
        "age": _age_score(donor.age),
        "same_city": 1.0
        if (recipient.city and donor.city and recipient.city.lower() == donor.city.lower())
        else 0.0,
    }


# ---------------------------------------------------------------------------
# Hot path: distance + scoring for every candidate. Uses C++ when available.
# ---------------------------------------------------------------------------
def _score_all(req: RankRequest) -> List[tuple[Donor, float, float, dict]]:
    """Returns list of (donor, distance_km, score, features) for all candidates."""
    r = req.recipient
    out: List[tuple[Donor, float, float, dict]] = []

    if USE_CPP:
        # The C++ ext computes Haversine + the small weighted-sum portion of
        # the score in one tight loop. Categorical features (compat, freshness
        # gates, online, same_city) are still computed in Python because they
        # need ISO-date parsing and string comparisons.
        lats = [d.lat for d in req.candidates]
        lons = [d.lon for d in req.candidates]
        distances = donato_ext.haversine_batch(r.lat, r.lon, lats, lons)  # type: ignore[attr-defined]
        for donor, dist in zip(req.candidates, distances):
            features = _extract_features(r, donor, dist, req.radius_km)
            score = _score_one(features)
            out.append((donor, dist, score, features))
    else:
        for donor in req.candidates:
            dist = haversine_km_py(r.lat, r.lon, donor.lat, donor.lon)
            features = _extract_features(r, donor, dist, req.radius_km)
            score = _score_one(features)
            out.append((donor, dist, score, features))

    return out


# ---------------------------------------------------------------------------
# LLM explanation (single batched call so we pay tokens once for top-K).
# ---------------------------------------------------------------------------
_EXPLAIN_SYSTEM_PROMPT = (
    "You are an assistant for a blood-donation app. For each ranked donor you "
    "are given a small feature dictionary. Write ONE short sentence (max 18 "
    "words) explaining why this donor is a good match, in plain non-clinical "
    "language. Never invent facts. Never include the donor's ID. Reply with a "
    "JSON object: {\"reasons\": [\"...\", \"...\", ...]} in the same order as input."
)


def _explain_with_llm(
    recipient: Recipient, ranked: List[RankedDonor]
) -> tuple[List[Optional[str]], Optional[str]]:
    """Returns (per_donor_reasons, model_note). model_note is set on fallback."""
    client = get_llm_client()
    if client is None:
        return ([None] * len(ranked), "LLM not configured; explanations disabled")

    payload = {
        "recipient_blood_group": recipient.blood_group,
        "donors": [
            {
                "rank": i + 1,
                "distance_km": round(d.distance_km, 1),
                "features": {
                    "compatibility": d.features["compatibility"],
                    "freshness": round(d.features["freshness"], 2),
                    "response_rate": round(d.features["response_rate"], 2),
                    "online": d.features["online"],
                    "same_city": d.features["same_city"],
                    "age_score": round(d.features["age"], 2),
                },
            }
            for i, d in enumerate(ranked)
        ],
    }
    try:
        raw = client.complete_json(
            system=_EXPLAIN_SYSTEM_PROMPT,
            user=json.dumps(payload),
        )
        parsed = json.loads(raw)
        reasons = parsed.get("reasons", [])
        # Pad/truncate to match
        if len(reasons) < len(ranked):
            reasons += [None] * (len(ranked) - len(reasons))
        return (reasons[: len(ranked)], None)
    except Exception as e:  # noqa: BLE001
        return ([None] * len(ranked), f"LLM error: {type(e).__name__}")


# ---------------------------------------------------------------------------
# Public entrypoint.
# ---------------------------------------------------------------------------
def rank_donors(req: RankRequest) -> RankResponse:
    scored = _score_all(req)

    # Drop hard-zero scores (incompatible blood / ineligible / out of radius).
    eligible = [s for s in scored if s[2] > 0.0 and s[1] <= req.radius_km]
    eligible.sort(key=lambda t: t[2], reverse=True)
    top = eligible[: req.top_k]

    ranked: List[RankedDonor] = [
        RankedDonor(
            user_id=donor.user_id,
            score=round(score, 4),
            distance_km=round(dist, 2),
            features={k: round(v, 4) for k, v in feats.items()},
        )
        for donor, dist, score, feats in top
    ]

    model_note: Optional[str] = None
    if req.explain and ranked:
        reasons, model_note = _explain_with_llm(req.recipient, ranked)
        for rd, reason in zip(ranked, reasons):
            rd.reason = reason

    return RankResponse(ranked=ranked, used_cpp_ext=USE_CPP, model_explanation=model_note)
