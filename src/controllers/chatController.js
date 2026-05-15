'use strict';

const sessionStore = require('../services/sessionStore');
const groqService = require('../services/groq');
const financeService = require('../services/finance');
const Lead = require('../models/Lead');
const {
  CHAT_PROMPT, COLLECTION_PROMPT, MID_CONVERSATION_HOOK_PROMPT,
  buildProfileContext, buildPartialProfileContext,
} = require('../prompts/system');

// ─── Collection Steps (psychology-driven order) ──────────────────────────────
// Flow: easy/exciting first → sensitive data after trust is built → contact AFTER value shown
const STEPS = [
  {
    key: 'name', type: 'text', phase_label: 'Getting to know you',
    question: "Hey there! 👋 I'm your personal financial intelligence assistant — think of me as that smart friend who actually knows about money.\n\nWhat should I call you?",
    suggestions: [],
  },
  {
    key: 'goal', type: 'choice_or_text', phase_label: 'Setting your goal',
    question: "Nice to meet you, {{name}}! 🎯\n\nBefore we dive into numbers, tell me — what's the one financial dream that keeps you excited?",
    suggestions: ['Buy a car 🚗', 'Dream home 🏠', 'Travel abroad ✈️', 'Build wealth 💰', 'Retirement fund 🏖️', 'Education fund 🎓', 'Wedding fund 💍', 'Emergency fund 🛡️'],
  },
  {
    key: 'age_bracket', type: 'choice', phase_label: 'Understanding you',
    question: "Quick one — which age group are you in? This helps me pick the right investment horizon for your **{{goal}}**.",
    suggestions: ['22-25', '26-30', '31-35', '36-40', '41-50', '50+'],
  },
  {
    key: 'monthly_salary', type: 'choice_or_text', phase_label: 'Analyzing income',
    question: "Now let's talk money 💰\n\nWhat's your monthly take-home salary? This stays between us — I need real numbers to give you a real plan, not generic advice.",
    suggestions: ['₹20,000-30,000', '₹30,000-50,000', '₹50,000-75,000', '₹75,000-1,00,000', '₹1,00,000-2,00,000', '₹2,00,000+'],
  },
  {
    key: 'basic_needs', type: 'choice_or_text', phase_label: 'Mapping expenses',
    question: "📌 **Expense 1/4: Essentials**\n\nHow much goes to the non-negotiables — rent, food, groceries, transport?",
    suggestions: 'dynamic', // Generated based on salary
  },
  {
    key: 'bills_payments', type: 'choice_or_text', phase_label: 'Mapping expenses',
    question: "📌 **Expense 2/4: Fixed Commitments**\n\nEMIs, insurance, utilities, phone/internet bills?",
    suggestions: ['₹0 (no EMIs)', '₹5,000-10,000', '₹10,000-20,000', '₹20,000-50,000'],
  },
  {
    key: 'personal_spending', type: 'choice_or_text', phase_label: 'Mapping expenses',
    question: "📌 **Expense 3/4: Lifestyle**\n\nShopping, eating out, subscriptions, entertainment — the fun stuff 😊",
    suggestions: 'dynamic',
  },
  {
    key: 'extra_unexpected', type: 'choice_or_text', phase_label: 'Almost there!',
    question: "📌 **Expense 4/4: Buffer**\n\nAny extra or unexpected costs — medical, events, emergencies? (₹0 if none)",
    suggestions: ['₹0', '₹2,000-5,000', '₹5,000-10,000', '₹10,000+'],
  },
  {
    key: 'risk_profile', type: 'choice', phase_label: 'Final step!',
    question: "Last one! 🎚️ How comfortable are you with investment ups and downs?\n\n• **Conservative** — Safety first, steady returns 🛡️\n• **Moderate** — Balance of growth & stability ⚖️\n• **Aggressive** — Maximum growth, okay with swings 🚀",
    suggestions: ['Conservative 🛡️', 'Moderate ⚖️', 'Aggressive 🚀'],
  },
];

// ─── Advisor Card ────────────────────────────────────────────────────────────
function getAdvisorCard() {
  return {
    name: process.env.ADVISOR_NAME || 'SEBI-Registered Advisor',
    registration: process.env.ADVISOR_REGISTRATION || 'SEBI RIA Registration (to be shared)',
    phone: process.env.ADVISOR_PHONE || '+91-XXXXXXXXXX',
    email: process.env.ADVISOR_EMAIL || 'advisor@pms.com',
    company: process.env.ADVISOR_COMPANY || 'PMS Advisory',
    whatsapp: process.env.ADVISOR_WHATSAPP || '919876543210',
  };
}

