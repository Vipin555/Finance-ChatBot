'use strict';

// ─── Assumed Annual Returns by Fund Type ─────────────────────────────────────
const ASSUMED_RETURNS = {
  flexi_cap: 0.12,
  mid_cap: 0.14,
  small_cap: 0.16,
};

// ─── Default Goal Corpus Estimates (₹) ───────────────────────────────────────
const GOAL_CORPUS = {
  car:        800000,
  bike:       250000,
  australia:  500000,
  travel:     500000,
  trip:       400000,
  house:      1500000,
  home:       1500000,
  flat:       1500000,
  education:  1000000,
  wedding:    1200000,
  marriage:   1200000,
  retirement: 10000000,
  wealth:     5000000,
  emergency:  300000,
  laptop:     100000,
  phone:      80000,
};

// ─── Utilities ───────────────────────────────────────────────────────────────
function toNumber(v) {
  return Number.isFinite(v) ? v : 0;
}

function formatINR(n) {
  return new Intl.NumberFormat('en-IN').format(Math.round(toNumber(n)));
}

function formatCrLakh(n) {
  n = toNumber(n);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} Lakh`;
  return `₹${formatINR(n)}`;
}

// ─── SIP Future Value (standard compound formula) ────────────────────────────
function fvSip(monthlyAmount, annualRate, years) {
  const n = years * 12;
  const r = annualRate / 12;
  if (monthlyAmount <= 0 || n <= 0) return 0;
  return Math.round(monthlyAmount * ((Math.pow(1 + r, n) - 1) / r) * (1 + r));
}

// ─── SIP Months Needed to Reach a Corpus ─────────────────────────────────────
function monthsToCorpus(monthlyAmount, annualRate, targetCorpus) {
  if (monthlyAmount <= 0 || targetCorpus <= 0) return Infinity;
  const r = annualRate / 12;
  // FV = P * [((1+r)^n - 1)/r] * (1+r)
  // Solve for n: n = ln(1 + targetCorpus*r / (P*(1+r))) / ln(1+r)
  const numerator = Math.log(1 + (targetCorpus * r) / (monthlyAmount * (1 + r)));
  const denominator = Math.log(1 + r);
  return Math.ceil(numerator / denominator);
}

// ─── Risk-Based Allocation ───────────────────────────────────────────────────
function allocationByRisk(risk) {
  const key = String(risk || 'moderate').toLowerCase();
  if (key === 'conservative') {
    return { flexi_cap: 0.7, mid_cap: 0.2, small_cap: 0.1 };
  }
  if (key === 'aggressive') {
    return { flexi_cap: 0.3, mid_cap: 0.3, small_cap: 0.4 };
  }
  return { flexi_cap: 0.5, mid_cap: 0.3, small_cap: 0.2 }; // moderate
}

// ─── Blended Return Rate Based on Risk Allocation ────────────────────────────
function blendedReturnRate(risk) {
  const allocation = allocationByRisk(risk);
  let rate = 0;
  for (const [fundType, weight] of Object.entries(allocation)) {
    rate += ASSUMED_RETURNS[fundType] * weight;
  }
  return rate;
}

// ─── Projected Value Using Blended Allocation ────────────────────────────────
function projectedValue(monthlySip, years, risk) {
  const allocation = allocationByRisk(risk);
  let total = 0;
  for (const [fundType, weight] of Object.entries(allocation)) {
    total += fvSip(monthlySip * weight, ASSUMED_RETURNS[fundType], years);
  }
  return Math.round(total);
}

// ─── Goal Detection & Corpus Lookup ──────────────────────────────────────────
function detectGoalCorpus(goalText) {
  const text = String(goalText || '').toLowerCase();
  for (const [keyword, corpus] of Object.entries(GOAL_CORPUS)) {
    if (text.includes(keyword)) {
      return { keyword, corpus };
    }
  }
  // Default fallback — general wealth
  return { keyword: 'wealth', corpus: 5000000 };
}

// ─── Goal-Based Projection ──────────────────────────────────────────────────
function calculateGoalProjection(goal, monthlySip, risk) {
  const { keyword, corpus } = detectGoalCorpus(goal);
  const rate = blendedReturnRate(risk);
  const months = monthsToCorpus(monthlySip, rate, corpus);
  const years = (months / 12).toFixed(1);
  const isAchievable = months < 360; // within 30 years

  // Motivational label map
  const goalLabels = {
    car: '🚗 Dream Car',
    bike: '🏍️ New Bike',
    australia: '✈️ Australia Trip',
    travel: '✈️ Dream Trip',
    trip: '✈️ Travel Goal',
    house: '🏠 Dream Home (Down Payment)',
    home: '🏠 Dream Home (Down Payment)',
    flat: '🏠 Your Own Flat',
    education: '🎓 Education Fund',
    wedding: '💍 Wedding Fund',
    marriage: '💍 Wedding Fund',
    retirement: '🏖️ Retirement Corpus',
    wealth: '💰 Wealth Goal',
    emergency: '🛡️ Emergency Fund',
    laptop: '💻 New Laptop',
    phone: '📱 New Phone',
  };

  const label = goalLabels[keyword] || '🎯 Your Goal';

  return {
    goal_label: label,
    goal_keyword: keyword,
    target_corpus: corpus,
    target_corpus_formatted: formatCrLakh(corpus),
    months_needed: isAchievable ? months : null,
    years_needed: isAchievable ? parseFloat(years) : null,
    is_achievable: isAchievable,
    monthly_sip: monthlySip,
    assumed_return: (rate * 100).toFixed(1) + '% p.a.',
    motivation: isAchievable
      ? `${label} is ${years} years away at ₹${formatINR(monthlySip)}/month SIP!`
      : `${label} needs a higher monthly SIP or a longer horizon. Let's plan with an advisor.`,
  };
}

