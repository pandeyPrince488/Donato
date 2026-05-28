// donato_ext: tiny pybind11 module that vectorises Haversine distance
// computation for the Smart Donor Matcher hot path.
//
// Why this exists:
//   The Python implementation is ~5-10us per pair. For N=50k candidates that
//   adds up. This C++ version processes the batch in one tight loop with no
//   per-call Python overhead, and is also easy to drop in cross-platform
//   because it has no SIMD intrinsics or platform-specific code.
//
// Build (handled by setup.py):
//   pip install . from inside ai-service/cpp_ext

#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include <cmath>
#include <vector>
#include <stdexcept>

namespace py = pybind11;

namespace {

constexpr double kEarthRadiusKm = 6371.0;
constexpr double kDegToRad = 3.14159265358979323846 / 180.0;

inline double haversine_km(double lat1, double lon1, double lat2, double lon2) {
    const double p1 = lat1 * kDegToRad;
    const double p2 = lat2 * kDegToRad;
    const double dphi = (lat2 - lat1) * kDegToRad;
    const double dlam = (lon2 - lon1) * kDegToRad;
    const double s_dphi = std::sin(dphi * 0.5);
    const double s_dlam = std::sin(dlam * 0.5);
    const double a = s_dphi * s_dphi + std::cos(p1) * std::cos(p2) * s_dlam * s_dlam;
    return 2.0 * kEarthRadiusKm * std::asin(std::sqrt(a));
}

std::vector<double> haversine_batch(double origin_lat,
                                    double origin_lon,
                                    const std::vector<double>& lats,
                                    const std::vector<double>& lons) {
    if (lats.size() != lons.size()) {
        throw std::invalid_argument("lats and lons must have equal length");
    }
    std::vector<double> out;
    out.reserve(lats.size());
    for (std::size_t i = 0; i < lats.size(); ++i) {
        out.push_back(haversine_km(origin_lat, origin_lon, lats[i], lons[i]));
    }
    return out;
}

}  // namespace

PYBIND11_MODULE(donato_ext, m) {
    m.doc() = "Donato C++ extension: vectorised Haversine distance";
    m.def("haversine_one",
          &haversine_km,
          py::arg("lat1"), py::arg("lon1"), py::arg("lat2"), py::arg("lon2"),
          "Great-circle distance in km between two (lat, lon) points.");
    m.def("haversine_batch",
          &haversine_batch,
          py::arg("origin_lat"), py::arg("origin_lon"),
          py::arg("lats"), py::arg("lons"),
          "Distances from one origin to N (lat, lon) points, in km.");
}