// ─── Question Detection ─────────────────────────────────────────────────────
function isQuestion(text) {
  const t = String(text || '').toLowerCase().trim();
  if (t.endsWith('?')) return true;
  return /^(what|why|how|when|which|can i|should i|is it|will|would|do i|does|tell me|explain|show me|compare)/.test(t);
}

// ─── Amount Parser (₹ Indian formats) ───────────────────────────────────────
function parseAmountINR(input) {
  const t = String(input || '').toLowerCase().trim();
  const m = t.match(/(\d[\d,]*(?:\.\d+)?)(?:\s*(k|l|lakh|lakhs|cr|crore))?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') n *= 1000;
  if (unit === 'l' || unit === 'lakh' || unit === 'lakhs') n *= 100000;
  if (unit === 'cr' || unit === 'crore') n *= 10000000;
  return Math.round(n);
}

// ─── Step Value Setter with Validation ──────────────────────────────────────
function setStepValue(session, key, rawMessage) {
  // Numeric fields (salary + expenses)
  if (['monthly_salary', 'basic_needs', 'bills_payments', 'personal_spending', 'extra_unexpected'].includes(key)) {
    const amount = parseAmountINR(rawMessage);
    if (amount === null) return { valid: false, error: 'Just the number is fine — like 25000 or 25k 😊' };
    const validation = financeService.validateProfileField(key, amount);
    if (!validation.valid) return validation;
    if (key === 'monthly_salary') {
      session.profile.monthly_salary = amount;
    } else {
      session.profile.expenses[key] = amount;
    }
    return { valid: true };
  }

  const cleaned = String(rawMessage || '').trim();

  // Risk profile — extract from chip labels like "Conservative 🛡️"
  if (key === 'risk_profile') {
    const riskMap = { conservative: 'conservative', moderate: 'moderate', aggressive: 'aggressive' };
    const lower = cleaned.toLowerCase();
    const matched = Object.keys(riskMap).find(r => lower.includes(r));
    if (!matched) return { valid: false, error: 'Pick one: Conservative, Moderate, or Aggressive 😊' };
    session.profile.risk_profile = matched;
    return { valid: true };
  }

  // Age bracket — extract from chip or freeform
  if (key === 'age_bracket') {
    const brackets = ['22-25', '26-30', '31-35', '36-40', '41-50', '50+'];
    const matched = brackets.find(b => cleaned.includes(b));
    if (matched) { session.profile.age_bracket = matched; return { valid: true }; }
    // Try parsing a raw age number
    const ageNum = parseInt(cleaned);
    if (ageNum >= 18 && ageNum <= 80) {
      const bracket = brackets.find(b => {
        if (b === '50+') return ageNum >= 50;
        const [lo, hi] = b.split('-').map(Number);
        return ageNum >= lo && ageNum <= hi;
      }) || '26-30';
      session.profile.age_bracket = bracket;
      return { valid: true };
    }
    return { valid: false, error: 'Just pick your age group or type your age 😊' };
  }

  // Goal — extract from chip labels (strip emoji)
  if (key === 'goal') {
    const goalText = cleaned.replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
    if (goalText.length < 2) return { valid: false, error: 'Tell me about your financial dream — even a few words work!' };
    session.profile.goal = goalText;
    return { valid: true };
  }

  // Phone (post-analysis)
  if (key === 'phone') {
    const digits = cleaned.replace(/\D/g, '').slice(-10);
    const validation = financeService.validateProfileField('phone', digits);
    if (!validation.valid) return validation;
    session.profile.phone = digits;
    return { valid: true };
  }

  // Address (optional post-analysis)
  if (key === 'address') {
    session.profile.address = cleaned;
    return { valid: true };
  }

  // Generic text fields (name)
  const validation = financeService.validateProfileField(key, cleaned);
  if (!validation.valid) return validation;
  session.profile[key] = cleaned;
  return { valid: true };
}

// ─── Dynamic Suggestion Builder ─────────────────────────────────────────────
function buildSuggestions(step, profile) {
  if (!step) return [];
  if (step.suggestions === 'dynamic') {
    return financeService.getExpenseSuggestions(profile.monthly_salary, step.key);
  }
  return step.suggestions || [];
}

// ─── Question Personalizer (inject profile data into question templates) ─────
function personalizeQuestion(question, profile) {
  return question
    .replace(/\{\{name\}\}/g, profile.name || 'friend')
    .replace(/\{\{goal\}\}/g, profile.goal || 'financial goal');
}

// ─── Step Metadata Builder ──────────────────────────────────────────────────
function buildStepMeta(index, profile) {
  const step = STEPS[index];
  if (!step) return null;
  const suggestions = buildSuggestions(step, profile || {});
  return {
    index, total: STEPS.length, field: step.key,
    type: step.type || 'text',
    suggestions,
    phase_label: step.phase_label || 'Building your plan',
    hint: step.type === 'choice_or_text' ? 'Or type your own answer...' :
          step.type === 'choice' ? 'Tap to select' : 'Type your answer...',
  };
}

// ─── Missing Fields Checker (phone/address NOT required for analysis) ────────
function missingFields(profile) {
  const required = ['name', 'monthly_salary', 'goal', 'risk_profile', 'age_bracket'];
  const missing = required.filter((k) => !profile[k]);
  const expenseFields = ['basic_needs', 'bills_payments', 'personal_spending', 'extra_unexpected'];
  for (const f of expenseFields) {
    if (profile.expenses[f] === null || profile.expenses[f] === undefined) missing.push(f);
  }
  return missing;
}

// ─── Build Rich Lead Summary ────────────────────────────────────────────────
function buildLeadSummary(profile, plan) {
  const expenses = profile.expenses || {};
  const totalExpenses = (expenses.basic_needs || 0) + (expenses.bills_payments || 0) +
                        (expenses.personal_spending || 0) + (expenses.extra_unexpected || 0);
  return {
    name: profile.name,
    age_bracket: profile.age_bracket,
    phone: profile.phone || null,
    address: profile.address || null,
    monthly_salary: profile.monthly_salary,
    expense_breakdown: {
      basic_needs: expenses.basic_needs || 0,
      bills_payments: expenses.bills_payments || 0,
      personal_spending: expenses.personal_spending || 0,
      extra_unexpected: expenses.extra_unexpected || 0,
      total: totalExpenses,
    },
    goal: profile.goal,
    risk_profile: profile.risk_profile,
    key_financial_insights: [
      `Monthly salary: ₹${financeService.formatINR(profile.monthly_salary)}`,
      `Total monthly expenses: ₹${financeService.formatINR(totalExpenses)}`,
      `Savings rate: ${plan.totals.savings_rate}%`,
      `Recommended monthly SIP: ₹${financeService.formatINR(plan.totals.recommended_sip_for_projection || plan.totals.investable_amount)}`,
      `MF Split: Flexi Cap ${Math.round(plan.fund_mix.flexi_cap * 100)}%, Mid Cap ${Math.round(plan.fund_mix.mid_cap * 100)}%, Small Cap ${Math.round(plan.fund_mix.small_cap * 100)}%`,
      plan.goal_projection ? plan.goal_projection.motivation : '',
      ...plan.expense_insights,
    ].filter(Boolean),
  };
}

// ─── Answer General Questions (Rich Context + History) ──────────────────────
async function answerGeneralQuestion(session, userMessage, fallbackPrompt) {
  const profile = session.profile || {};
  const plan = session.analysis?.plan || null;

  // Build full context from profile + analysis
  const profileContext = buildProfileContext(profile, plan);

  // Build conversation history (last 10 messages for context)
  const historyMessages = (session.history || [])
    .slice(-10)
    .map(msg => ({ role: msg.role, content: msg.content }));

  // Construct the system prompt with injected profile context
  const systemPrompt = CHAT_PROMPT.replace('{{PROFILE_CONTEXT}}', profileContext);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: userMessage },
  ];

  try {
    const response = await groqService.chat(messages, {
      temperature: parseFloat(process.env.GROQ_CHAT_TEMPERATURE) || 0.5,
      maxTokens: 400,
    });

    return fallbackPrompt ? `${response}\n\n${fallbackPrompt}` : response;
  } catch (e) {
    console.error('[answerGeneralQuestion]', e.message);
    return fallbackPrompt
      ? `I can help with that! ${fallbackPrompt}`
      : 'I had a brief hiccup processing that. Could you try asking again?';
  }
}

