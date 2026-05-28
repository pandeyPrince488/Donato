"""
Microbenchmark for the C++ vs Python Haversine batch.

Run with:  python tests/bench_haversine.py
"""
from __future__ import annotations

import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from matcher import haversine_km_py  # noqa: E402

try:
    import donato_ext  # type: ignore

    HAS_CPP = True
except Exception:
    HAS_CPP = False


def bench(n: int = 50_000) -> None:
    random.seed(0)
    origin_lat, origin_lon = 28.6, 77.2
    lats = [random.uniform(-89, 89) for _ in range(n)]
    lons = [random.uniform(-179, 179) for _ in range(n)]

    t0 = time.perf_counter()
    py_out = [haversine_km_py(origin_lat, origin_lon, la, lo) for la, lo in zip(lats, lons)]
    t_py = time.perf_counter() - t0
    print(f"Python  N={n:>6}  total={t_py*1000:.1f} ms  per-call={t_py/n*1e6:.2f} us")

    if HAS_CPP:
        t0 = time.perf_counter()
        cpp_out = donato_ext.haversine_batch(origin_lat, origin_lon, lats, lons)
        t_cpp = time.perf_counter() - t0
        print(f"C++     N={n:>6}  total={t_cpp*1000:.1f} ms  per-call={t_cpp/n*1e6:.2f} us")
        print(f"Speedup: {t_py / t_cpp:.1f}x")
        # parity check on first 5
        for i in range(5):
            print(f"  [{i}] py={py_out[i]:.3f}  cpp={cpp_out[i]:.3f}")
    else:
        print("(C++ extension not built; skipping)")


if __name__ == "__main__":
    bench()
