/**
 * dev-local.js -- one-command local dev.
 *
 * Starts an in-memory MongoDB on a random port (downloaded on first run to
 * ~/.cache/mongodb-binaries), points MONGODB_URI at it, then boots the
 * normal Donato app. No need to install Mongo on your machine.
 *
 *   node dev-local.js
 *
 * Data is wiped on every restart (it's in-memory). Use a real Mongo or
 * Atlas if you want persistence.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  console.log('[dev-local] starting in-memory MongoDB...');
  // MongoDB doesn't publish ubuntu2404 binaries; ubuntu2204 is fully
  // compatible. We force the download URL explicitly via the env var.
  const MONGO_VERSION = '7.0.14';
  process.env.MONGOMS_DOWNLOAD_URL =
    process.env.MONGOMS_DOWNLOAD_URL ||
    `https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2204-${MONGO_VERSION}.tgz`;
  const mongo = await MongoMemoryServer.create({
    instance: { dbName: 'bloodchain' },
    binary: { version: MONGO_VERSION }
  });
  const uri = mongo.getUri();
  process.env.MONGODB_URI = uri;
  console.log(`[dev-local] mongo ready: ${uri}`);

  // Default the rest if not already set, so a missing .env doesn't crash startup.
  process.env.BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
  process.env.PORT = process.env.PORT || '8080';
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev_local_secret_change_me';

  console.log('[dev-local] booting Donato app...');
  require('./app.js');

  const shutdown = async () => {
    console.log('\n[dev-local] shutting down...');
    try { await mongo.stop(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  console.error('[dev-local] fatal:', err);
  process.exit(1);
});