// ─── Start Session ──────────────────────────────────────────────────────────
async function startSession(req, res) {
  try {
    const { userId, name } = req.body || {};
    const session = sessionStore.createNewSession(userId, name);
    if (name) session.profile.name = name;

    const firstStep = name ? STEPS[1] : STEPS[0];
    const startIndex = name ? 1 : 0;
    if (name) session.currentStep = 1;

    const msg = name
      ? personalizeQuestion(firstStep.question, session.profile)
      : firstStep.question;

    sessionStore.addMessage(session.id, 'assistant', msg);

    // Endowed Progress: start at 15% so users feel they've already begun
    const progress = Math.max(15, Math.round((session.currentStep / STEPS.length) * 100));

    return res.json({
      sessionId: session.id,
      message: msg,
      phase: 'collect',
      step: buildStepMeta(session.currentStep, session.profile),
      progress,
    });
  } catch (err) {
    console.error('[startSession]', err);
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    const allowDetails = !isProd || String(process.env.DEBUG_ERRORS || '').toLowerCase() === 'true' || process.env.DEBUG_ERRORS === '1';
    // Avoid leaking internals in production unless DEBUG_ERRORS is explicitly enabled.
    return res.status(500).json({
      error: 'Failed to start session.',
      ...(allowDetails ? { detail: err && err.message ? String(err.message) : 'Unknown error' } : {}),
    });
  }
}

