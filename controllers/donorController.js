const User = require('../models/User');

/**
 * GET /donors
 * List all donors.
 */
exports.getDonors = async (req, res, next) => {
  try {
    // Get the authenticated user's blood group
    const userBloodGroup = req.user ? req.user.profile.bloodGroup : null;
    const userLocation = req.user ? req.user.profile.location : null;

    // Base query to find all donors
    let query = {
      'profile.bloodGroup': { $exists: true },
      _id: { $ne: req.user ? req.user._id : null } // Exclude current user
    };

    // If user is logged in and has blood group, prioritize matching blood groups
    if (userBloodGroup) {
      query['profile.bloodGroup'] = userBloodGroup;
    }

    // Find donors
    const donors = await User.find(query)
      .select('profile email')
      .lean();

    // Calculate distances if user has location
    let donorsWithDistance = donors;
    if (userLocation && userLocation.coordinates) {
      donorsWithDistance = donors.map(donor => {
        if (donor.profile.location && donor.profile.location.coordinates) {
          const distance = calculateDistance(
            userLocation.coordinates[1], // latitude
            userLocation.coordinates[0], // longitude
            donor.profile.location.coordinates[1],
            donor.profile.location.coordinates[0]
          );
          return { ...donor, distance: Math.round(distance) };
        }
        return { ...donor, distance: null };
      });

      // Sort by distance
      donorsWithDistance.sort((a, b) => {
        if (a.distance === null) return 1;
        if (b.distance === null) return -1;
        return a.distance - b.distance;
      });
    }

    res.render('donors', {
      title: 'Donors',
      donors: donorsWithDistance
    });
  } catch (err) {
    next(err);
  }
};

// Helper function to calculate distance between two points using Haversine formula
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the Earth in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function toRad(value) {
  return value * Math.PI / 180;
} 