// ─── Per-Category Expense Optimization ──────────────────────────────────────
function calculateCategoryOptimization(income, expenses) {
  const categories = [
    {
      key: 'basic_needs',
      label: 'Basic Needs',
      icon: '🏠',
      amount: toNumber(expenses.basic_needs),
      ideal_pct: 50, // 50/30/20 rule: needs
      tip: 'Check for cheaper grocery alternatives, optimize rent, or cook at home more.',
    },
    {
      key: 'bills_payments',
      label: 'Bills & Payments',
      icon: '📄',
      amount: toNumber(expenses.bills_payments),
      ideal_pct: 20,
      tip: 'Refinance high-interest loans, compare insurance premiums, automate payments to avoid penalties.',
    },
    {
      key: 'personal_spending',
      label: 'Personal Spending',
      icon: '🛍️',
      amount: toNumber(expenses.personal_spending),
      ideal_pct: 15,
      tip: 'Audit subscriptions you rarely use, set a monthly eating-out budget, and use the 24-hour rule for purchases.',
    },
    {
      key: 'extra_unexpected',
      label: 'Extra / Unexpected',
      icon: '🚑',
      amount: toNumber(expenses.extra_unexpected),
      ideal_pct: 10,
      tip: 'Build an emergency fund (3-6 months expenses) to reduce the financial shock of unexpected events.',
    },
  ];

  const totalExpenses = categories.reduce((s, c) => s + c.amount, 0);

  return categories.map(cat => {
    const actual_pct = income > 0 ? Math.round((cat.amount / income) * 100) : 0;
    const is_over = actual_pct > cat.ideal_pct;
    const potential_saving = is_over
      ? Math.round(cat.amount - (income * cat.ideal_pct / 100))
      : 0;

    return {
      ...cat,
      actual_pct,
      is_over_budget: is_over,
      potential_monthly_saving: potential_saving,
      potential_monthly_saving_formatted: potential_saving > 0 ? `₹${formatINR(potential_saving)}` : '—',
      recommendation: is_over
        ? `${cat.icon} ${cat.label} is ${actual_pct}% of income (ideal: ≤${cat.ideal_pct}%). ${cat.tip} Potential saving: ₹${formatINR(potential_saving)}/month.`
        : `${cat.icon} ${cat.label} is well within budget at ${actual_pct}% (ideal: ≤${cat.ideal_pct}%).`,
    };
  });
}

// ─── Build Goal-Specific Motivational Hint ──────────────────────────────────
function buildGoalHint(goal, monthlySip, risk) {
  if (!goal) return 'Set a financial goal to see how your SIP can make it happen!';

  const projection = calculateGoalProjection(goal, monthlySip, risk);
  return projection.motivation;
}