// ─── Generate Mid-Conversation Hook via LLM ────────────────────────────────
async function generateHook(session, hookContext) {
  try {
    const partialContext = buildPartialProfileContext(session.profile);
    const prompt = MID_CONVERSATION_HOOK_PROMPT
      .replace('{{PARTIAL_PROFILE}}', partialContext)
      .replace('{{HOOK_CONTEXT}}', hookContext);
    const response = await groqService.chat(
      [{ role: 'system', content: prompt }, { role: 'user', content: 'Generate the hook insight.' }],
      { temperature: 0.6, maxTokens: 200 }
    );
    return response;
  } catch (e) {
    console.error('[generateHook]', e.message);
    return null; // Non-fatal — skip hook if LLM fails
  }
}

// ─── Generate LLM Transition Message ────────────────────────────────────────
async function generateTransition(session, justAnswered, nextQuestion) {
  try {
    const partialContext = buildPartialProfileContext(session.profile);
    const systemPrompt = COLLECTION_PROMPT;
    const userMsg = `The user just answered the "${justAnswered}" question. Their partial profile:\n${partialContext}\n\nGenerate a warm, natural 1-2 sentence transition, then ask this next question:\n"${nextQuestion}"\n\nIMPORTANT: Keep it SHORT. Max 3 sentences total including the question. Do NOT repeat the question word-for-word — weave it naturally.`;
    const response = await groqService.chat(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
      { temperature: 0.65, maxTokens: 250 }
    );
    return response;
  } catch (e) {
    console.error('[generateTransition]', e.message);
    return null; // Fallback to template
  }
}

