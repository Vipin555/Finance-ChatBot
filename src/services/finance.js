'use strict';

/**
 * services/finance.js
 * ────────────────────
 * Pure financial calculation functions.
 * Used as fallback when Groq API is unavailable,
 * and for server-side validation of Groq's output.
 */

// ─── Return rates by risk profile ─────────────────────────────────────────────
const RATES = {
  conservative: 0.08,
  moderate:     0.12,
  aggressive:   0.16,
};
const FD_RATE = 0.065; // Bank FD / savings baseline

/**
 * Future Value of a lump sum + recurring monthly investment.
 * @param {number} principal  - Starting capital
 * @param {number} monthly    - Monthly recurring investment
 * @param {number} annualRate - Annual interest rate (decimal)
 * @param {number} years      - Number of years
 * @returns {number}
 */
function futureValue(principal, monthly, annualRate, years) {
  const n  = years * 12;
  const mr = annualRate / 12;
  const lumpsumGrowth = principal * Math.pow(1 + annualRate, years);
  // SIP future value formula: P × [(1+r)^n - 1] / r × (1+r)
  const sipGrowth = monthly > 0
    ? monthly * ((Math.pow(1 + mr, n) - 1) / mr) * (1 + mr)
    : 0;
  return Math.round(lumpsumGrowth + sipGrowth);
}

/**
 * Generate complete financial projections from session profile.
 * Returns the same schema as ANALYSIS_PROMPT expects from Groq.
 */
