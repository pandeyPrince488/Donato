const User = require('../models/User');

/**
 * GET /api/user/:id
 * Get user information.
 */
exports.getUserInfo = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('profile');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}; 