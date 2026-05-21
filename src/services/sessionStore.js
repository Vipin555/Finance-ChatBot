'use strict';

/**
 * services/sessionStore.js
 * ─────────────────────────
 * In-memory session store with TTL-based expiry.
 * Each session holds:
 *   - financial profile data
 *   - conversation phase
 *   - message history (for Groq context)
 *   - analysis result (once generated)
 *
 * For production, swap this with Redis using the same interface.
 */

const { v4: uuidv4 } = require('uuid');

const TTL_MS      = parseInt(process.env.SESSION_TTL_MS) || 30 * 60 * 1000; // 30 min default
const CLEANUP_INT = 5 * 60 * 1000; // clean up expired sessions every 5 minutes

/** @type {Map<string, Session>} */
const store = new Map();

// ─── Session schema ───────────────────────────────────────────────────────────
function createSession(userId, name) {
  return {
    id:        uuidv4(),
    userId:    userId || null,
    name:      name || null,
    createdAt: Date.now(),
    touchedAt: Date.now(),

    // ── Financial profile (populated step by step) ──
    profile: {
      name: null,
      age_bracket: null,     // '22-25', '26-30', etc.
      phone: null,           // Collected post-analysis (reciprocity)
      address: null,         // Optional, post-analysis
      monthly_salary: null,
      expenses: {
        basic_needs: null,
        bills_payments: null,
        personal_spending: null,
        extra_unexpected: null,
      },
      risk_profile: 'moderate',
      goal: null,
    },

    // ── Conversation state machine ──────────────────
    phase: 'collect',       // 'collect' | 'analyze' | 'hook' | 'advisor' | 'freeform'
    currentStep: 0,         // index into COLLECTION_STEPS (0-5)
    awaitingConfirmation: false,

    // ── Message history for Groq context ───────────
    // Each entry: { role: 'user'|'assistant', content: string }
    history: [],

    // ── Analysis result (set after phase = 'analyze') ──
    analysis: null,

    // ── UI enrichment state (safe to ignore in API clients) ──
    suggestionState: { recent: [], counter: 0 },
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
function getSession(id) {
  const session = store.get(id);
  if (!session) return null;
  if (Date.now() - session.touchedAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  session.touchedAt = Date.now();
  return session;
}

function createNewSession(userId, name) {
  const session = createSession(userId, name);
  store.set(session.id, session);
  return session;
}

function updateSession(id, changes) {
  const session = store.get(id);
  if (!session) return null;
  Object.assign(session, changes);
  session.touchedAt = Date.now();
  store.set(id, session);
  return session;
}

function deleteSession(id) {
  store.delete(id);
}

/** Add a message to the session's history. Caps history at 40 messages to control token usage. */
function addMessage(id, role, content) {
  const session = store.get(id);
  if (!session) return;
  session.history.push({ role, content });
  if (session.history.length > 40) {
    // Always keep system prompt (first 0 entries are user-created, no system stored here)
    session.history = session.history.slice(-40);
  }
  session.touchedAt = Date.now();
}

function getStats() {
  return {
    activeSessions: store.size,
    totalCapacity:  1000,
  };
}


// ─── Periodic cleanup of expired sessions ─────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, session] of store.entries()) {
    if (now - session.touchedAt > TTL_MS) {
      store.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[SessionStore] Cleaned ${cleaned} expired sessions. Active: ${store.size}`);
  }
}, CLEANUP_INT);

module.exports = {
  getSession,
  createNewSession,
  updateSession,
  deleteSession,
  addMessage,
  getStats,
};

