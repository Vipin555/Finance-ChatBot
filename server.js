'use strict';

/**
 * server.js
 * ──────────
 * FinanceAI Chatbot — Express server entry point.
 * All configuration is loaded from .env via dotenv.
 *
 * API Surface:
 *   POST   /api/chat/start          — create session, get first question
 *   POST   /api/chat/message        — send user reply, get bot response
 *   POST   /api/chat/analyze        — force analysis (profile must be complete)
 *   GET    /api/chat/session/:id    — retrieve full session state
 *   DELETE /api/chat/session/:id    — end session
 *   GET    /health                  — liveness check
 */

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const mongoose    = require('mongoose');
const cookieParser = require('cookie-parser');
const path        = require('path');
const rateLimit   = require('express-rate-limit');
const sessionStore = require('./src/services/sessionStore');
const chatRoutes  = require('./src/routes/chat');
const adminRoutes = require('./src/routes/admin');
const { requestLogger, notFoundHandler, globalErrorHandler } = require('./src/middleware/errorHandler');
const AdminUser = require('./src/models/AdminUser');
const bcrypt = require('bcryptjs');

// ─── Seed initial admin user (optional) ─────────────────────────────────────
async function seedInitialAdminUser() {
  if (!process.env.MONGODB_URI) return;
  const username = (process.env.ADMIN_USERNAME || '').trim();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!username || !password) return;

  try {
    const existing = await AdminUser.findOne({ username }).exec();
    if (existing) return;
    const passwordHash = await bcrypt.hash(password, 12);
    await AdminUser.create({ username, passwordHash, role: 'admin' });
    console.log(`\x1b[32m[Admin]\x1b[0m Seeded initial admin user: ${username}`);
  } catch (e) {
    console.error('\x1b[31m[Admin Seed ERROR]\x1b[0m', e.message);
  }
}

// ─── Validate Environment ─────────────────────────────────────────────────────
const REQUIRED_ENV = ['GROQ_API_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k] || process.env[k].includes('your_api_key'));
if (missing.length > 0) {
  console.error('\x1b[31m[STARTUP ERROR]\x1b[0m Missing or placeholder env variables:', missing.join(', '));
  console.error('Copy .env.example to .env and fill in your GROQ_API_KEY from https://console.groq.com');
  process.exit(1);
}



// ─── Database Connection ──────────────────────────────────────────────────────
if (process.env.MONGODB_URI) {
  const mongoConnectOptions = {
    maxPoolSize: 10,
    minPoolSize: 5,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000,
    serverSelectionTimeoutMS: 30000,
    retryWrites: true,
    waitQueueTimeoutMS: 10000,
  };

  mongoose.connect(process.env.MONGODB_URI, mongoConnectOptions)
  .then(async () => {
    console.log('\x1b[32m[Database]\x1b[0m Connected to MongoDB successfully.');
    await seedInitialAdminUser();
  })
  .catch((err) => {
    console.error('\x1b[31m[Database ERROR]\x1b[0m', err.message);
    console.error(
      '\x1b[33m[Connection Help]\x1b[0m:\n' +
      '  1. Verify MongoDB URI in .env is correct\n' +
      '  2. Check IP whitelist in MongoDB Atlas Network Access\n' +
      '  3. Verify database user credentials\n' +
      '  4. Ensure cluster is running (not paused)\n' +
      '  5. Test: mongosh "' + (process.env.MONGODB_URI || '').split('@')[1] + '"'
    );
  });

  // Handle connection events
  mongoose.connection.on('connected', () => {
    console.log('\x1b[32m[Mongoose]\x1b[0m Connected event');
  });
  
  mongoose.connection.on('error', (err) => {
    console.error('\x1b[31m[Mongoose Error]\x1b[0m', err.message);
  });
  
  mongoose.connection.on('disconnected', () => {
    console.warn('\x1b[33m[Mongoose]\x1b[0m Disconnected from MongoDB');
  });
}

// ─── App Init ─────────────────────────────────────────────────────────────────
const app  = express();
const INITIAL_PORT = parseInt(process.env.PORT) || 3000;
let PORT = INITIAL_PORT;
const isDev = process.env.NODE_ENV !== 'production';

// Trust reverse proxy headers in production hosting (Render, etc.).
// Required for correct client IP detection and to avoid express-rate-limit error:
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
if (!isDev || String(process.env.TRUST_PROXY || '').toLowerCase() === 'true') {
  app.set('trust proxy', 1);
}

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // Disabled for dev to allow Chart.js and inline scripts
  frameguard: false, // Allow embedding chatbot UI inside the main website via iframe
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. Postman, curl) in dev
    if (!origin && isDev) return callback(null, true);
    // If no allowlist is configured, don't hard-fail the request.
    // This service is often embedded/proxied and a missing env var would otherwise
    // break same-origin browser requests by throwing and returning 500.
    if (allowedOrigins.length === 0) return callback(null, true);
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    // Don't throw (which becomes a 500). Returning "false" tells cors to skip
    // setting CORS headers; the browser will enforce the block when cross-origin.
    return callback(null, false);
  },
  methods:          ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders:   ['Content-Type', 'Authorization'],
  credentials:      true,
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please slow down.' },
  skip: () => isDev, // Disable rate limiting in development
});
app.use('/api', limiter);

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ─── Logging ──────────────────────────────────────────────────────────────────
app.use(requestLogger);

