'use strict';

/**
 * controllers/chatController.js
 * ──────────────────────────────
 * Orchestrates the full chatbot conversation lifecycle.
 * Handles all phases: collect → analyze → hook → advisor → freeform
 *
 * Each public method corresponds to an API route handler.
 */

const sessionStore    = require('../services/sessionStore');
const groqService     = require('../services/groq');
const financeService  = require('../services/finance');
const prompts         = require('../prompts/system');
const Lead            = require('../models/Lead');
const leadsController = require('./leadsController');

// -----------------------
// Conversational helpers
// -----------------------
function extractProfileFromMessage(text, existing) {
  const updated = Object.assign({}, existing || {});
  const t = String(text || '').toLowerCase();

  // Income patterns (rough) — require income/earn context to avoid capturing age.
  const incomeMatch = text.match(/(?:income|salary|earn|earning|take[\s-]?home)[^\d]*(?:₹\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(lakh|lakhs|l|k|cr|crore))?/i)
    || text.match(/(?:₹\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(lakh|lakhs|l|k|cr|crore))?\s*(?:per month|\/month|monthly)\b/i);
  if (incomeMatch && !updated.income && !updated.monthly_income) {
    let val = parseFloat(incomeMatch[1].replace(/,/g, ''));
    const unit = (incomeMatch[2] || '').toLowerCase();
    if (unit.includes('l')) val *= 100000;
    else if (unit.includes('k')) val *= 1000;
    if (val > 1000 && val < 10000000) updated.monthly_income = Math.round(val);
  }

  // Age
  const ageMatch = text.match(/(\b\d{2}\b)\s*(?:years?|yrs?|yo|old)?/i);
  if (ageMatch && !updated.age) {
    const age = parseInt(ageMatch[1], 10);
    if (age >= 18 && age <= 80) updated.age = age;
  }

  // Savings
  const savingsMatch = text.match(/(?:savings|saved|have)[^\d]*(?:₹\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(lakh|k|cr|crore))?/i);
  if (savingsMatch && !updated.savings && !updated.current_savings) {
    let val = parseFloat(savingsMatch[1].replace(/,/g, ''));
    const unit = (savingsMatch[2] || '').toLowerCase();
    if (unit.includes('l')) val *= 100000;
    else if (unit.includes('k')) val *= 1000;
    else if (unit.includes('cr') || unit.includes('crore')) val *= 10000000;
    if (val >= 0) updated.current_savings = Math.round(val);
  }

  // Expenses
  const expenseMatch = text.match(/(?:expense|expenses|spend|spending|outgo|outgoing)\D{0,24}(?:₹\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(lakh|k|cr|crore))?/i)
    || text.match(/(?:₹\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(lakh|k|cr|crore))?\s*(?:as|for|in)?\s*(?:expense|expenses|spend|spending)\b/i);
  if (expenseMatch && (updated.expenses === undefined || updated.expenses === null)) {
    let val = parseFloat(expenseMatch[1].replace(/,/g, ''));
    const unit = (expenseMatch[2] || '').toLowerCase();
    if (unit.includes('l')) val *= 100000;
    else if (unit.includes('k')) val *= 1000;
    else if (unit.includes('cr') || unit.includes('crore')) val *= 10000000;
    if (val >= 0) updated.expenses = Math.round(val);
  }

  // Risk appetite
  if (!updated.risk) {
    if (/low risk|conservative|safe|fd|fixed deposit/i.test(t)) updated.risk = 'conservative';
    else if (/aggressive|high risk|stocks|equity/i.test(t)) updated.risk = 'aggressive';
    else if (/balanced|moderate|sip|mutual fund/i.test(t)) updated.risk = 'moderate';
  }

  // Goal
  if (!updated.goal) {
    if (/retire|retirement/i.test(t)) updated.goal = 'retirement';
    else if (/house|home|property/i.test(t)) updated.goal = 'house';
    else if (/car|vehicle|bike|auto/i.test(t)) updated.goal = 'house';
    else if (/education|child|school|college/i.test(t)) updated.goal = 'education';
    else if (/wealth|crore|rich|invest more/i.test(t)) updated.goal = 'wealth';
  }

  // Time horizon (used for prompting and tone)
  if (!updated.time_horizon) {
    if (/short|next\s*5\s*years?|near\s*term|soon/i.test(t)) updated.time_horizon = 'short';
    else if (/long|long\s*term|later|future/i.test(t)) updated.time_horizon = 'long';
  }

  return updated;
}

function buildPeakInsight(profile) {
  const income = profile.monthly_income || profile.income || 0;
  const age = profile.age || 30;
  const savings = profile.current_savings || profile.savings || 0;
  const yearsToRetire = Math.max(10, 60 - age);
  const annualIncome = income * 12;
  const benchmark = Math.max(0, (age - 22) * annualIncome);
  const corpusGap = Math.max(0, benchmark - savings);

  if (income > 0 && corpusGap > 0) {
    const lacs = Math.round(corpusGap / 100000);
    return `At ${age}, with roughly ₹${Math.round(income).toLocaleString('en-IN')}/mo, the age benchmark suggests a corpus shortfall of about ₹${(lacs)}L. That's a meaningful gap.`;
  }

  if (income > 0) {
    return 'There appears to be an opportunity loss from not optimally allocating surplus — this can amount to several lakhs over 10 years.';
  }

  return 'There seems to be a significant wealth gap between trajectory and your likely goals.';
}

function advanceStage(session) {
  const s = session;
  const msgCount = s.message_count || 0;
  const hasIncome = !!(s.profile && (s.profile.monthly_income || s.profile.income));
  const hasAge = !!(s.profile && s.profile.age);
  const hasSavings = !!(s.profile && (s.profile.current_savings || s.profile.savings));

  if (s.phase === 'captured') return 'CAPTURED';
  if (s.stage === 'PITCH') return 'PITCH';

  if (hasIncome && hasAge && hasSavings && msgCount >= 4) return 'PEAK';
  if ((hasIncome && hasAge) && msgCount >= 3) return 'DEEPEN';
  if (msgCount <= 2) return 'OPEN';
  return 'DEEPEN';
}

