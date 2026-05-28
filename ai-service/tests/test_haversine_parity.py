"""
Sanity check: the C++ extension must produce the same Haversine distances
as the pure-Python implementation, to within float tolerance.

Run with:  pytest -q  (from ai-service/)
"""
from __future__ import annotations

import math
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matcher import haversine_km_py  # noqa: E402

try:
    import donato_ext  # type: ignore

    HAS_CPP = True
except Exception:
    HAS_CPP = False


pytestmark = pytest.mark.skipif(not HAS_CPP, reason="donato_ext not built")


def test_one():
    # Delhi -> Mumbai is ~1163 km
    d_py = haversine_km_py(28.6139, 77.2090, 19.0760, 72.8777)
    d_cpp = donato_ext.haversine_one(28.6139, 77.2090, 19.0760, 72.8777)
    assert math.isclose(d_py, d_cpp, rel_tol=1e-9)
    assert 1100 < d_cpp < 1200


def test_batch_matches_python():
    random.seed(42)
    origin = (28.6, 77.2)
    pts = [(random.uniform(-89, 89), random.uniform(-179, 179)) for _ in range(500)]
    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]

    cpp = donato_ext.haversine_batch(origin[0], origin[1], lats, lons)
    for (la, lo), d_cpp in zip(pts, cpp):
        d_py = haversine_km_py(origin[0], origin[1], la, lo)
        assert math.isclose(d_py, d_cpp, rel_tol=1e-9), (la, lo, d_py, d_cpp)


def test_batch_length_mismatch_raises():
    with pytest.raises(Exception):
        donato_ext.haversine_batch(0.0, 0.0, [1.0, 2.0], [1.0])