// ─── Handle Collection Phase ────────────────────────────────────────────────
async function handleCollectPhase(session, userMessage) {
  const step = STEPS[session.currentStep];
  if (!step) return null;

  // If user asks a question mid-collection, answer it then re-ask
  if (isQuestion(userMessage)) {
    const q = personalizeQuestion(step.question, session.profile);
    const progress = Math.max(15, Math.round((session.currentStep / STEPS.length) * 100));
    return {
      message: await answerGeneralQuestion(session, userMessage, `Now, ${q}`),
      phase: 'collect',
      step: buildStepMeta(session.currentStep, session.profile),
      progress,
    };
  }

  // Validate and set the value
  const result = setStepValue(session, step.key, userMessage);
  if (!result.valid) {
    const progress = Math.max(15, Math.round((session.currentStep / STEPS.length) * 100));
    return {
      message: result.error,
      phase: 'collect',
      step: buildStepMeta(session.currentStep, session.profile),
      progress,
      invalid: true,
    };
  }

  session.currentStep += 1;
  sessionStore.updateSession(session.id, { profile: session.profile, currentStep: session.currentStep });

  // More steps to go
  if (session.currentStep < STEPS.length) {
    const nextStep = STEPS[session.currentStep];
    const nextQuestion = personalizeQuestion(nextStep.question, session.profile);
    const progress = Math.max(15, Math.round((session.currentStep / STEPS.length) * 100));
    const remaining = STEPS.length - session.currentStep;
    const exp = session.profile.expenses || {};
    let hookMessage = null;
    let message = '';

    // ── Psychology Hooks at strategic moments ──
    // After salary: income percentile insight
    if (step.key === 'monthly_salary') {
      const pct = financeService.getIncomePercentile(session.profile.monthly_salary);
      hookMessage = await generateHook(session,
        `User just shared salary of ₹${financeService.formatINR(session.profile.monthly_salary)}. They earn more than ${pct}% of Indians. Create a brief encouraging insight about their income position and tease what we'll discover about their expense patterns.`
      );
    }
    // After all 4 expenses: dramatic surplus reveal
    else if (step.key === 'extra_unexpected') {
      const totalExp = (exp.basic_needs || 0) + (exp.bills_payments || 0) + (exp.personal_spending || 0) + (exp.extra_unexpected || 0);
      const surplus = (session.profile.monthly_salary || 0) - totalExp;
      const annualIdle = financeService.inflationLossPerYear(surplus * 12);
      hookMessage = await generateHook(session,
        `All 4 expense categories done. Total expenses: ₹${financeService.formatINR(totalExp)}. Monthly surplus: ₹${financeService.formatINR(surplus)}. Annual surplus sitting idle: ₹${financeService.formatINR(surplus * 12)}, losing ~₹${financeService.formatINR(annualIdle)} to inflation per year. Create a dramatic but encouraging reveal about their wealth-building potential. Use loss framing.`
      );
    }
    // After personal spending: benchmark comparison
    else if (step.key === 'personal_spending') {
      const bench = financeService.getExpenseBenchmark(session.profile.monthly_salary, 'personal_spending');
      if (bench) {
        const actualPct = Math.round((exp.personal_spending / session.profile.monthly_salary) * 100);
        hookMessage = await generateHook(session,
          `User spends ₹${financeService.formatINR(exp.personal_spending)} on lifestyle (${actualPct}% of income). Average for their salary bracket is ${bench.average_pct}% (~₹${financeService.formatINR(bench.average_amount)}). Create a brief non-judgmental comparison.`
        );
      }
    }

    // Try LLM transition, fallback to template
    const llmTransition = await generateTransition(session, step.key, nextQuestion);
    message = llmTransition || nextQuestion;

    const response = {
      message,
      phase: 'collect',
      step: buildStepMeta(session.currentStep, session.profile),
      progress,
      countdown: remaining <= 3 ? `${remaining} question${remaining === 1 ? '' : 's'} left 🔓` : null,
    };

    // Attach hook as separate field for frontend to render as milestone card
    if (hookMessage) {
      response.hookMessage = hookMessage;
    }

    return response;
  }

  // ─── All steps complete → Generate analysis ────────────────────────────────
  const plan = financeService.calculateFinancialPlan(session.profile);
  const advisor = getAdvisorCard();
  const summary = buildLeadSummary(session.profile, plan);

  // Save lead to MongoDB (phone/address collected post-analysis)
  try {
    if (process.env.MONGODB_URI) {
      await Lead.updateOne(
        { sessionId: session.id },
        {
          $set: {
            userId: session.userId,
            name: session.profile.name,
            sessionId: session.id,
            monthlySalary: session.profile.monthly_salary,
            goal: session.profile.goal,
            riskProfile: session.profile.risk_profile,
            keyFinancialInsights: summary.key_financial_insights,
            peakInsight: summary.key_financial_insights.join(' | '),
            conversationCompletedAt: new Date(),
            status: 'completed',
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
            conversationStartedAt: session.createdAt ? new Date(session.createdAt) : new Date(),
          },
        },
        { upsert: true }
      );
    }
  } catch (e) {
    console.error('[MongoDB Lead Save]', e.message);
  }

  // Update session to freeform
  sessionStore.updateSession(session.id, {
    phase: 'freeform',
    analysis: { plan, lead_summary: summary, advisor },
  });

  // Build the analysis response message
  const projectionText = plan.projections
    .map((p) => `📊 **${p.years}Y**: ₹${financeService.formatINR(p.monthly_investment)}/mo → ${p.expected_value_formatted}`)
    .join('\n');

  const categoryBreakdown = plan.category_optimization
    .map(c => `${c.icon} ${c.label}: ₹${financeService.formatINR(c.amount)} (${c.actual_pct}%)${c.is_over_budget ? ' ⚠️' : ' ✅'}`)
    .join('\n');

  const sipAmount = plan.totals.recommended_sip_for_projection || plan.totals.investable_amount;

  return {
    phase: 'freeform',
    progress: 100,
    analysis: { plan, lead_summary: summary, advisor },
    profile: session.profile,
    show_advisor_card: true,
    // Post-analysis lead capture: ask for phone to save the plan
    leadCapture: {
      prompt: `Your financial roadmap is ready! 🎉 Want me to save it and have our advisor reach out with specific fund recommendations?`,
      suggestions: ['Yes, save my plan! 📱', 'Maybe later'],
      field: 'phone',
    },
    message: [
      `🎉 **${session.profile.name}, your personalized financial roadmap is ready!**`,
      '',
      `💰 **Monthly Snapshot**`,
      `Income: ₹${financeService.formatINR(plan.totals.monthly_salary)} → Expenses: ₹${financeService.formatINR(plan.totals.total_expenses)} → **Surplus: ₹${financeService.formatINR(plan.totals.monthly_surplus)}** (${plan.totals.savings_rate}% savings rate)`,
      '',
      `📋 **Where Your Money Goes**`,
      categoryBreakdown,
      '',
      `📈 **Your Investment Plan** (SIP: ₹${financeService.formatINR(sipAmount)}/month)`,
      projectionText,
      '',
      `🎯 **Goal**: ${plan.goal_projection.motivation}`,
      '',
      `💬 Ask me anything about your finances — I'll answer using your actual numbers!`,
    ].join('\n'),
  };
}