// ─── Main Financial Plan Calculation ─────────────────────────────────────────
function calculateFinancialPlan(profile) {
  const income = toNumber(profile.monthly_salary);
  const expenses = profile.expenses || {};

  const basicNeeds = toNumber(expenses.basic_needs);
  const billsPayments = toNumber(expenses.bills_payments);
  const personalSpending = toNumber(expenses.personal_spending);
  const extraUnexpected = toNumber(expenses.extra_unexpected);

  const totalExpenses = basicNeeds + billsPayments + personalSpending + extraUnexpected;
  const rawMonthlySurplus = income - totalExpenses;
  const monthlySurplus = Math.max(0, rawMonthlySurplus);
  const suggestedSavings = Math.round(monthlySurplus * 0.2); // 20% liquid buffer
  const investableAmount = Math.max(0, monthlySurplus - suggestedSavings);
  const savingsRate = income > 0 ? Math.round((monthlySurplus / income) * 100) : 0;

  // Fund allocation
  const fundMix = allocationByRisk(profile.risk_profile);

  // Per-category optimization
  const categoryOptimization = calculateCategoryOptimization(income, expenses);
  const totalPotentialSaving = categoryOptimization.reduce((s, c) => s + c.potential_monthly_saving, 0);

  // Deficit recovery path: prioritize Category 3 + 4 (Personal Spending + Extra / Unexpected).
  const deficitAmount = Math.max(0, totalExpenses - income);
  const needsOptimizationPath = rawMonthlySurplus <= 0;
  const personalCategory = categoryOptimization.find(c => c.key === 'personal_spending');
  const extraCategory = categoryOptimization.find(c => c.key === 'extra_unexpected');
  const personalPotential = personalCategory ? personalCategory.potential_monthly_saving : 0;
  const extraPotential = extraCategory ? extraCategory.potential_monthly_saving : 0;

  // What-if cuts: even if category is within ideal %, user can still trim discretionary spends.
  const personalWhatIfCut = Math.max(personalPotential, Math.round(personalSpending * 0.2));
  const extraWhatIfCut = Math.max(extraPotential, Math.round(extraUnexpected * 0.3));
  const prioritizedPotential = personalWhatIfCut + extraWhatIfCut;

  // If there is a deficit, projections are shown for the post-optimization path.
  const plannedCuts = prioritizedPotential;
  const postCutSurplus = Math.max(0, plannedCuts - deficitAmount);
  const recoverySuggestedSavings = Math.round(postCutSurplus * 0.2);
  const postCutInvestableAmount = Math.max(0, postCutSurplus - recoverySuggestedSavings);
  // If surplus is exactly zero, still guide users with a minimum starter SIP.
  const zeroSurplusStarterSip = rawMonthlySurplus === 0 ? 500 : 0;
  const optimizedSip = Math.max(postCutInvestableAmount, zeroSurplusStarterSip);
  const recommendedSipForProjection = needsOptimizationPath ? optimizedSip : investableAmount;

  // Time-horizon projections
  const projections = [3, 5, 10, 15, 20].map((years) => ({
    years,
    monthly_investment: recommendedSipForProjection,
    expected_value: projectedValue(recommendedSipForProjection, years, profile.risk_profile),
    expected_value_formatted: formatCrLakh(projectedValue(recommendedSipForProjection, years, profile.risk_profile)),
  }));

  // Goal projection
  const goalProjection = calculateGoalProjection(
    profile.goal,
    recommendedSipForProjection,
    profile.risk_profile
  );

  // Expense insights (richer than before)
  const expenseInsights = [];

  categoryOptimization.forEach(cat => {
    if (cat.is_over_budget) {
      expenseInsights.push(cat.recommendation);
    }
  });

  if (savingsRate < 20) {
    expenseInsights.push(`⚠️ Your savings rate is ${savingsRate}% — aim for at least 20% for long-term wealth.`);
  } else if (savingsRate >= 40) {
    expenseInsights.push(`🌟 Excellent savings rate of ${savingsRate}%! Channel the surplus into diversified SIPs.`);
  }

  if (expenseInsights.length === 0) {
    expenseInsights.push('✅ Your expense mix is balanced. Focus on automating monthly SIPs for consistency.');
  }

  if (needsOptimizationPath) {
    const shortfallText = deficitAmount > 0
      ? `higher than salary by ₹${formatINR(deficitAmount)}/month`
      : 'equal to your salary, leaving zero monthly savings';
    expenseInsights.push(
      `🚨 Your expenses are ${shortfallText}. ` +
      `Trim Personal Spending and Extra / Unexpected to create room for investing and a stronger financial future.`
    );
    expenseInsights.push(
      `📌 Post-optimization path: Personal Spending cut target ₹${formatINR(personalWhatIfCut)}/month and ` +
      `Extra / Unexpected cut target ₹${formatINR(extraWhatIfCut)}/month. ` +
      `Estimated SIP after these cuts: ₹${formatINR(recommendedSipForProjection)}/month.`
    );
  }

  // Expense breakdown for display
  const expenseBreakdown = {
    basic_needs: { amount: basicNeeds, pct: income > 0 ? Math.round((basicNeeds / income) * 100) : 0, label: 'Basic Needs' },
    bills_payments: { amount: billsPayments, pct: income > 0 ? Math.round((billsPayments / income) * 100) : 0, label: 'Bills & Payments' },
    personal_spending: { amount: personalSpending, pct: income > 0 ? Math.round((personalSpending / income) * 100) : 0, label: 'Personal Spending' },
    extra_unexpected: { amount: extraUnexpected, pct: income > 0 ? Math.round((extraUnexpected / income) * 100) : 0, label: 'Extra / Unexpected' },
    savings_surplus: { amount: recommendedSipForProjection, pct: income > 0 ? Math.round((recommendedSipForProjection / income) * 100) : 0, label: 'Savings & Investment' },
  };

  const optimizedPersonalSpending = Math.max(0, personalSpending - personalWhatIfCut);
  const optimizedExtraUnexpected = Math.max(0, extraUnexpected - extraWhatIfCut);
  const optimizedTotalExpenses = basicNeeds + billsPayments + optimizedPersonalSpending + optimizedExtraUnexpected;
  const optimizedExpenseBreakdown = {
    basic_needs: { amount: basicNeeds, pct: income > 0 ? Math.round((basicNeeds / income) * 100) : 0, label: 'Basic Needs' },
    bills_payments: { amount: billsPayments, pct: income > 0 ? Math.round((billsPayments / income) * 100) : 0, label: 'Bills & Payments' },
    personal_spending: { amount: optimizedPersonalSpending, pct: income > 0 ? Math.round((optimizedPersonalSpending / income) * 100) : 0, label: 'Personal Spending' },
    extra_unexpected: { amount: optimizedExtraUnexpected, pct: income > 0 ? Math.round((optimizedExtraUnexpected / income) * 100) : 0, label: 'Extra / Unexpected' },
    savings_surplus: { amount: recommendedSipForProjection, pct: income > 0 ? Math.round((recommendedSipForProjection / income) * 100) : 0, label: 'Savings & Investment' },
    total_expenses: optimizedTotalExpenses,
  };

  return {
    totals: {
      monthly_salary: income,
      total_expenses: totalExpenses,
      monthly_surplus: monthlySurplus,
      suggested_savings: suggestedSavings,
      investable_amount: investableAmount,
      recommended_sip_for_projection: recommendedSipForProjection,
      projection_basis: needsOptimizationPath ? 'post_optimization' : 'current_surplus',
      savings_rate: savingsRate,
      total_potential_saving: totalPotentialSaving,
      deficit_amount: deficitAmount,
    },
    expense_breakdown: expenseBreakdown,
    category_optimization: categoryOptimization,
    fund_mix: fundMix,
    fund_mix_amounts: {
      flexi_cap: Math.round(recommendedSipForProjection * fundMix.flexi_cap),
      mid_cap: Math.round(recommendedSipForProjection * fundMix.mid_cap),
      small_cap: Math.round(recommendedSipForProjection * fundMix.small_cap),
    },
    assumptions: {
      returns: ASSUMED_RETURNS,
      savings_buffer_pct: 20,
    },
    projections,
    goal_projection: goalProjection,
    expense_insights: expenseInsights,
    goal_nudge: buildGoalHint(profile.goal, recommendedSipForProjection, profile.risk_profile),
    recovery_plan: {
      is_deficit: deficitAmount > 0,
      is_zero_savings: monthlySurplus === 0,
      is_optimization_applied: needsOptimizationPath,
      prioritized_categories: ['Personal Spending', 'Extra / Unexpected'],
      personal_spending_potential_saving: personalPotential,
      extra_unexpected_potential_saving: extraPotential,
      personal_spending_target_cut: personalWhatIfCut,
      extra_unexpected_target_cut: extraWhatIfCut,
      prioritized_total_potential_saving: prioritizedPotential,
      post_cut_investable_amount: postCutInvestableAmount,
    },
    expense_breakdown_optimized: optimizedExpenseBreakdown,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────
function validateProfileField(field, value) {
  const str = String(value || '').trim();
  if (field === 'name') return { valid: str.length >= 2, error: 'Please enter a valid name (at least 2 characters).' };
  if (field === 'address') return { valid: str.length >= 8, error: 'Please enter your full address (at least 8 characters).' };
  if (field === 'phone') return { valid: /^[6-9]\d{9}$/.test(str), error: 'Please enter a valid 10-digit Indian mobile number starting with 6-9.' };
  if (field === 'monthly_salary') {
    const n = Number(value);
    return { valid: Number.isFinite(n) && n >= 5000, error: 'Please enter a valid monthly salary (minimum ₹5,000).' };
  }

  const expenseFields = ['basic_needs', 'bills_payments', 'personal_spending', 'extra_unexpected'];
  if (expenseFields.includes(field)) {
    const n = Number(value);
    return { valid: Number.isFinite(n) && n >= 0, error: 'Please enter a valid monthly expense amount (0 or more).' };
  }

  if (field === 'risk_profile') {
    return {
      valid: ['conservative', 'moderate', 'aggressive'].includes(str.toLowerCase()),
      error: 'Risk profile must be conservative, moderate, or aggressive.',
    };
  }

  return { valid: true };
}

module.exports = {
  formatINR,
  formatCrLakh,
  calculateFinancialPlan,
  calculateGoalProjection,
  calculateCategoryOptimization,
  validateProfileField,
  allocationByRisk,
  blendedReturnRate,
  ASSUMED_RETURNS,
  GOAL_CORPUS,
};