// ─── API Routes (registered BEFORE static so /api/* is never intercepted by files) ────
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);

// ─── Admin Panel ────────────────────────────────────────────────────────────
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ─── Static Frontend (test harness) ──────────────────────────────────────────
// Serves index.html + style.css from the project root
app.use(express.static(__dirname, {
  index:      'index.html',
  extensions: ['html'],
  dotfiles:   'deny',  // never serve .env
}));

// ─── Health Check ─────────────────────────────────────────────────────────────
function buildHealthPayload() {
  const stats = sessionStore.getStats();
  return {
    status:           'ok',
    uptime:           Math.round(process.uptime()),
    model:            process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    activeSessions:   stats.activeSessions,
    environment:      process.env.NODE_ENV || 'development',
    timestamp:        new Date().toISOString(),
  };
}

app.get('/health', (_req, res) => {
  res.json(buildHealthPayload());
});

app.get('/api/health', (_req, res) => {
  res.json(buildHealthPayload());
});

// ─── API Root ─────────────────────────────────────────────────────────────────
app.get('/api', (req, res) => {
  res.json({
    name:    'FinanceAI Chatbot API',
    version: '1.0.0',
    endpoints: {
      'POST /api/chat/start':        'Start a new session',
      'POST /api/chat/message':      'Send a message',
      'POST /api/chat/analyze':      'Force analysis (complete profile required)',
      'GET  /api/chat/session/:id':  'Get full session state',
      'DELETE /api/chat/session/:id':'End session',
      'GET  /health':                'Health check',
      'GET  /api/health':            'Health check alias',
    },
  });
});

// ─── Error Handlers (must be last) ───────────────────────────────────────────
app.use(notFoundHandler);
app.use(globalErrorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────
let server = app.listen(PORT, () => {
  console.log('\n\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
  console.log('\x1b[33m  FinanceAI Chatbot Backend\x1b[0m  ✦ Powered by Groq');
  console.log('\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
  console.log(`  🚀 Server    : http://localhost:${PORT}`);
  console.log(`  📡 API Base  : http://localhost:${PORT}/api`);
  console.log(`  💡 Health    : http://localhost:${PORT}/health`);
  console.log(`  🌍 Env       : ${process.env.NODE_ENV || 'development'}`);
  console.log(`  🤖 Model     : ${process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'}`);
  console.log('\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
  console.log('\x1b[36m');
  console.log(`  ➜  Open in browser: http://localhost:${PORT}`);
  console.log('\x1b[0m');
});

// Handle listen errors (prevents unhandled 'error' event crashes)
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    if (isDev) {
      const maxTries = 10;
      for (let i = 1; i < maxTries; i++) {
        const nextPort = INITIAL_PORT + i;
        console.warn(`\x1b[33m[Port In Use]\x1b[0m Port ${PORT} is busy. Retrying on ${nextPort}...`);
        PORT = nextPort;
        try {
          server = app.listen(PORT, () => {
            console.log(`\x1b[32m[Server]\x1b[0m Listening on http://localhost:${PORT}`);
            console.log(`\x1b[32m[Server]\x1b[0m API base: http://localhost:${PORT}/api`);
            console.log(`\x1b[32m[Server]\x1b[0m Health:   http://localhost:${PORT}/health`);
          });
          return;
        } catch (_) {
          // keep trying
        }
      }
      console.error(`\x1b[31m[STARTUP ERROR]\x1b[0m Port ${INITIAL_PORT} (and next ${maxTries - 1} ports) are in use.`);
      console.error('Close the other process using these ports, or set PORT in .env and restart.');
      process.exit(1);
    }

    console.error(`\x1b[31m[STARTUP ERROR]\x1b[0m Port ${PORT} is already in use.`);
    console.error('Close the other process using this port, or change PORT in .env and restart.');
    process.exit(1);
  }
  console.error('\x1b[31m[SERVER ERROR]\x1b[0m', err);
  process.exit(1);
});

// If the process starts with an already-connected mongoose (rare), seed best-effort.
if (mongoose.connection.readyState === 1) {
  seedInitialAdminUser();
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully.....`);
  server.close(() => {
    console.log('Server closed. Goodbye!, come back soon! 👋');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced exit after 5s timeout');
    process.exit(1);
  }, 5000);
}


process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Prevent silent crashes in production hosting (e.g. Render/Heroku) where an unhandled rejection
// can terminate the process and appear to clients as a 502/Bad Gateway.
process.on('unhandledRejection', (reason) => {
  console.error('\x1b[31m[unhandledRejection]\x1b[0m', reason);
});
process.on('uncaughtException', (err) => {
  console.error('\x1b[31m[uncaughtException]\x1b[0m', err);
  gracefulShutdown('uncaughtException');
});

module.exports = app; // for testing
