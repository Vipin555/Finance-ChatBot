'use strict';

const sessionStore = require('../services/sessionStore');
const groqService = require('../services/groq');
const financeService = require('../services/finance');
const Lead = require('../models/Lead');
const { CHAT_PROMPT, GOAL_MOTIVATION_PROMPT, buildProfileContext } = require('../prompts/system');

// ─── Collection Steps ────────────────────────────────────────────────────────
const STEPS = [
  { key: 'name', question: '👋 Welcome to your PMS wealth assistant! I\'m here to help you build a smart investment plan. Let\'s start — what is your full name?' },
  { key: 'address', question: 'Great to meet you! Please share your current address.' },
  { key: 'phone', question: 'What is your 10-digit mobile number?' },
  { key: 'monthly_salary', question: 'What is your monthly take-home salary (in ₹)?' },
  { key: 'basic_needs', question: 'Now let\'s understand your expenses. How much do you spend monthly on **Basic Needs** — rent, food, groceries, transport?' },
  { key: 'bills_payments', question: 'How much goes to **Bills & Payments** — loan EMIs, insurance premiums, utilities, phone bills?' },
  { key: 'personal_spending', question: 'What about **Personal Spending** — shopping, eating out, subscriptions, entertainment?' },
  { key: 'extra_unexpected', question: 'Lastly on expenses — any **Extra / Unexpected** costs — medical, events, emergencies? (Enter 0 if none)' },
  { key: 'goal', question: '🎯 What is your main financial goal? For example: buy a car, Australia trip, dream home, build wealth, retirement, etc.' },
  { key: 'risk_profile', question: 'Last one! What\'s your risk comfort level? Choose: **conservative**, **moderate**, or **aggressive**.' },
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
  if (['monthly_salary', 'basic_needs', 'bills_payments', 'personal_spending', 'extra_unexpected'].includes(key)) {
    const amount = parseAmountINR(rawMessage);
    if (amount === null) return { valid: false, error: 'Please share the amount in numbers (example: 25000 or 25k).' };
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
  const validation = financeService.validateProfileField(key, cleaned);
  if (!validation.valid) return validation;

  if (key === 'risk_profile') {
    session.profile.risk_profile = cleaned.toLowerCase();
  } else {
    session.profile[key] = cleaned;
  }
  return { valid: true };
}

// ─── Step Metadata Builder ──────────────────────────────────────────────────
function buildStepMeta(index) {
  const step = STEPS[index];
  return step
    ? { index, total: STEPS.length, field: step.key }
    : null;
}

// ─── Missing Fields Checker ─────────────────────────────────────────────────
function missingFields(profile) {
  const required = ['name', 'address', 'phone', 'monthly_salary', 'goal', 'risk_profile'];
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
    address: profile.address,
    phone: profile.phone,
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
      `Potential monthly savings buffer: ₹${financeService.formatINR(plan.totals.suggested_savings)}`,
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

    const msg = name
      ? `Welcome ${name}! 🎯 I'm your PMS wealth assistant. Let's understand your finances and build a smart investment plan.\n\n${STEPS[1].question}`
      : STEPS[0].question;
    if (name) session.currentStep = 1;

    sessionStore.addMessage(session.id, 'assistant', msg);

    return res.json({
      sessionId: session.id,
      message: msg,
      phase: 'collect',
      step: buildStepMeta(session.currentStep),
      progress: Math.round((session.currentStep / STEPS.length) * 100),
    });
  } catch (err) {
    console.error('[startSession]', err);
    return res.status(500).json({ error: 'Failed to start session.' });
  }
}