// ─── Handle Freeform Phase ──────────────────────────────────────────────────
async function handleFreeformPhase(session, userMessage) {
  const advisor = getAdvisorCard();
  const advisorNudge = `For personalised execution support, connect with ${advisor.name} at ${advisor.phone}.`;
  const response = await answerGeneralQuestion(session, userMessage, '');

  // Append a subtle advisor nudge every 3rd freeform message
  const freeformCount = (session.history || []).filter(m => m.role === 'user').length;
  const withNudge = (freeformCount % 3 === 0)
    ? `${response}\n\n💡 _${advisorNudge}_`
    : response;

  return {
    message: withNudge,
    phase: session.phase,
    analysis: session.analysis,
    profile: session.profile,
  };
}

// ─── Handle Message (Main Router) ───────────────────────────────────────────
async function handleMessage(req, res) {
  const { sessionId, message } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ error: 'sessionId is required.' });
  if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message cannot be empty.' });

  const session = sessionStore.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session expired or not found. Please start a new conversation.', code: 'SESSION_EXPIRED' });

  const userMessage = message.trim();
  sessionStore.addMessage(sessionId, 'user', userMessage);

  let response;
  if (session.phase === 'collect') {
    response = await handleCollectPhase(session, userMessage);
  } else {
    response = await handleFreeformPhase(session, userMessage);
  }

  sessionStore.addMessage(sessionId, 'assistant', response.message);
  return res.json({ sessionId, ...response });
}

// ─── Force Analyze ──────────────────────────────────────────────────────────
async function forceAnalyze(req, res) {
  const { sessionId } = req.body || {};
  const session = sessionStore.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const missing = missingFields(session.profile || {});
  if (missing.length > 0) return res.status(400).json({ error: 'Profile incomplete', missingFields: missing });

  const plan = financeService.calculateFinancialPlan(session.profile);
  const summary = buildLeadSummary(session.profile, plan);
  return res.json({
    sessionId,
    phase: session.phase,
    analysis: { plan, lead_summary: summary, advisor: getAdvisorCard() },
    profile: session.profile,
  });
}

// ─── Get Session State ──────────────────────────────────────────────────────
function getSessionState(req, res) {
  const session = sessionStore.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });

  return res.json({
    sessionId: session.id,
    phase: session.phase,
    profile: session.profile,
    analysis: session.analysis,
    step: buildStepMeta(session.currentStep, session.profile),
    progress: Math.max(15, Math.round((session.currentStep / STEPS.length) * 100)),
    history: session.history,
  });
}

// ─── Delete Session ─────────────────────────────────────────────────────────
function deleteSessionHandler(req, res) {
  sessionStore.deleteSession(req.params.id);
  return res.json({ success: true });
}

module.exports = {
  startSession,
  handleMessage,
  forceAnalyze,
  getSessionState,
  deleteSessionHandler,
};
