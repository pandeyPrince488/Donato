const path = require('path');
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const bodyParser = require('body-parser');
const logger = require('morgan');
const errorHandler = require('errorhandler');
const lusca = require('lusca');
const dotenv = require('dotenv');
const MongoStore = require('connect-mongo');
const flash = require('express-flash');
const mongoose = require('mongoose');
const passport = require('passport');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { createServer } = require('http');
const { Server } = require('socket.io');

const upload = multer({ dest: path.join(__dirname, 'uploads') });


dotenv.config({ path: '.env' });

// Render auto-injects RENDER_EXTERNAL_URL on every web service (e.g.
// https://donato-web.onrender.com). Falling back to it means the app boots
// without manual BASE_URL config on the first deploy, while still letting a
// manually-set BASE_URL win locally or in any environment that needs it.
if (!process.env.BASE_URL) {
  process.env.BASE_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:8080';
}

const secureTransfer = (process.env.BASE_URL.startsWith('https'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.',
  skip: (req) => {
    return req.path.startsWith('/api/chat/') ||
           req.path.startsWith('/chat') ||
           req.path === '/api/eligibility-chat' ||
           req.path === '/socket.io/';
  }
});

const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many chat requests, please try again later.'
});

// AI eligibility chat is far more expensive (LLM tokens) so cap it harder.
const aiChatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Eligibility chat is rate limited. Please slow down.'
});

let numberOfProxies;
if (secureTransfer) numberOfProxies = 1; else numberOfProxies = 0;

/**
 * Controllers 
 */
const homeController = require('./controllers/home');
const userController = require('./controllers/user');
const chatController = require('./controllers/chatController');
const donorController = require('./controllers/donorController');
const aiController = require('./controllers/aiController');

/**
 * API keys and Passport configuration.
 */
const passportConfig = require('./config/passport');

/**
 * Create Express server.
 */
const app = express();
console.log('Run this app using "npm start" to include sass/scss/css builds.\n');

/**
 * Socket.io
 */
const server = createServer(app);

// Initialize chat system
const { initializeChat } = require('./chat');
initializeChat(server);

/**
 * Connect to MongoDB.
 */
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bloodchain', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  family: 4
});

mongoose.connection.on('connected', async () => {
  console.log('MongoDB connected successfully');
  // Auto-seed the database on first deploy so the demo has data to show.
  // Runs only when the User collection is empty (idempotent), or when
  // SEED_FORCE=true is set explicitly.
  try {
    const { seed } = require('./scripts/seed');
    const result = await seed({ force: process.env.SEED_FORCE === 'true' });
    if (result.skipped) console.log(`[seed] skipped: ${result.reason}`);
    else console.log(`[seed] populated ${result.users} users + ${result.donations} donations. Demo login: ${result.demo.email} / ${result.demo.password}`);
  } catch (err) {
    console.warn('[seed] failed (non-fatal):', err.message);
  }
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
  console.log('Please make sure MongoDB is running and accessible');
  process.exit(1);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected');
});

/**
 * Express configuration.
 */
