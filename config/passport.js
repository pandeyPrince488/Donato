const passport = require('passport');
const { Strategy: LocalStrategy } = require('passport-local');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const User = require('../models/User');

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  User.findById(id).exec()
    .then((user) => {
      done(null, user);
    })
    .catch((err) => {
      done(err, null);
    });
});

/**
 * Sign in using Email and Password.
 */
passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
  User.findOne({ email: email.toLowerCase() }).exec()
    .then((user) => {
      if (!user) {
        return done(null, false, { msg: `Email ${email} not found.` });
      }
      if (!user.password) {
        return done(null, false, { msg: 'Your account was registered using a sign-in provider. To enable password login, sign in using a provider, and then set a password under your user profile.' });
      }
      user.comparePassword(password, (err, isMatch) => {
        if (err) { return done(err); }
        if (isMatch) {
          return done(null, user);
        }
        return done(null, false, { msg: 'Invalid email or password.' });
      });
    })
    .catch((err) => done(err));
}));

/**
 * Sign in with Google. Registered conditionally so the app boots fine when
 * the operator hasn't supplied OAuth creds yet (Render Pass-1 deploy, local dev, etc).
 */
exports.isGoogleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (exports.isGoogleEnabled) {
  const callbackURL = `${(process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '')}/auth/google/callback`;
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL,
    scope: ['profile', 'email']
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      // 1. Already linked? Just log them in.
      const byGoogleId = await User.findOne({ google: profile.id }).exec();
      if (byGoogleId) return done(null, byGoogleId);

      const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();

      // 2. Existing local account with the same email? Link Google to it.
      if (email) {
        const existing = await User.findOne({ email }).exec();
        if (existing) {
          existing.google = profile.id;
          existing.emailVerified = true; // Google has already verified the email
          if (!existing.profile.name && profile.displayName) existing.profile.name = profile.displayName;
          if (!existing.profile.picture && profile.photos && profile.photos[0]) existing.profile.picture = profile.photos[0].value;
          existing.tokens = existing.tokens || [];
          existing.tokens.push({ kind: 'google', accessToken });
          await existing.save();
          return done(null, existing);
        }
      }

      // 3. New user — create with Google as the primary auth.
      const fresh = new User({
        email,
        google: profile.id,
        emailVerified: !!email,
        tokens: [{ kind: 'google', accessToken }],
        profile: {
          name: profile.displayName || '',
          picture: (profile.photos && profile.photos[0] && profile.photos[0].value) || ''
        }
      });
      await fresh.save();
      return done(null, fresh);
    } catch (err) {
      return done(err);
    }
  }));
}

/**
 * Login Required middleware.
 */
exports.isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login');
};
