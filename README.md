# FinanceAI Chatbot — Backend

Groq-powered financial chatbot backend. Collects 6 financial data points from users, generates personalised wealth projections via Groq LLM, and funnels qualified leads to a financial advisor.

---

## Project Structure

```
finance_chatbot/
├── server.js                     ← Express server entry point
├── .env                          ← API keys & config (never commit)
├── .env.example                  ← Template — copy to .env
├── package.json
│
├── src/
│   ├── controllers/
│   │   └── chatController.js     ← Conversation state machine (all phases)
│   ├── routes/
│   │   └── chat.js               ← /api/chat route definitions
│   ├── services/
│   │   ├── groq.js               ← Groq SDK wrapper (chat / chatJSON / stream)
│   │   ├── sessionStore.js       ← In-memory session store with TTL
│   │   └── finance.js            ← Financial calculations & fallback engine
│   ├── prompts/
│   │   └── system.js             ← All system prompts (fine-tune here)
│   └── middleware/
│       └── errorHandler.js       ← Logger, 404, global error handler
│
├── tests/
│   └── api.test.js               ← 14-case smoke test suite
│
└── index.html                    ← Frontend test harness (no Groq key needed in browser)
```

---

## Quick Start

### 1. Set your Groq API key

```bash
# Get a free key from https://console.groq.com
# Edit .env:
GROQ_API_KEY=gsk_your_real_key_here
```

### 2. Start the server

```bash
npm run dev        # development (auto-restarts on file save)
npm start          # production
```

Server starts at: `http://localhost:3000`
Frontend harness: `http://localhost:3000` (serves `index.html` from the same Express app)

If `3000` is already in use (common if you run a Next.js frontend on `3000`), the backend will automatically try `3001`, `3002`, ... up to `3009` in development. Use the URL printed in the backend logs, or open the harness with `?apiBase=http://localhost:3001/api/chat` (adjust the port).

### 3. Run API smoke tests

```bash
# In a second terminal (server must be running):
npm run test:api
```

---

## API Reference

All endpoints are under `/api/chat`.

If you host the frontend separately from the backend (different domain/port), pass an explicit API base:

- `?apiBase=http://localhost:3000/api/chat`

### Render deployment note
If deploying on Render, use `npm start` as the Start Command (avoid `npm run dev` in production). This prevents hot-reload/watch mode from causing restarts that can surface as intermittent 502s.

### `POST /api/chat/start`
Creates a new session and returns the first bot question.

**Response:**
```json
{
  "sessionId": "uuid",
  "message":   "👋 Welcome! I'm FinanceAI...",
  "phase":     "collect",
  "step":      { "index": 0, "total": 6, "field": "age", "type": "number", "hint": "Enter your age" },
  "progress":  0
}
```

---

### `POST /api/chat/message`
Send a user reply and receive the bot's response.

**Body:** `{ "sessionId": "uuid", "message": "28" }`

**Response (during collection):**
```json
{
  "sessionId": "uuid",
  "message":   "Got it — 28 years old. And what is your monthly income?",
  "phase":     "collect",
  "step":      { "index": 1, "field": "income", "type": "number", ... },
  "progress":  17,
  "profile":   { "age": 28, "income": null, ... }
}
```

**Response (after all 6 steps — analysis triggered automatically):**
```json
{
  "sessionId": "uuid",
  "message":   "✅ Analysis complete!...",
  "phase":     "hook",
  "analysis":  {
    "projections": { "current_5yr": 275000, "optimized_5yr": 890000, ... },
    "insights":    [ { "title": "...", "description": "...", "impact": "..." }, ... ],
    "wealth_gap":  615000,
    "hook_line":   "Your idle savings are costing you ₹6.15L in lost wealth over 10 years.",
    "quick_wins":  [ "Start ₹35,000/month SIP...", "Check 80C limit...", ... ],
    ...
  },
  "profile":   { "age": 28, "income": 75000, ... },
  "progress":  100
}
```

**Off-topic message response:**
```json
{
  "message": "That's a bit outside my lane! 😊 I'm focused on helping you build wealth right now. Just your age — a number between 18 and 80.",
  "phase":   "collect",
  "step":    { ... }
}
```

---

### `GET /api/chat/session/:id`
Retrieve full session state (for reconnecting after page refresh).

### `DELETE /api/chat/session/:id`
End and remove a session.

### `GET /health`
Liveness check — returns active session count, uptime, model name.

---

## Conversation Phases

| Phase | Description |
|-------|-------------|
| `collect` | Asking the 6 profile questions one at a time |
| `analyze` | Groq is generating the analysis (transient) |
| `hook` | Analysis returned; CTA shown to user |
| `advisor` | User accepted the plan; advisor card displayed |
| `freeform` | Open financial Q&A with profile context |

---

## Fine-Tuning the Bot

All prompts are in **`src/prompts/system.js`**:

| Prompt | Purpose |
|--------|---------|
| `MASTER_IDENTITY` | Base persona injected into every call |
| `COLLECTION_PROMPT` | Controls tone/style during data gathering |
| `ANALYSIS_PROMPT` | JSON schema + rules for financial projection generation |
| `CHAT_PROMPT` | Freeform Q&A with profile context + advisor nudge |
| `OFFTOPIC_CLASSIFIER` | Detects non-financial queries and redirects |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | *(required)* | Your Groq API key |
| `PORT` | `3000` | Server port (in development, if this port is busy the server will try `PORT+1` up to `PORT+9`) |
| `NODE_ENV` | `development` | `development` or `production` |
| `CORS_ORIGINS` | (localhost) | Comma-separated allowed origins |
| `RATE_LIMIT_MAX_REQUESTS` | `30` | Requests per minute per IP |
| `SESSION_TTL_MS` | `1800000` | Session expiry (30 min) |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model to use |
| `GROQ_ANALYSIS_TEMPERATURE` | `0.3` | Lower = more consistent projections |
| `GROQ_CHAT_TEMPERATURE` | `0.65` | Higher = more conversational |

---

## Customising the Advisor

In `index.html` (frontend) inside `showAdvisorCard()`:

- Change advisor **name**, **credentials**, **phone**, **email**
- Update WhatsApp number (`wa.me/91XXXXXXXXXX`)
- Update Calendly link in the booking button
- Specialisations auto-match based on user's `goal` field

---

## Integrating into a Larger Project

The backend exposes a clean REST API. To embed it:

1. Point your existing frontend to `POST /api/chat/start` and `POST /api/chat/message`
2. Render `response.message` as a chat bubble
3. When `response.analysis` appears, render your custom projection UI
4. When `response.phase === 'hook'`, show your advisor CTA

The backend handles all Groq calls, session state, and off-topic filtering transparently.