app.set('host', process.env.OPENSHIFT_NODEJS_IP || '0.0.0.0');
app.set('port', process.env.PORT || process.env.OPENSHIFT_NODEJS_PORT || 8080);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');
app.set('trust proxy', numberOfProxies);
app.use(compression());
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(limiter);
app.use(session({
  resave: true,
  saveUninitialized: true,
  secret: process.env.SESSION_SECRET,
  name: 'startercookie',
  cookie: {
    maxAge: 1209600000,
    secure: secureTransfer
  },
  store: MongoStore.create({
    client: mongoose.connection.getClient(),
    dbName: 'blood-chain',
    stringify: false,
    autoRemove: 'interval',
    autoRemoveInterval: 1
  })
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// Initialize CSRF protection
app.use(lusca({
  csrf: {
    cookie: 'XSRF-TOKEN',
    angular: true
  },
  xframe: 'SAMEORIGIN',
  xssProtection: true
}));

// Make CSRF token available to views
app.use((req, res, next) => {
  res.locals.user = req.user;
  res.locals._csrf = req.csrfToken();
  res.cookie('XSRF-TOKEN', req.csrfToken());
  res.locals.env = {
    BASE_URL: process.env.BASE_URL,
    NODE_ENV: process.env.NODE_ENV,
  };
  res.locals.googleOauthEnabled = passportConfig.isGoogleEnabled;
  res.locals.smtpEnabled = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
  next();
});

// Skip CSRF for specific routes
app.use((req, res, next) => {
  if (
    req.path === '/socket.io/' ||
    req.path.startsWith('/api/chat/') ||
    req.path === '/api/eligibility-chat'
  ) {
    return next();
  }
  lusca.csrf()(req, res, next);
});

app.use((req, res, next) => {
  if (!req.user && req.path !== '/login' && req.path !== '/signup' && !req.path.match(/\./)) {
    req.session.returnTo = req.originalUrl;
  }
  next();
});

app.use('/', express.static(path.join(__dirname, 'public'), { maxAge: 31557600000 }));
app.use('/js/lib', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/js'), { maxAge: 31557600000 }));
app.use('/js/lib', express.static(path.join(__dirname, 'node_modules/jquery/dist'), { maxAge: 31557600000 }));
app.use('/webfonts', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/webfonts'), { maxAge: 31557600000 }));

/**
 * Primary app routes.
 */
app.get('/', homeController.index);
app.get('/messages', passportConfig.isAuthenticated, (req, res) => {
  res.render('messages', {
    title: 'Messages'
  });
});
app.get('/chat', passportConfig.isAuthenticated, (req, res) => {
  const userId = req.query.userId;
  res.render('chat', {
    title: 'Chat',
    targetUserId: userId
  });
});
app.get('/login', userController.getLogin);
app.post('/login', userController.postLogin);
app.get('/logout', userController.logout);
app.get('/signup', userController.getSignup);
app.post('/signup', userController.postSignup);
app.get('/forgot', userController.getForgot);
app.post('/forgot', userController.postForgot);
app.get('/reset/:token', userController.getReset);
app.post('/reset/:token', userController.postReset);
app.get('/account', passportConfig.isAuthenticated, userController.getAccount);
app.post('/account/profile', passportConfig.isAuthenticated, userController.postUpdateProfile);
app.post('/account/password', passportConfig.isAuthenticated, userController.postUpdatePassword);
app.post('/account/delete', passportConfig.isAuthenticated, userController.postDeleteAccount);
app.get('/account/verify', passportConfig.isAuthenticated, userController.getVerifyEmail);
app.get('/account/verify/:token', passportConfig.isAuthenticated, userController.getVerifyEmailToken);
app.get('/account/unlink/:provider', passportConfig.isAuthenticated, userController.getOauthUnlink);
app.get('/donors', donorController.getDonors);
app.get('/donors/smart', passportConfig.isAuthenticated, aiController.getSmartDonors);
app.post('/api/eligibility-chat', aiController.postEligibilityChat);

// Google OAuth — only registered if creds are present (see config/passport.js).
if (passportConfig.isGoogleEnabled) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get(
    '/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login', failureFlash: true }),
    (req, res) => res.redirect(req.session.returnTo || '/')
  );
}
app.get('/about', (req, res) => {
  res.render('about', {
    title: 'About Us'
  });
});

// Chat routes
app.get('/api/chat/conversations', passportConfig.isAuthenticated, chatController.getConversations);
app.get('/api/chat/history/:otherUserId', passportConfig.isAuthenticated, chatController.getChatHistory);
app.post('/api/chat/mark-read/:otherUserId', passportConfig.isAuthenticated, chatController.markAsRead);
app.get('/api/user/:id', passportConfig.isAuthenticated, userController.getUserInfo);

/**
 * Error Handler.
 */
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  res.status(404).send('Page Not Found');
});

if (process.env.NODE_ENV === 'development') {
  app.use(errorHandler());
} else {
  app.use((err, req, res) => {
    console.error(err);
    res.status(500).send('Server Error');
  });
}

// Apply chat-specific rate limiter to chat routes
app.use('/api/chat', chatLimiter);
app.use('/chat', chatLimiter);
app.use('/api/eligibility-chat', aiChatLimiter);

/**
 * Start Express server.
 */
server.listen(app.get('port'), () => {
  const { BASE_URL } = process.env;
  const colonIndex = BASE_URL.lastIndexOf(':');
  const port = parseInt(BASE_URL.slice(colonIndex + 1), 10);

  if (!BASE_URL.startsWith('http://localhost')) {
    console.log(`The BASE_URL env variable is set to ${BASE_URL}. If you directly test the application through http://localhost:${app.get('port')} instead of the BASE_URL, it may cause a CSRF mismatch or an Oauth authentication failure. To avoid the issues, change the BASE_URL or configure your proxy to match it.\n`);
  } else if (app.get('port') !== port) {
    console.warn(`WARNING: The BASE_URL environment variable and the App have a port mismatch. If you plan to view the app in your browser using the localhost address, you may need to adjust one of the ports to make them match. BASE_URL: ${BASE_URL}\n`);
  }

  console.log(`App is running on http://localhost:${app.get('port')} in ${app.get('env')} mode.`);
  console.log('Press CTRL-C to stop.');
});

module.exports = server;