function parseAmountINR(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (/not much|none|zero|no savings|nothing/i.test(t)) return 0;

  const m = t.match(/(\d[\d,]*(?:\.\d+)?)(?:\s*(k|l|lakh|lakhs|cr|crore))?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') n *= 1000;
  if (unit === 'l' || unit === 'lakh' || unit === 'lakhs') n *= 100000;
  if (unit === 'cr' || unit === 'crore') n *= 10000000;
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

/**
 * Extract a simple contact (name + phone) from a free-form message.
 * Returns { name, phone } or null.
 */
function extractContactFromMessage(text) {
  if (!text) return null;
  const t = String(text).trim();

  // Phone: look for 10-digit Indian numbers (with optional +91 or 0)
  const phoneMatch = t.match(/(?:\+91[\-\s]?|0)?([6-9]\d{9})/);
  if (!phoneMatch) return null;
  const phone = phoneMatch[1];

  // Try to extract a nearby name. Look left of phone for 1-3 word name.
  const left = t.slice(0, phoneMatch.index).trim();
  let name = '';
  if (left) {
    // Take last 3 words from left part that look like a name
    const tokens = left.split(/\s+/).filter(Boolean);
    const candidates = tokens.slice(-3).join(' ');
    // simple cleanup: remove labels like 'name' or 'my'
    name = candidates.replace(/^(name[:\-\s]*|my\s+)/i, '').trim();
  }

  // If no left-side name, try phrasing like 'I'm John Doe' or 'I am John'
  if (!name) {
    const m = t.match(/(?:i\s+am|i'm|this is|name is)\s+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,}){0,2})/i);
    if (m) name = m[1].trim();
  }

  // Basic validation: ensure name has at least one alphabetic token
  if (!name || !/[A-Za-z]/.test(name)) return { name: '', phone };
  return { name, phone };
}


// ─── Collection Steps Definition ─────────────────────────────────────────────
const COLLECTION_STEPS = [
  {
    field:       'age',
    question:    "👋 Welcome! I'm FinanceAI — your personal wealth intelligence assistant.\n\nLet's start building your financial snapshot. **How old are you?**",
    reprompt:    "Just your age — a number between 18 and 80.",
    type:        'number',
    validate:    v => financeService.validateProfileField('age', v),
    parse:       v => parseFloat(v.replace(/[^\d.]/g, '')),
    hint:        'Enter your age (18–80)',
  },
  {
    field:       'income',
    question:    "💼 Got it! And what is your **monthly take-home income**? _(in ₹)_",
    reprompt:    "Your net monthly salary or business income in ₹ — e.g. 75000",
    type:        'number',
    validate:    v => financeService.validateProfileField('income', v),
    parse:       v => {
      const amount = parseAmountINR(v);
      if (amount !== null) return amount;
      return parseFloat(String(v).replace(/[^\d.]/g, ''));
    },
    hint:        'Monthly income in ₹',
  },
  {
    field:       'expenses',
    question:    "🏠 Now your **monthly expenses** — rent, food, EMIs, subscriptions, bills — everything. _(in ₹)_",
    reprompt:    "Total monthly outgoings in ₹ — include all regular expenses.",
    type:        'number',
    validate:    v => financeService.validateProfileField('expenses', v),
    parse:       v => {
      const amount = parseAmountINR(v);
      if (amount !== null) return amount;
      return parseFloat(String(v).replace(/[^\d.]/g, ''));
    },
    hint:        'Monthly expenses in ₹',
  },
  {
    field:       'savings',
    question:    "🏦 What are your **total current savings**? _(bank balance, FDs, liquid funds — in ₹)_",
    reprompt:    "Total liquid savings in ₹ — this can be 0 if you're starting fresh.",
    type:        'number',
    validate:    v => financeService.validateProfileField('savings', v),
    parse:       v => {
      const amount = parseAmountINR(v);
      if (amount !== null) return amount;
      return parseFloat(String(v).replace(/[^\d.]/g, ''));
    },
    hint:        'Total savings in ₹',
  },
  {
    field:       'risk',
    question:    "📊 How would you describe your **investment risk appetite**?",
    reprompt:    "Please choose one: conservative, moderate, or aggressive.",
    type:        'choice',
    choices:     ['conservative', 'moderate', 'aggressive'],
    validate:    v => financeService.validateProfileField('risk', v),
    parse:       v => v.trim().toLowerCase(),
    hint:        'conservative / moderate / aggressive',
    display:     { conservative: '🛡️ Conservative', moderate: '⚖️ Moderate', aggressive: '🚀 Aggressive' },
  },
  {
    field:       'goal',
    question:    "🎯 Last one — what is your **primary financial goal**?",
    reprompt:    "Choose one: retirement, house, wealth, or education.",
    type:        'choice',
    choices:     ['retirement', 'house', 'wealth', 'education'],
    validate:    v => financeService.validateProfileField('goal', v),
    parse:       v => v.trim().toLowerCase(),
    hint:        'retirement / house / wealth / education',
    display:     { retirement: '🏖️ Early Retirement', house: '🏠 Buy a House', wealth: '📈 Grow Wealth', education: '🎓 Child\'s Education' },
  },
];

// ─── Utility: format a profile field's value for display ─────────────────────
function displayValue(step, parsed) {
  if (step.display) return step.display[parsed] || parsed;
  if (step.field === 'age') return `${parsed} years old`;
  if (['income', 'expenses', 'savings'].includes(step.field)) return `₹${financeService.formatINR(parsed)}/month`;
  return String(parsed);
}

// ─── Off-topic detection ──────────────────────────────────────────────────────
async function isOffTopic(message, phase) {
  // Only run classifier in collect phase — other phases are more forgiving
  if (phase !== 'collect') return false;

  // Quick string heuristics first (fast path, no API call)
  const lower = message.toLowerCase();
  const financeKeywords = [
    'income','salary','expense','saving','invest','sip','mutual','fund','stock','tax','emi',
    'loan','retire','wealth','budget','asset','debt','insurance','fd','ppf','nps','elss','mf','portfolio',
    'conservative','moderate','aggressive','education','house'
  ];
  if (financeKeywords.some(kw => lower.includes(kw))) return false;

  // Only call Groq classifier for ambiguous messages over 5 chars
  if (message.trim().length <= 5) return false;

  try {
    const raw = await groqService.chat([
      { role: 'system', content: prompts.OFFTOPIC_CLASSIFIER },
      { role: 'user', content: message },
    ], { temperature: 0.1, maxTokens: 100, jsonMode: true });

    const result = JSON.parse(raw);
    return result.is_financial === false;
  } catch {
    return false; // On error, assume it's financial (don't block users)
  }
}

// ─── POST /api/chat/start ─────────────────────────────────────────────────────
async function startSession(req, res) {
  try {
    const { userId, name } = req.body;
    const session = sessionStore.createNewSession(userId, name);

    // Keep a deterministic first step so API tests and UI stay consistent.
    const firstQuestion = COLLECTION_STEPS[0].question;
    sessionStore.addMessage(session.id, 'assistant', firstQuestion);

    return res.json({
      sessionId: session.id,
      message:   firstQuestion,
      phase:     'collect',
      step:      buildStepMeta(0),
      progress:  0,
      insight:   generateSimpleInsight(session, { message: firstQuestion, phase: 'collect' }),
      suggestedQuestions: generateSuggestedQuestions(session),
      visual:    makeVisualData(session, { message: firstQuestion, phase: 'collect' }),
      summaryLine: buildProfileSummaryLine(session),
      hookLine: buildHookLine(session, { message: firstQuestion, phase: 'collect' }),
    });
  } catch (err) {
    console.error('[startSession]', err);
    return res.status(500).json({ error: 'Failed to start session. Please try again.' });
  }
}

// ─── POST /api/chat/message ───────────────────────────────────────────────────
async function handleMessage(req, res) {
  const { sessionId, message } = req.body;

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required.' });
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message cannot be empty.' });
  }

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session expired or not found. Please start a new conversation.', code: 'SESSION_EXPIRED' });
  }

  const userMessage = message.trim();
  sessionStore.addMessage(sessionId, 'user', userMessage);

  try {
    let response;

    switch (session.phase) {
      case 'collect':
        response = await handleCollectPhase(session, userMessage);
        break;
      case 'analyze':
        response = { message: "⏳ Still generating your analysis — hang tight!", phase: 'analyze' };
        break;
      case 'hook':
      case 'freeform':
      case 'advisor':
        response = await handleFreeformPhase(session, userMessage);
        break;
      default:
        response = { message: "I'm ready to help with your financial questions. What would you like to know?", phase: session.phase };
    }

    // Enrich response with simple insight, suggested questions, and a small visual payload
    try {
      if (!response.analysis && session.analysis) response.analysis = session.analysis;
      if (!response.profile && session.profile) response.profile = session.profile;
      response.insight = generateSimpleInsight(session, response);
      response.suggestedQuestions = generateSuggestedQuestions(session);
      if (!response.visual) response.visual = makeVisualData(session, response);
      response.summaryLine = buildProfileSummaryLine(session);
      const personalNudge = buildPersonalizedNudge(session);
      response.hookLine = `${buildHookLine(session, response)} ${personalNudge}`.trim();
    } catch (e) {
      console.warn('[response-enrich]', e && e.message);
    }

    sessionStore.addMessage(sessionId, 'assistant', response.message);
    return res.json({ sessionId, ...response });

  } catch (err) {
    console.error('[handleMessage]', err.message);
    const fallback = "I'm having a brief connectivity issue. Could you please repeat that?";
    return res.json({ sessionId, message: fallback, phase: session.phase, error: true });
  }
}

// ─── Response enrichment helpers ───────────────────────────────────────────
function generateSimpleInsight(session, responseObj) {
  try {
    const profile = session.profile || {};
    const income = profile.monthly_income || profile.income || 0;
    const expenses = profile.expenses;

    // Prefer server-provided analysis if present; avoid computing projections on incomplete profiles.
    const analysis = responseObj.analysis || session.analysis || null;
    const investable = (analysis && Number.isFinite(analysis.investable_amount)) ? analysis.investable_amount : null;

    if (income && investable !== null) {
      return `Quick insight: with ₹${financeService.formatINR(income)}/mo you could invest about ₹${financeService.formatINR(investable)}/mo.`;
    }
    if (income && Number.isFinite(expenses)) {
      const surplus = Math.max(0, Math.round(income - expenses));
      return `Quick insight: your rough monthly surplus looks like ~₹${financeService.formatINR(surplus)} (income − expenses).`;
    }
    if (income) {
      return `Quick insight: once I know your expenses, I can estimate how much of your ₹${financeService.formatINR(income)}/mo can be invested.`;
    }
    return 'Quick insight: share just one number (income) and I’ll show a quick baseline instantly.';
  } catch (e) {
    return 'Quick insight: saving and investing a bit more each month compounds significantly over years.';
  }
}

function generateSuggestedQuestions(session) {
  const profile = session.profile || {};
  const goal = profile.goal || 'wealth';

  // Keep suggestions relevant to the CURRENT phase.
  // During collect, chips should behave like valid *answers* (so tapping them doesn't feel "outside my lane").
  const phase = session.phase || 'collect';

  const suggestRotate = (pool, count = 2) => {
    const state = session.suggestionState || { recent: [], counter: 0 };
    const recent = Array.isArray(state.recent) ? state.recent : [];
    const normalizedPool = (pool || []).map(s => String(s || '').trim()).filter(Boolean);
    if (normalizedPool.length === 0) return [];

    const recentSet = new Set(recent);
    const fresh = normalizedPool.filter(s => !recentSet.has(s.toLowerCase()));
    const source = fresh.length >= count ? fresh : normalizedPool;

    state.counter = (state.counter || 0) + 1;
    const picked = [];
    let cursor = state.counter;
    while (picked.length < Math.min(count, source.length)) {
      const item = source[cursor % source.length];
      cursor += 1;
      if (!picked.includes(item)) picked.push(item);
    }

    picked.forEach(s => recent.push(String(s).toLowerCase()));
    state.recent = recent.slice(-12);
    session.suggestionState = state;

    return picked;
  };

  // ── Collect phase suggestions (example answers) ──
  if (phase === 'collect') {
    const income = profile.monthly_income || profile.income || 0;

    // Flow-based collection (income-first baseline)
    if (session.flowStage && session.flowStage !== 'analysis_complete') {
      switch (session.flowStage) {
        case 'awaiting_expenses_or_savings':
          return suggestRotate([
            income ? `expenses ${financeService.formatINR(Math.round(income * 0.6))}` : 'expenses 25k',
            'saved 1L',
            'expenses',
            'savings'
          ], 2);
        case 'awaiting_expenses_value':
          return suggestRotate([
            income ? `${financeService.formatINR(Math.round(income * 0.6))}` : '25000',
            income ? `${financeService.formatINR(Math.round(income * 0.75))}` : '40000',
            '0'
          ], 2);
        case 'awaiting_savings_value':
          return suggestRotate(['0', '50000', '1L', '2L'], 2);
        case 'awaiting_age_and_goal':
          return suggestRotate(['age 28 wealth', 'age 32 retirement', '24 house', '29 education'], 2);
        case 'awaiting_investments':
          return suggestRotate(['SIP 5k', 'FD only', 'PPF', 'nothing yet'], 2);
        default:
          break;
      }
    }

    // Deterministic step-based collection
    const stepIndex = Number.isFinite(session.currentStep) ? session.currentStep : 0;
    const step = (stepIndex >= 0 && stepIndex < COLLECTION_STEPS.length) ? COLLECTION_STEPS[stepIndex] : null;
    const field = step ? step.field : null;
    if (field === 'age') return suggestRotate(['24', '28', '35', '42'], 2);
    if (field === 'income') return suggestRotate(['50000', '75000', '100000', '150000'], 2);
    if (field === 'expenses') {
      const a = income ? Math.round(income * 0.55) : 30000;
      const b = income ? Math.round(income * 0.75) : 45000;
      return suggestRotate([String(a), String(b), '0'], 2);
    }
    if (field === 'savings') return suggestRotate(['0', '50000', '200000', '500000'], 2);
    if (field === 'risk') return suggestRotate(['moderate', 'conservative', 'aggressive'], 2);
    if (field === 'goal') return suggestRotate(['wealth', 'retirement', 'house', 'education'], 2);

    // Safe fallback for collect
    return suggestRotate(['income 75000', 'expenses 40000', 'saved 2L', 'moderate'], 2);
  }

  // ── Post-analysis suggestions (finance Q&A prompts) ──
  const analysis = session.analysis || null;
  const investable = analysis && Number.isFinite(analysis.investable_amount) ? analysis.investable_amount : null;

  const base = [];
  if (investable !== null) {
    base.push(`If I invest ₹${financeService.formatINR(investable)}/mo, what happens in 5 years?`);
    base.push(`How can I increase my SIP by ₹${financeService.formatINR(Math.max(1000, Math.round(investable * 0.2)))}/mo?`);
  } else {
    base.push('How much should I invest monthly?');
    base.push('How do I start a SIP step-by-step?');
  }

  if (goal === 'retirement') base.push('Can I retire at 55 with my current numbers?');
  else if (goal === 'house') base.push('When can I buy a house with my current numbers?');
  else if (goal === 'education') base.push('How much should I invest for child education?');
  else base.push('How do I reduce tax while investing?');

  // Keep suggestions within personal finance lane: no vague motivational prompts.
  return suggestRotate(base, 2);
}

function buildProfileSummaryLine(session) {
  const p = (session && session.profile) ? session.profile : {};
  const parts = [];
  if (p.age) parts.push(`${p.age}y`);
  const income = p.monthly_income || p.income;
  if (income) parts.push(`₹${financeService.formatINR(income)}/mo`);
  if (p.goal) parts.push(`goal: ${p.goal}`);
  if (p.risk) parts.push(`risk: ${p.risk}`);
  return parts.length ? `You: ${parts.join(' • ')}` : 'You: add income to see your potential.';
}

function buildHookLine(session, responseObj) {
  const profile = session.profile || {};
  const income = profile.monthly_income || profile.income || 0;
  const expenses = Number.isFinite(profile.expenses) ? profile.expenses : null;
  const age = profile.age || null;
  const surplus = (expenses === null) ? null : Math.max(0, income - expenses);
  const analysis = responseObj.analysis || session.analysis || null;

  if (analysis && analysis.projections && Number.isFinite(analysis.projections.optimized_5yr) && Number.isFinite(analysis.investable_amount)) {
    return `Hook: a 30‑min plan with Piyush can help you turn ~₹${financeService.formatINR(analysis.investable_amount)}/mo into ${financeService.formatCrLakh(analysis.projections.optimized_5yr)} in 5 years.`;
  }
  if (income && surplus !== null && age) {
    const suggested = Math.round(surplus * 0.7);
    return `Hook: at age ${age}, investing ~₹${financeService.formatINR(suggested)}/month from your ₹${financeService.formatINR(surplus)} surplus can create a strong 5-year base; Piyush can personalize it.`;
  }
  if (income && surplus !== null) {
    return `Hook: your current surplus is ~₹${financeService.formatINR(surplus)}/month — I can turn this into a realistic 5-year wealth path.`;
  }
  if (income) {
    return `Hook: with ₹${financeService.formatINR(income)}/month income, share expenses and I’ll quantify your 5-year potential instantly.`;
  }
  return 'Hook: share your monthly income to see a baseline instantly.';
}

function buildPersonalizedNudge(session) {
  const p = session.profile || {};
  const age = p.age;
  const income = p.monthly_income || p.income || 0;
  const expenses = Number.isFinite(p.expenses) ? p.expenses : null;
  const monthly = (expenses === null) ? null : Math.max(0, income - expenses);
  const analysis = session.analysis || null;

  if (age && analysis && analysis.projections && Number.isFinite(analysis.projections.optimized_10yr)) {
    const years = Math.max(5, 60 - age);
    return `Personal tip: at age ${age}, a steady SIP can build strong wealth over ${years}+ years. Stay consistent month by month.`;
  }
  if (age && monthly !== null) {
    return `Personal tip: you are ${age}. If you invest even ₹${financeService.formatINR(Math.round(monthly * 0.6))}/month consistently, your long-term growth can improve a lot.`;
  }
  if (income > 0) {
    return `Personal tip: with ₹${financeService.formatINR(income)}/month income, start with a fixed SIP date and automate it.`;
  }
  return 'Personal tip: share one clear number (income or savings) and I will give a customized growth path.';
}

function buildDiversificationText(session) {
  const p = session.profile || {};
  const risk = p.risk || 'moderate';
  const goal = p.goal || 'wealth';
  if (risk === 'conservative') {
    return `Diversification idea: 35% liquid/ultra-short funds, 25% FD/RD, 15% Gold ETF, 25% Index funds.`;
  }
  if (risk === 'aggressive') {
    return `Diversification idea: 15% liquid funds, 10% Gold ETF, 55% Index funds, 20% flexi/mid-cap funds.`;
  }
  return `Diversification idea: 20% liquid funds, 15% Gold ETF, 45% Index funds, 20% FD/short debt (${goal} aligned).`;
}

function buildAdvisorContactLine() {
  return 'Advisor contact: Piyush Tembhekar (CFP) — WhatsApp +91 98765 43210.';
}

function isSpecificInvestmentAdviceQuery(message) {
  const t = String(message || '').toLowerCase();
  return /(which\s+mutual\s+fund|suggest\s+.*fund|suggest\s+.*amc|best\s+fund|fund\s+name|which\s+amc|stock\s+tip|buy\s+now)/i.test(t);
}

function parseGoalPlanQuestion(message) {
  const text = String(message || '');
  const lower = text.toLowerCase();
  if (!/(grow|reach|target|goal|achieve)/i.test(lower)) return null;
  if (!/(month|months|yr|year|years)/i.test(lower)) return null;

  const amounts = [...text.matchAll(/(?:₹\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(k|l|lakh|lakhs|cr|crore))?/gi)]
    .map(m => {
      let val = parseFloat(String(m[1]).replace(/,/g, ''));
      const unit = String(m[2] || '').toLowerCase();
      if (unit === 'k') val *= 1000;
      if (unit === 'l' || unit === 'lakh' || unit === 'lakhs') val *= 100000;
      if (unit === 'cr' || unit === 'crore') val *= 10000000;
      return Number.isFinite(val) ? Math.round(val) : null;
    })
    .filter(v => Number.isFinite(v));
  if (!amounts.length) return null;

  const monthsMatch = lower.match(/(\d{1,3})\s*(month|months)/i);
  const yearsMatch = lower.match(/(\d{1,2})\s*(year|years|yr|yrs)/i);
  const months = monthsMatch ? parseInt(monthsMatch[1], 10) : (yearsMatch ? parseInt(yearsMatch[1], 10) * 12 : null);
  if (!months || months <= 0) return null;

  const targetMatch = text.match(/(?:to|reach|target|goal)\s*(?:₹\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(k|l|lakh|lakhs|cr|crore))?/i);
  let target = null;
  if (targetMatch) {
    target = parseAmountINR(`${targetMatch[1]} ${targetMatch[2] || ''}`.trim());
  }
  if (!target) {
    // Fallback: choose the largest monetary value, avoiding month/year count.
    target = amounts.length ? Math.max(...amounts) : null;
  }
  if (!target || target <= 0) return null;

  return { target, months };
}

function solveRequiredMonthlyForTarget(target, months, annualRate, principal = 0) {
  const mr = annualRate / 12;
  const factor = ((Math.pow(1 + mr, months) - 1) / mr) * (1 + mr);
  const principalGrowth = principal * Math.pow(1 + annualRate, months / 12);
  const need = Math.max(0, target - principalGrowth);
  return factor > 0 ? Math.ceil(need / factor) : Math.ceil(need / months);
}

function buildGoalPlannerAnswer(session, userMessage) {
  const parsed = parseGoalPlanQuestion(userMessage);
  if (!parsed) return null;
  const p = session.profile || {};
  const income = p.monthly_income || p.income || 0;
  const expenses = Number.isFinite(p.expenses) ? p.expenses : 0;
  const savings = p.current_savings || p.savings || 0;
  const surplus = Math.max(0, income - expenses);
  const target = parsed.target;
  const months = parsed.months;

  const reqConservative = solveRequiredMonthlyForTarget(target, months, 0.08, savings);
  const reqModerate = solveRequiredMonthlyForTarget(target, months, 0.12, savings);

  const realistic = surplus >= reqConservative;
  const status = realistic
    ? `This target is realistic with your current cash flow.`
    : `This target is tight with current cash flow. You may need extra income or longer timeline.`;

  return [
    `Goal check: to reach ₹${financeService.formatINR(target)} in ${months} months, you need about ₹${financeService.formatINR(reqConservative)} to ₹${financeService.formatINR(reqModerate)}/month invested.`,
    `Your current monthly surplus is about ₹${financeService.formatINR(surplus)}.`,
    status,
    buildDiversificationText(session),
    buildAdvisorContactLine(),
  ].join('\n');
}

function makeGrowthLineData(session, responseObj) {
  const profile = session.profile || {};
  const analysis = responseObj.analysis || session.analysis || null;
  if (!analysis || !analysis.projections) return null;

  const p = analysis.projections;
  const start = profile.current_savings || profile.savings || 0;
  const current5 = Number.isFinite(p.current_5yr) ? p.current_5yr : null;
  const optimized5 = Number.isFinite(p.optimized_5yr) ? p.optimized_5yr : null;
  const current10 = Number.isFinite(p.current_10yr) ? p.current_10yr : null;
  const optimized10 = Number.isFinite(p.optimized_10yr) ? p.optimized_10yr : null;
  if ([current5, optimized5, current10, optimized10].some(v => v === null)) return null;

  return {
    kind: 'line_growth',
    labels: ['Now', 'Year 5', 'Year 10'],
    series: [
      { name: 'Current Path', values: [start, current5, current10] },
      { name: 'Optimized Path', values: [start, optimized5, optimized10] },
    ],
    highlights: {
      expected_growth_10yr: optimized10 - start,
      improvement_over_current_10yr: optimized10 - current10,
    },
  };
}

function buildEndAnalysisLine(session, responseObj) {
  const analysis = responseObj.analysis || session.analysis || null;
  if (!analysis || !analysis.projections) return '';

  const p = analysis.projections;
  if (!Number.isFinite(p.optimized_10yr) || !Number.isFinite(p.current_10yr)) return '';
  const delta = Math.max(0, p.optimized_10yr - p.current_10yr);
  const investable = Number.isFinite(analysis.investable_amount) ? analysis.investable_amount : null;

  return (
    `\n\nEnd summary:\n` +
    `- Expected 10-year value (optimized): ${financeService.formatCrLakh(p.optimized_10yr)}\n` +
    `- Current-path 10-year value: ${financeService.formatCrLakh(p.current_10yr)}\n` +
    `- Additional growth possible: ${financeService.formatCrLakh(delta)}` +
    (investable !== null ? `\n- Suggested monthly SIP: ₹${financeService.formatINR(investable)}` : '')
  );
}

function makeVisualData(session, responseObj) {
  const profile = session.profile || {};
  const income = profile.monthly_income || profile.income || 0;
  const expenses = profile.expenses || 0;
  const savings = profile.current_savings || profile.savings || 0;

  // Only compute projections when we at least have income; otherwise keep it simple.
  let analysis = responseObj.analysis || session.analysis || null;
  if (!analysis && income) {
    try {
      const safeProfile = {
        age: profile.age || 30,
        income: income,
        expenses: profile.expenses || Math.round(income * 0.7),
        savings: profile.current_savings || profile.savings || 0,
        risk: profile.risk || 'moderate',
        goal: profile.goal || 'wealth',
      };
      analysis = financeService.generateProjections(safeProfile);
    } catch (e) {
      analysis = null;
    }
  }

  const investable = (analysis && Number.isFinite(analysis.investable_amount))
    ? analysis.investable_amount
    : Math.max(0, Math.round((income || 0) - (expenses || 0)));

  const projection = (analysis && analysis.projections && Number.isFinite(analysis.projections.current_5yr) && Number.isFinite(analysis.projections.optimized_5yr))
    ? {
        labels: ['Current (5y)', 'Optimized (5y)'],
        values: [analysis.projections.current_5yr, analysis.projections.optimized_5yr],
        formatted: {
          'Current (5y)': financeService.formatCrLakh(analysis.projections.current_5yr),
          'Optimized (5y)': financeService.formatCrLakh(analysis.projections.optimized_5yr),
        }
      }
    : null;

  return {
    kind: 'simple_bar', // UI can interpret this
    labels: ['Income', 'Expenses', 'Savings', 'Investable'],
    values: [income, expenses, savings, investable],
    formatted: {
      Income: `₹${financeService.formatINR(income)}`,
      Expenses: `₹${financeService.formatINR(expenses)}`,
      Savings: `₹${financeService.formatINR(savings)}`,
      Investable: `₹${financeService.formatINR(investable)}`,
    },
    projection,
  };
}

// ─── Collection Phase Logic ───────────────────────────────────────────────────
async function handleCollectPhase(session, userMessage) {
  // Increment message counter
  session.message_count = (session.message_count || 0) + 1;

  // Skip off-topic detection while waiting for short factual replies
  const skipOfftopic = ['awaiting_expenses_or_savings','awaiting_savings_value','awaiting_expenses_value','awaiting_age_and_goal','awaiting_investments'].includes(session.flowStage);
  const offTopic = skipOfftopic ? false : await isOffTopic(userMessage, session.phase);
  if (offTopic) {
    return {
      message: `That's a bit outside my lane! 😊 I'm focused on helping you with your finances right now.\n\nCan you tell me a bit about your money concern?`,
      phase: 'collect',
      step: null,
      progress: Math.round((Object.keys(session.profile || {}).length / 5) * 100),
    };
  }

  // Handle dynamic target questions even during collection (natural mixed inputs).
  const collected = extractProfileFromMessage(userMessage, session.profile || {});
  if (collected.monthly_income && !collected.income) collected.income = collected.monthly_income;
  if (collected.current_savings !== undefined && collected.current_savings !== null && (collected.savings === null || collected.savings === undefined)) {
    collected.savings = collected.current_savings;
  }
  session.profile = collected;
  sessionStore.updateSession(session.id, { profile: session.profile, message_count: session.message_count });

  const collectGoalPlan = buildGoalPlannerAnswer(session, userMessage);
  if (collectGoalPlan) {
    const hasAge = !!session.profile.age;
    const hasIncome = !!(session.profile.income || session.profile.monthly_income);
    const hasExpenses = (session.profile.expenses || session.profile.expenses === 0);
    const nextAsk = !hasAge ? 'What is your age?' : !hasIncome ? 'What is your monthly income?' : !hasExpenses ? 'What are your monthly expenses?' : 'What is your risk style: conservative, moderate, or aggressive?';
    return {
      message: `${collectGoalPlan}\n\nTo personalize this more, ${nextAsk}`,
      phase: 'collect',
      step: buildStepMeta(session.currentStep || 0),
      progress: Math.round((Object.keys(session.profile || {}).length / 6) * 100),
      visual: makeGrowthLineData(session, {}),
    };
  }

  // Deterministic 6-step collection flow for stable testing and UX consistency.
  if (typeof session.currentStep === 'number' && session.currentStep < COLLECTION_STEPS.length) {
    // If the user asks a genuine finance question mid-collection, answer briefly,
    // then steer back to the current step (hybrid: standard chat + guided collection).
    {
      const step = COLLECTION_STEPS[session.currentStep];
      const text = String(userMessage || '').trim();
      const lower = text.toLowerCase();
      const looksLikeQuestion = /\?/.test(text) || /^(what|how|can|should|when|which|where)\b/i.test(text);

      const looksLikeStepAnswer = (() => {
        if (!step) return true;
        if (step.type === 'number') return /\d/.test(text) || /(none|zero|nothing)/i.test(text);
        if (step.type === 'choice') return (step.choices || []).some(c => lower === c || lower.includes(c));
        return true;
      })();

      const financeLike = /(sip|invest|investment|mutual\s*fund|mf\b|fd\b|ppf|nps|emi|loan|tax|retire|retirement|budget|saving|savings|wealth|goal)/i.test(lower);

      if (looksLikeQuestion && financeLike && !looksLikeStepAnswer) {
        const income = session.profile.monthly_income || session.profile.income || 0;
        const expenses = Number.isFinite(session.profile.expenses) ? session.profile.expenses : null;
        const surplus = (income && expenses !== null) ? Math.max(0, income - expenses) : null;
        const starterSip = (surplus !== null) ? Math.round(surplus * 0.7) : null;

        const quick = starterSip !== null
          ? `Quick answer: with your current details, a starting SIP could be around ₹${financeService.formatINR(starterSip)}/month (about 70% of your surplus).`
          : `Quick answer: I can give an accurate SIP/plan once I have income + expenses. As a simple start, many people target investing ~10–20% of take-home, then increase monthly.`;

        return {
          message: `${quick}\n\nTo personalize this properly, ${step.question}`,
          phase: 'collect',
          step: buildStepMeta(session.currentStep),
          progress: Math.round((session.currentStep / COLLECTION_STEPS.length) * 100),
        };
      }
    }

    const profileFromText = extractProfileFromMessage(userMessage, session.profile || {});
    if (profileFromText.monthly_income && !profileFromText.income) profileFromText.income = profileFromText.monthly_income;
    if (profileFromText.current_savings !== undefined && profileFromText.current_savings !== null && (profileFromText.savings === null || profileFromText.savings === undefined)) {
      profileFromText.savings = profileFromText.current_savings;
    }

    const readStepValue = (field, profile) => {
      if (field === 'income') return profile.income || profile.monthly_income;
      if (field === 'savings') return (profile.savings !== undefined && profile.savings !== null) ? profile.savings : profile.current_savings;
      return profile[field];
    };
    const writeStepValue = (field, value) => {
      session.profile[field] = value;
      if (field === 'income') session.profile.monthly_income = value;
      if (field === 'savings') session.profile.current_savings = value;
    };

    let nextStep = session.currentStep;
    while (nextStep < COLLECTION_STEPS.length) {
      const prefilled = readStepValue(COLLECTION_STEPS[nextStep].field, profileFromText);
      if (prefilled === undefined || prefilled === null || prefilled === '') break;
      writeStepValue(COLLECTION_STEPS[nextStep].field, prefilled);
      nextStep += 1;
    }

    // If no auto-fill happened, parse only the current expected step from raw text.
    if (nextStep === session.currentStep) {
      const step = COLLECTION_STEPS[session.currentStep];
      let raw = userMessage.trim();

      if (step.type === 'choice') {
        const lower = raw.toLowerCase();
        const match = (step.choices || []).find(c => lower === c || lower.includes(c));
        if (match) raw = match;
      } else if (step.type === 'number') {
        const extracted = readStepValue(step.field, profileFromText);
        if (extracted !== undefined && extracted !== null) raw = String(extracted);
      }

      const parsed = step.parse ? step.parse(raw) : raw;
      const validationValue = (step.type === 'number') ? parsed : raw;
      const validation = step.validate ? step.validate(validationValue) : { valid: true };
      if (!validation || validation.valid === false) {
        return {
          message: step.reprompt || `Please share ${step.field}.`,
          phase: 'collect',
          step: buildStepMeta(session.currentStep),
          progress: Math.round((session.currentStep / COLLECTION_STEPS.length) * 100),
        };
      }

      if (!session.profile) session.profile = {};
      writeStepValue(step.field, parsed);
      nextStep = session.currentStep + 1;
    }

    sessionStore.updateSession(session.id, { profile: session.profile, currentStep: nextStep });

    if (nextStep < COLLECTION_STEPS.length) {
      return {
        message: COLLECTION_STEPS[nextStep].question,
        phase: 'collect',
        step: buildStepMeta(nextStep),
        progress: Math.round((nextStep / COLLECTION_STEPS.length) * 100),
      };
    }

    const p = {
      age: session.profile.age || 30,
      income: session.profile.income || session.profile.monthly_income || 0,
      expenses: session.profile.expenses || 0,
      savings: session.profile.savings || session.profile.current_savings || 0,
      risk: session.profile.risk || 'moderate',
      goal: session.profile.goal || 'wealth',
    };
    const analysis = financeService.generateProjections(p);
    sessionStore.updateSession(session.id, { analysis, phase: 'hook', flowStage: 'analysis_complete' });
    const peak = buildPeakInsight(p);
    session.peak_insight = peak;
    return {
      message: `All set! Here's what you need to know:\n\n• Monthly SIP: ₹${financeService.formatINR(analysis.investable_amount)}\n• In 10 years: ₹${financeService.formatCrLakh(analysis.projections.optimized_10yr)}\n• Wealth gap: ₹${financeService.formatCrLakh(analysis.wealth_gap)}\n\n${peak}`,
      phase: 'hook',
      step: null,
      progress: 100,
      show_advisor_card: true,
      analysis,
      profile: session.profile,
      visual: makeGrowthLineData(session, { analysis }),
    };
  }

  // Silently extract structured data from user's natural message
  session.profile = extractProfileFromMessage(userMessage, session.profile || {});
  if (session.profile.monthly_income && !session.profile.income) session.profile.income = session.profile.monthly_income;
  if (session.profile.current_savings !== undefined && session.profile.current_savings !== null && (session.profile.savings === null || session.profile.savings === undefined)) {
    session.profile.savings = session.profile.current_savings;
  }
  sessionStore.updateSession(session.id, { profile: session.profile, message_count: session.message_count });

  // Decide stage
  const stage = advanceStage(session);

  // Progress indicator (simple ratio of extracted fields)
  const keys = ['age','monthly_income','current_savings','risk','goal'];
  const found = keys.reduce((n,k) => n + (session.profile && (session.profile[k] || session.profile[k] === 0) ? 1 : 0), 0);
  const progress = Math.round((found / keys.length) * 100);

  // If essential inputs are already present, finalize analysis immediately.
  if (session.profile && session.profile.age && (session.profile.monthly_income || session.profile.income) &&
      (session.profile.expenses || session.profile.expenses === 0) && session.profile.goal) {
    const income = session.profile.monthly_income || session.profile.income || 0;
    const p = {
      age: session.profile.age,
      income,
      expenses: session.profile.expenses,
      savings: session.profile.current_savings || session.profile.savings || 0,
      risk: session.profile.risk || 'moderate',
      goal: session.profile.goal || 'wealth',
    };
    const analysis = financeService.generateProjections(p);
    sessionStore.updateSession(session.id, { analysis, phase: 'hook', flowStage: 'analysis_complete' });
    const peak = buildPeakInsight(p);
    session.peak_insight = peak;
    return {
      message: `All set! Here's what you need to know:\n\n• Monthly SIP: ₹${financeService.formatINR(analysis.investable_amount)}\n• In 10 years: ₹${financeService.formatCrLakh(analysis.projections.optimized_10yr)}\n• Wealth gap: ₹${financeService.formatCrLakh(analysis.wealth_gap)}\n\n${peak}`,
      phase: 'hook',
      step: null,
      progress: 100,
      show_advisor_card: true,
      analysis,
      profile: session.profile,
      visual: makeGrowthLineData(session, { analysis }),
    };
  }

  // OPEN: friendly, human follow-up (asks about duration/emotion)
  // Handle inverted 'income-first' flow using flowStage
  // If no flow started and we just received income, provide immediate partial analysis
  if (!session.flowStage) {
    const incomeVal = session.profile.income || session.profile.monthly_income;
    if (incomeVal && !session.baselineShown) {
      // initialize profile for calculation with sensible defaults
      const income = Math.round(incomeVal);
      const partialProfile = {
        age:    session.profile.age || 30,
        income: income,
        expenses: Math.round(income * 0.7),
        savings: session.profile.current_savings || session.profile.savings || 0,
        risk: session.profile.risk || 'moderate',
        goal: session.profile.goal || 'wealth',
      };
      const analysis = financeService.generateProjections(partialProfile);
      sessionStore.updateSession(session.id, { profile: Object.assign({}, session.profile, { income }), flowStage: 'awaiting_expenses_or_savings', baselineShown: true });

      const msg = `Based on ₹${financeService.formatINR(income)}/month, here's a quick baseline:\n` +
        `• Investable today: ₹${financeService.formatINR(analysis.investable_amount)}/month\n` +
        `• Optimized (5yr): ${financeService.formatCrLakh(analysis.projections.optimized_5yr)}\n` +
        `• Estimated gap: ${financeService.formatCrLakh(analysis.wealth_gap)}\n\n` +
        `3 gaps detected — answer these to sharpen the picture:\n` +
        `1) Expenses or savings? (reply with a number or say 'expenses' / 'savings')\n` +
        `2) Your age + time-horizon (short vs long)\n` +
        `3) What's already working for you (investments)\n\n` +
        `Which would you like to tell me first?\n` +
        `Examples: "expenses 20k", "saved 1.2L", "age 24, long term"`;

      return { message: msg, phase: 'collect', step: null, progress: Math.min(20, progress) };
    }
  }

  // If we're in a flow, branch by flowStage
  if (session.flowStage === 'awaiting_expenses_or_savings') {
    const text = userMessage.toLowerCase();
    const amount = parseAmountINR(userMessage);
    // If user said 'savings' ask for amount
    if (/save|savings|saved/.test(text) && amount === null) {
      sessionStore.updateSession(session.id, { flowStage: 'awaiting_savings_value' });
      return { message: "How much have you saved? (Just a number)", phase: 'collect', step: null, progress };
    }
    // If user said 'expenses' ask for amount
    if (/expense|expenses|spend|spent/.test(text) && amount === null) {
      sessionStore.updateSession(session.id, { flowStage: 'awaiting_expenses_value' });
      return { message: "Total monthly expenses? (Rent, food, bills, etc.)", phase: 'collect', step: null, progress };
    }
    // If user provided a number, assume it's expenses
    if (amount !== null) {
      const val = amount;
      session.profile.expenses = val;
      sessionStore.updateSession(session.id, { profile: session.profile, flowStage: 'awaiting_age_and_goal' });

      // Update with new expense data
      const income = session.profile.monthly_income || session.profile.income || 0;
      const p = {
        age: session.profile.age || 30,
        income: income,
        expenses: session.profile.expenses,
        savings: session.profile.current_savings || session.profile.savings || 0,
        risk: session.profile.risk || 'moderate',
        goal: session.profile.goal || 'wealth',
      };
      const analysis = financeService.generateProjections(p);
      const msg = `Got it. You can invest ₹${financeService.formatINR(analysis.investable_amount)}/month.\n\nNow, how old are you?`;
      return { message: msg, phase: 'collect', step: null, progress: Math.min(50, progress) };
    }
  }

  if (session.flowStage === 'awaiting_savings_value' || session.flowStage === 'awaiting_expenses_value') {
    const amount = parseAmountINR(userMessage);
    if (amount !== null) {
      const val = amount;
      if (session.flowStage === 'awaiting_savings_value') session.profile.current_savings = val;
      else session.profile.expenses = val;
      if (session.profile.current_savings !== undefined && session.profile.current_savings !== null) session.profile.savings = session.profile.current_savings;
      sessionStore.updateSession(session.id, { profile: session.profile, flowStage: 'awaiting_age_and_goal' });

      const income = session.profile.monthly_income || session.profile.income || 0;
      const p = {
        age: session.profile.age || 30,
        income: income,
        expenses: session.profile.expenses || Math.round(income * 0.7),
        savings: session.profile.current_savings || session.profile.savings || 0,
        risk: session.profile.risk || 'moderate',
        goal: session.profile.goal || 'wealth',
      };
      const analysis = financeService.generateProjections(p);
      const msg = `Good. You can invest ₹${financeService.formatINR(analysis.investable_amount)}/month.\n\nHow old are you?`;
      return { message: msg, phase: 'collect', step: null, progress: Math.min(60, progress) };
    }
    return { message: "Just give me a number (like 1,50,000 or 'nothing')", phase: 'collect', step: null, progress };
  }

  if (session.flowStage === 'awaiting_age_and_goal') {
    // try to extract age and goal from message
    session.profile = extractProfileFromMessage(userMessage, session.profile || {});
    sessionStore.updateSession(session.id, { profile: session.profile });

    const hasAge = !!session.profile.age;
    const hasGoal = !!session.profile.goal;

    if (!hasAge && !hasGoal) {
      return { message: "Tell me your age and your main goal (retirement, house, wealth, or education)", phase: 'collect', step: null, progress: Math.min(70, progress) };
    }
    if (!hasAge) {
      return { message: "What's your age?", phase: 'collect', step: null, progress: Math.min(70, progress) };
    }
    if (!hasGoal) {
      return { message: "What's your main goal? (retirement, house, wealth, or education)", phase: 'collect', step: null, progress: Math.min(70, progress) };
    }

    // Profile is good enough to produce a stable analysis now.
    const income = session.profile.monthly_income || session.profile.income || 0;
    const p = {
      age: session.profile.age,
      income: income,
      expenses: session.profile.expenses || Math.round(income * 0.7),
      savings: session.profile.current_savings || session.profile.savings || 0,
      risk: session.profile.risk || 'moderate',
      goal: session.profile.goal || 'wealth',
    };
    const analysis = financeService.generateProjections(p);
    sessionStore.updateSession(session.id, { analysis, phase: 'hook', flowStage: 'analysis_complete' });
    const peak = buildPeakInsight(p);
    session.peak_insight = peak;
    const msg = `All set! Here's what you need to know:\n\n• Monthly SIP: ₹${financeService.formatINR(analysis.investable_amount)}\n• In 10 years: ₹${financeService.formatCrLakh(analysis.projections.optimized_10yr)}\n• Wealth gap: ₹${financeService.formatCrLakh(analysis.wealth_gap)}\n\n${peak}`;
    return {
      message: msg,
      phase: 'hook',
      step: null,
      progress: 100,
      show_advisor_card: true,
      analysis,
      profile: session.profile,
      visual: makeGrowthLineData(session, { analysis }),
    };
  }

  if (session.flowStage === 'awaiting_investments') {
    // Save freeform investments text
    session.profile.existing_investments_text = userMessage;
    sessionStore.updateSession(session.id, { profile: session.profile });

    // Finalise analysis and move to 'hook'
    const income = session.profile.monthly_income || session.profile.income || 0;
    const p = {
      age: session.profile.age || 30,
      income: income,
      expenses: session.profile.expenses || Math.round(income * 0.7),
      savings: session.profile.current_savings || session.profile.savings || 0,
      risk: session.profile.risk || 'moderate',
      goal: session.profile.goal || 'wealth',
    };
    const analysis = financeService.generateProjections(p);
    sessionStore.updateSession(session.id, { analysis, phase: 'hook' });
    const peak = buildPeakInsight(p);
    session.peak_insight = peak;

    const msg = `All set! Here's what you need to know:\n\n• Monthly SIP: ₹${financeService.formatINR(analysis.investable_amount)}\n• In 10 years: ₹${financeService.formatCrLakh(analysis.projections.optimized_10yr)}\n• Wealth gap: ₹${financeService.formatCrLakh(analysis.wealth_gap)}\n\n${peak}`;
    return {
      message: msg,
      phase: 'hook',
      step: null,
      progress: 100,
      show_advisor_card: true,
      analysis,
      profile: session.profile,
      visual: makeGrowthLineData(session, { analysis }),
    };
  }

  // Deterministic non-repetitive fallback prompts
  if (!session.profile.income) {
    return { message: 'What is your monthly income?', phase: 'collect', step: null, progress };
  }
  if (!session.profile.expenses && session.profile.expenses !== 0) {
    sessionStore.updateSession(session.id, { flowStage: 'awaiting_expenses_value' });
    return { message: "Monthly expenses?", phase: 'collect', step: null, progress };
  }
  if (!session.profile.age) {
    return { message: 'Your age?', phase: 'collect', step: null, progress };
  }
  if (!session.profile.goal) {
    return { message: 'Main goal? (retirement, house, wealth, or education)', phase: 'collect', step: null, progress };
  }
  sessionStore.updateSession(session.id, { flowStage: 'awaiting_investments' });
  return { message: "What’s already working for you right now (SIP, FD, PPF, stocks)?\nExamples: 'SIP 5k', 'FD only', 'nothing yet'", phase: 'collect', step: null, progress };
}

// ─── Trigger Analysis ─────────────────────────────────────────────────────────
async function triggerAnalysis(session) {
  // Set phase to analyzing
  sessionStore.updateSession(session.id, { phase: 'analyze' });

  // Run Groq analysis (or fallback)
  let analysis;
  try {
    const messages = [
      { role: 'system', content: prompts.ANALYSIS_PROMPT },
      { role: 'user', content: prompts.buildAnalysisUserMessage(session.profile) },
    ];
    analysis = await groqService.chatJSON(messages, {
      temperature: parseFloat(process.env.GROQ_ANALYSIS_TEMPERATURE) || 0.3,
      maxTokens:   1400,
    });
    console.log(`[Analysis] Groq analysis generated for session ${session.id}`);
  } catch (err) {
    console.warn(`[Analysis] Groq failed (${err.message}), using local calculations`);
    analysis = financeService.generateProjections(session.profile);
  }

  // Validate and sanitise the analysis
  analysis = sanitiseAnalysis(analysis, session.profile);

  // Store analysis, update phase
  sessionStore.updateSession(session.id, { analysis, phase: 'hook' });

  // Save to MongoDB
  try {
    if (process.env.MONGODB_URI) {
      await Lead.create({
        sessionId: session.id,
        userId: session.userId,
        name: session.name,
        profile: session.profile,
        analysis: analysis,
        status: 'completed',
      });
      console.log(`[Database] Lead saved for session ${session.id}`);
    }
  } catch (dbErr) {
    console.error(`[Database ERROR] Failed to save lead for session ${session.id}:`, dbErr.message);
  }

  const profileContext = prompts.buildProfileContext(session.profile);
  console.log(`[Analysis] Session ${session.id} → phase: hook`);

  return {
    message:  `✅ Analysis complete! I've mapped out your complete financial picture, ${session.profile.age}-year-old powerhouse. Here's what the numbers say:`,
    phase:    'hook',
    analysis,
    profile:  session.profile,
    progress: 100,
  };
}

// ─── Freeform Phase Logic ─────────────────────────────────────────────────────
async function handleFreeformPhase(session, userMessage) {
  if (isSpecificInvestmentAdviceQuery(userMessage)) {
    return {
      message: [
        `I can’t suggest specific mutual funds, AMCs, or stock picks.`,
        `I’m an AI assistant, and markets carry risk, so personal investment advice should come from a licensed expert.`,
        `${buildAdvisorContactLine()}`,
      ].join('\n'),
      phase: session.phase,
    };
  }

  const directGoalPlan = buildGoalPlannerAnswer(session, userMessage);
  if (directGoalPlan) {
    return {
      message: `${directGoalPlan}\n\n${buildPersonalizedNudge(session)}`,
      phase: session.phase,
      visual: makeGrowthLineData(session, {}),
    };
  }

  const profileContext = prompts.buildProfileContext(session.profile);
  const systemPrompt = prompts.CHAT_PROMPT
    .replace('{{PROFILE_CONTEXT}}', profileContext)
    .replace('{{GOAL}}', session.profile.goal || 'wealth');

  // Off-topic check for freeform too
  const offTopic = await isOffTopic(userMessage, 'freeform');
  if (offTopic) {
    return {
      message: `Ha, I appreciate the curiosity! But I'm at my best when talking about your money. 💰\n\nWas there something specific about your financial plan you wanted to explore?`,
      phase:   session.phase,
    };
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...session.history.slice(-12), // Last 12 messages for context
  ];

  let botMessage;
  try {
    botMessage = await groqService.chat(messages, {
      temperature: parseFloat(process.env.GROQ_CHAT_TEMPERATURE) || 0.3,
      maxTokens:   320,
    });
  } catch (err) {
    console.error('[freeform]', err.message);
    botMessage = "I had a brief connectivity issue. Based on your profile, I'd strongly recommend scheduling a session with your financial advisor to discuss this in detail.";
  }

  // Keep responses less repetitive and easier to follow.
  const lastAssistant = (session.history || []).filter(m => m.role === 'assistant').slice(-1)[0];
  if (lastAssistant && typeof lastAssistant.content === 'string') {
    const last = lastAssistant.content.trim().toLowerCase();
    const now = String(botMessage || '').trim().toLowerCase();
    if (last && now && last === now) {
      const goal = (session.profile && session.profile.goal) || 'wealth';
      botMessage = `To keep it practical: focus on your ${goal} goal with one monthly SIP plan and review it every 6 months.`;
    }
  }

  // If the user provided name + phone in freeform text, save the lead immediately
  try {
    const contact = extractContactFromMessage(userMessage);
    if (contact && contact.phone) {
      // If name is empty, try to use session name or fallback
      const leadName = contact.name || session.name || '';
      const leadObj = {
        name: leadName,
        phone: contact.phone,
        financial_profile: session.profile || {},
        conversation_summary: session.conversation_summary || '',
        peak_insight: session.peak_insight || '',
        chat_transcript: session.history || [],
      };

      const saved = leadsController.saveLeadObject(leadObj);
      // Also persist to MongoDB if configured
      if (process.env.MONGODB_URI) {
        try {
          await Lead.create({
            sessionId: session.id,
            userId: session.userId,
            name: saved.name,
            profile: saved.financial_profile,
            analysis: session.analysis || null,
            status: 'captured',
          });
        } catch (e) { /* ignore db errors */ }
      }

      // Mark session captured
      sessionStore.updateSession(session.id, { phase: 'captured' });
      const conf = `✅ Done — thanks ${saved.name || ''}! Piyush will reach out within 24 hours. He already has everything we discussed.`;
      return { message: conf, phase: 'captured' };
    }
  } catch (e) {
    console.error('[lead-save]', e && e.message);
  }

  // Update phase to advisor if user accepted the plan
  const acceptPhrases = ['yes', 'show me', 'connect me', 'book', 'yes please', 'absolutely', 'sure', 'let\'s do it', 'sign me up'];
  if (session.phase === 'hook' && acceptPhrases.some(p => userMessage.toLowerCase().includes(p))) {
    sessionStore.updateSession(session.id, { phase: 'advisor' });
    
    // Update Lead status in DB to indicate strong intent
    try {
      if (process.env.MONGODB_URI) {
        await Lead.updateOne({ sessionId: session.id }, { status: 'advisor_requested' });
      }
    } catch (e) {}
  }

  return {
    message: `${botMessage}${buildEndAnalysisLine(session, {})}\n\n${buildDiversificationText(session)}\n${buildAdvisorContactLine()}\n${buildPersonalizedNudge(session)}`,
    phase:   session.phase,
    visual: makeGrowthLineData(session, {}),
  };
}

// ─── POST /api/chat/analyze ───────────────────────────────────────────────────
/** Direct endpoint to force analysis (useful for testing and UI skip-to-result). */
async function forceAnalyze(req, res) {
  const { sessionId } = req.body;
  const session = sessionStore.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!financeService.isProfileComplete(session.profile)) {
    return res.status(400).json({ error: 'Profile incomplete', missingFields: getMissingFields(session.profile) });
  }

  try {
    const result = await triggerAnalysis(session);
    return res.json({ sessionId, ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/chat/session/:id ────────────────────────────────────────────────
function getSessionState(req, res) {
  const session = sessionStore.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });

  return res.json({
    sessionId: session.id,
    phase:     session.phase,
    profile:   session.profile,
    analysis:  session.analysis,
    step:      session.currentStep < COLLECTION_STEPS.length ? buildStepMeta(session.currentStep) : null,
    progress:  Math.round((session.currentStep / COLLECTION_STEPS.length) * 100),
    history:   session.history,
  });
}

// ─── DELETE /api/chat/session/:id ────────────────────────────────────────────
function deleteSessionHandler(req, res) {
  sessionStore.deleteSession(req.params.id);
  return res.json({ success: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildStepMeta(stepIndex) {
  const step = COLLECTION_STEPS[stepIndex];
  if (!step) return null;
  return {
    index:   stepIndex,
    total:   COLLECTION_STEPS.length,
    field:   step.field,
    hint:    step.hint,
    type:    step.type,
    choices: step.choices || null,
    display: step.display || null,
  };
}

function getMissingFields(profile) {
  return ['age', 'income', 'expenses', 'savings', 'risk', 'goal'].filter(f => !profile[f]);
}

/** Sanitise Groq analysis output — ensure all numbers are positive and present. */
function sanitiseAnalysis(analysis, profile) {
  // Run local calculations as a reference
  const local = financeService.generateProjections(profile);

  // Ensure projections exist and are positive numbers
  if (!analysis.projections || typeof analysis.projections !== 'object') {
    analysis.projections = local.projections;
  } else {
    for (const key of Object.keys(local.projections)) {
      const v = analysis.projections[key];
      if (!Number.isFinite(v) || v < 0) {
        analysis.projections[key] = local.projections[key];
      }
    }
  }

  // Ensure all top-level fields
  const defaults = {
    wealth_gap:           local.wealth_gap,
    hook_line:            local.hook_line,
    monthly_surplus:      local.monthly_surplus,
    investable_amount:    local.investable_amount,
    retirement_shortfall: local.retirement_shortfall,
    goal_timeline_years:  local.goal_timeline_years,
    key_risk:             local.key_risk,
    quick_wins:           local.quick_wins,
  };

  for (const [key, fallback] of Object.entries(defaults)) {
    if (!analysis[key] || (typeof analysis[key] === 'number' && !Number.isFinite(analysis[key]))) {
      analysis[key] = fallback;
    }
  }

  // Ensure insights array has 3 valid entries
  if (!Array.isArray(analysis.insights) || analysis.insights.length < 3) {
    analysis.insights = local.insights;
  }

  // Ensure quick_wins is an array
  if (!Array.isArray(analysis.quick_wins)) {
    analysis.quick_wins = local.quick_wins;
  }

  return analysis;
}

module.exports = {
  startSession,
  handleMessage,
  forceAnalyze,
  getSessionState,
  deleteSessionHandler,
};