function generateProjections(profile) {
  const { age, income, expenses, savings, risk, goal } = profile;
  const surplus        = income - expenses;
  const investable     = Math.round(surplus * 0.70);
  const rate           = RATES[risk] || RATES.moderate;
  const yearsToRetire  = Math.max(1, 60 - age);
  const annualExpenses = expenses * 12;
  const retirementNeed = annualExpenses * 25; // 4% withdrawal rule

  // ── Current path (FD only, no new investment) ────────────────────────────
  const cur3  = futureValue(savings, 0,          FD_RATE, 3);
  const cur5  = futureValue(savings, 0,          FD_RATE, 5);
  const cur10 = futureValue(savings, 0,          FD_RATE, 10);

  // ── Optimized path (MF SIPs at risk rate) ───────────────────────────────
  const opt3  = futureValue(savings, investable, rate,         3);
  const opt5  = futureValue(savings, investable, rate,         5);
  const opt10 = futureValue(savings, investable, rate,         10);

  // ── Max (advisor-guided: +25% SIP, +3% rate boost) ──────────────────────
  const max10 = futureValue(savings, Math.round(investable * 1.25), rate + 0.03, 10);

  // ── Retirement projection ──────────────────────────────────────────────
  const atRetirement   = futureValue(savings, investable, rate, yearsToRetire);
  const shortfall      = Math.max(0, retirementNeed - atRetirement);

  // ── Goal timeline ───────────────────────────────────────────────────────
  const goalTargets = {
    retirement: retirementNeed,
    house:      income * 60,       // ~5× annual income
    wealth:     savings * 10,      // 10× current savings
    education:  income * 36,       // 3 years of income
  };
  const goalTarget = goalTargets[goal] || goalTargets.wealth;
  const goalTimelineYears = estimateGoalTimeline(savings, investable, rate, goalTarget);

  // ── Wealth gap ─────────────────────────────────────────────────────────
  const wealthGap = opt10 - cur10;

  // ── Key risk ───────────────────────────────────────────────────────────
  const savingsRate = surplus / income;
  let keyRisk = 'Inflation eroding idle savings (FD returns < real inflation)';
  if (savingsRate < 0.15) keyRisk = 'Low savings rate — any income shock could be critical';
  if (risk === 'aggressive' && savings < income * 3) keyRisk = 'Insufficient emergency fund for aggressive investments';
  if (age > 50 && shortfall > 500000) keyRisk = 'Insufficient retirement corpus at current savings pace';

  // ── Quick wins ─────────────────────────────────────────────────────────
  const quickWins = buildQuickWins(profile, surplus, investable);

  // ── Hook line ──────────────────────────────────────────────────────────
  const hookLine = buildHookLine(wealthGap, opt10, investable, goal);

  // ── Insights ───────────────────────────────────────────────────────────
  const insights = buildInsights(profile, surplus, investable, opt10, cur10, yearsToRetire);

  return {
    projections: {
      current_3yr:    cur3,
      current_5yr:    cur5,
      current_10yr:   cur10,
      optimized_3yr:  opt3,
      optimized_5yr:  opt5,
      optimized_10yr: opt10,
      max_10yr:       max10,
    },
    insights,
    wealth_gap:           wealthGap,
    hook_line:            hookLine,
    monthly_surplus:      surplus,
    investable_amount:    investable,
    retirement_shortfall: shortfall,
    goal_timeline_years:  goalTimelineYears,
    key_risk:             keyRisk,
    quick_wins:           quickWins,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function estimateGoalTimeline(principal, monthly, rate, target) {
  // Binary search for years until FV >= target
  let lo = 0, hi = 40;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (futureValue(principal, monthly, rate, mid) >= target) hi = mid;
    else lo = mid + 1;
  }
  return Math.min(lo, 40);
}

function buildHookLine(gap, opt10, investable, goal) {
  const fmtGap = formatCrLakh(gap);
  const fmtOpt = formatCrLakh(opt10);
  return `₹${formatINR(investable)}/month SIP could grow to ₹${fmtOpt} in 10 years — don't leave ₹${fmtGap} behind.`;
}

function buildInsights(profile, surplus, investable, opt10, cur10, yearsToRetire) {
  const { age, income, expenses, savings, risk, goal } = profile;
  const rate = RATES[risk] || RATES.moderate;

  return [
    {
      title: '💡 Your Savings Rate',
      description: `You save ₹${formatINR(surplus)}/month — ${((surplus / income) * 100).toFixed(0)}% of income. Directing ₹${formatINR(investable)} into a ${risk} SIP portfolio could grow this to ₹${formatCrLakh(opt10)} over 10 years.`,
      impact: `+₹${formatCrLakh(opt10 - cur10)} vs. keeping in an FD`,
    },
    {
      title: '⏱️ The Compounding Clock',
      description: `At ${age}, you have ${yearsToRetire} years until retirement. Each year of delay costs roughly ₹${formatCrLakh(Math.round(opt10 * 0.08))} in compounding loss. Starting this month matters more than the amount.`,
      impact: 'Every month of delay = lost lakhs',
    },
    {
      title: `🎯 ${goal.charAt(0).toUpperCase() + goal.slice(1)} Goal Timeline`,
      description: `Based on your ₹${formatINR(investable)}/month investable surplus and ${risk} risk profile, your ${goal} goal has a realistic timeline. An advisor can optimise this further with tax-efficient instruments.`,
      impact: `Goal possible — advisor can fast-track it`,
    },
  ];
}

function buildQuickWins(profile, surplus, investable) {
  const { savings, income, risk, goal } = profile;
  const wins = [];

  // Emergency fund check
  const emergencyTarget = income * 6;
  if (savings < emergencyTarget) {
    wins.push(`Build your emergency fund to ₹${formatINR(emergencyTarget)} (6 months of income) before investing.`);
  }

  // SIP suggestion
  const sipTypes = { conservative: 'debt hybrid MF', moderate: 'flexi-cap MF', aggressive: 'small/mid cap MF' };
  wins.push(`Start a ₹${formatINR(investable)}/month SIP in a ${sipTypes[risk] || 'diversified'} this month.`);

  // Tax saving
  wins.push(`Check if you are using your full ₹1.5L Section 80C limit — ELSS funds give equity returns + tax savings.`);

  // Goal-specific
  const goalWins = {
    house:      'Get pre-approved for a home loan to know your exact purchasing capacity today.',
    education:  'Open a Sukanya Samriddhi / PPF account for guaranteed, tax-free education corpus.',
    retirement: 'Activate your NPS account — employer contributions are an instant 10% return on investment.',
    wealth:     'Consider rebalancing any idle FDs above 3 months of expenses into equity MFs.',
  };
  if (goalWins[goal]) wins.push(goalWins[goal]);

  return wins.slice(0, 3);
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatINR(n) {
  if (!n && n !== 0) return '0';
  return new Intl.NumberFormat('en-IN').format(Math.round(n));
}

function formatCrLakh(n) {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)} L`;
  return formatINR(n);
}

// ─── Profile validation ───────────────────────────────────────────────────────

const VALIDATORS = {
  age:      v => Number.isFinite(v) && v >= 18 && v <= 80,
  income:   v => Number.isFinite(v) && v >= 1000,
  expenses: v => Number.isFinite(v) && v >= 0,
  savings:  v => Number.isFinite(v) && v >= 0,
  risk:     v => ['conservative', 'moderate', 'aggressive'].includes(v),
  goal:     v => ['retirement', 'house', 'wealth', 'education'].includes(v),
};

function validateProfileField(field, value) {
  const validator = VALIDATORS[field];
  if (!validator) return { valid: false, error: `Unknown field: ${field}` };
  if (!validator(value)) return { valid: false, error: getValidationError(field) };
  return { valid: true };
}

function getValidationError(field) {
  const errors = {
    age:      'Age must be between 18 and 80',
    income:   'Income must be at least ₹1,000/month',
    expenses: 'Expenses cannot be negative',
    savings:  'Savings cannot be negative',
    risk:     'Risk must be conservative, moderate, or aggressive',
    goal:     'Goal must be retirement, house, wealth, or education',
  };
  return errors[field] || 'Invalid value';
}

function isProfileComplete(profile) {
  return ['age', 'income', 'expenses', 'savings', 'risk', 'goal'].every(
    field => profile[field] !== null && profile[field] !== undefined
  );
}

module.exports = {
  futureValue,
  generateProjections,
  validateProfileField,
  isProfileComplete,
  formatINR,
  formatCrLakh,
  RATES,
  FD_RATE,
};