// ─── Handle Collection Phase ────────────────────────────────────────────────
async function handleCollectPhase(session, userMessage) {
  const step = STEPS[session.currentStep];
  if (!step) return null;

  // If user asks a question mid-collection, answer it then re-ask
  if (isQuestion(userMessage)) {
    return {
      message: await answerGeneralQuestion(session, userMessage, `Now, ${step.question}`),
      phase: 'collect',
      step: buildStepMeta(session.currentStep),
      progress: Math.round((session.currentStep / STEPS.length) * 100),
    };
  }

  // Validate and set the value
  const result = setStepValue(session, step.key, userMessage);
  if (!result.valid) {
    return {
      message: `${result.error} ${step.question}`,
      phase: 'collect',
      step: buildStepMeta(session.currentStep),
      progress: Math.round((session.currentStep / STEPS.length) * 100),
      invalid: true,
    };
  }

  session.currentStep += 1;
  sessionStore.updateSession(session.id, { profile: session.profile, currentStep: session.currentStep });

  // More steps to go
  if (session.currentStep < STEPS.length) {
    const nextStep = STEPS[session.currentStep];
    // Personalize transition messages based on which step we're moving to
    let prefix = 'Noted. ';
    const exp = session.profile.expenses || {};

    if (session.currentStep === 4) {
      // Moving from salary → first expense
      prefix = `Got it, ₹${financeService.formatINR(session.profile.monthly_salary)} salary. Now let's understand your expenses across 4 categories — one by one.\n\n📌 **Category 1 of 4:**\n`;
    } else if (session.currentStep === 5) {
      // After basic needs → bills
      prefix = `✅ Basic Needs: ₹${financeService.formatINR(exp.basic_needs || 0)}/month\n\n📌 **Category 2 of 4:**\n`;
    } else if (session.currentStep === 6) {
      // After bills → personal spending
      const runningTotal = (exp.basic_needs || 0) + (exp.bills_payments || 0);
      prefix = `✅ Bills & Payments: ₹${financeService.formatINR(exp.bills_payments || 0)}/month (Running total: ₹${financeService.formatINR(runningTotal)})\n\n📌 **Category 3 of 4:**\n`;
    } else if (session.currentStep === 7) {
      // After personal spending → extra
      const runningTotal = (exp.basic_needs || 0) + (exp.bills_payments || 0) + (exp.personal_spending || 0);
      prefix = `✅ Personal Spending: ₹${financeService.formatINR(exp.personal_spending || 0)}/month (Running total: ₹${financeService.formatINR(runningTotal)})\n\n📌 **Category 4 of 4 — last one!**\n`;
    } else if (session.currentStep === 8) {
      // After all 4 expenses → goal
      const totalExp = (exp.basic_needs || 0) + (exp.bills_payments || 0) + (exp.personal_spending || 0) + (exp.extra_unexpected || 0);
      const surplus = (session.profile.monthly_salary || 0) - totalExp;
      prefix = `✅ All expenses captured!\n\n💰 **Your monthly snapshot:**\nSalary: ₹${financeService.formatINR(session.profile.monthly_salary)} | Expenses: ₹${financeService.formatINR(totalExp)} | Surplus: ₹${financeService.formatINR(surplus)}\n\nNow let's set your goals.\n\n`;
    }

    return {
      message: `${prefix}${nextStep.question}`,
      phase: 'collect',
      step: buildStepMeta(session.currentStep),
      progress: Math.round((session.currentStep / STEPS.length) * 100),
    };
  }

  // ─── All steps complete → Generate analysis ────────────────────────────────
  const plan = financeService.calculateFinancialPlan(session.profile);
  const advisor = getAdvisorCard();
  const summary = buildLeadSummary(session.profile, plan);

  // Save lead to MongoDB
  try {
    if (process.env.MONGODB_URI) {
      await Lead.updateOne(
        { sessionId: session.id },
        {
          $set: {
            userId: session.userId,
            name: session.profile.name,
            phone: session.profile.phone,
            address: session.profile.address,
            sessionId: session.id,
            monthlySalary: session.profile.monthly_salary,
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

  // Build the rich analysis response message
  const projectionText = plan.projections
    .map((p) => `📊 **${p.years}Y**: Invest ₹${financeService.formatINR(p.monthly_investment)}/month → Expected ${p.expected_value_formatted}`)
    .join('\n');

  const categoryBreakdown = plan.category_optimization
    .map(c => `${c.icon} ${c.label}: ₹${financeService.formatINR(c.amount)} (${c.actual_pct}% of income)${c.is_over_budget ? ' ⚠️' : ' ✅'}`)
    .join('\n');

  const fundMixText = `Flexi Cap: ${Math.round(plan.fund_mix.flexi_cap * 100)}% (₹${financeService.formatINR(plan.fund_mix_amounts.flexi_cap)}), Mid Cap: ${Math.round(plan.fund_mix.mid_cap * 100)}% (₹${financeService.formatINR(plan.fund_mix_amounts.mid_cap)}), Small Cap: ${Math.round(plan.fund_mix.small_cap * 100)}% (₹${financeService.formatINR(plan.fund_mix_amounts.small_cap)})`;

  const insightsText = plan.expense_insights.join('\n');
  const projectionBasisNote = plan.totals.projection_basis === 'post_optimization'
    ? 'Note: SIP and projections are based on the post-optimization plan (after reducing Personal Spending and Extra / Unexpected).'
    : 'Note: SIP and projections are based on your current surplus.';

  return {
    phase: 'freeform',
    progress: 100,
    analysis: { plan, lead_summary: summary, advisor },
    profile: session.profile,
    message: [
      `🎉 **Your PMS Financial Profile is ready, ${session.profile.name}!**`,
      '',
      `💰 **Monthly Summary**`,
      `Salary: ₹${financeService.formatINR(plan.totals.monthly_salary)} | Expenses: ₹${financeService.formatINR(plan.totals.total_expenses)} | Surplus: ₹${financeService.formatINR(plan.totals.monthly_surplus)} (${plan.totals.savings_rate}% savings rate)`,
      '',
      `📋 **Expense Breakdown**`,
      categoryBreakdown,
      '',
      `💡 **Insights**`,
      insightsText,
      '',
      `📈 **Investment Plan** (SIP: ₹${financeService.formatINR(plan.totals.recommended_sip_for_projection || plan.totals.investable_amount)}/month)`,
      projectionBasisNote,
      `Fund Split: ${fundMixText}`,
      '',
      `🔮 **Projections**`,
      projectionText,
      '',
      `🎯 **Goal**: ${plan.goal_projection.motivation}`,
      '',
      `👨‍💼 **Your Advisor**: ${advisor.name} (${advisor.registration}) | ${advisor.phone} | ${advisor.email}`,
      '',
      '💬 You can now ask me any finance question and I\'ll answer based on your profile!',
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
    step: buildStepMeta(session.currentStep),
    progress: Math.round((session.currentStep / STEPS.length) * 100),
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
