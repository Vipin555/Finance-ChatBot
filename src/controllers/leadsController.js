"use strict";

const { v4: uuidv4 } = require('uuid');
const Lead = require('../models/Lead');

function buildLeadPayload(body = {}) {
  const profile = body.profile || body.financial_profile || {};
  const expenseBreakdown = body.expenseBreakdown || body.expense_breakdown || profile.expenses || {
    basic_needs: 0,
    bills_payments: 0,
    personal_spending: 0,
    extra_unexpected: 0,
  };

  return {
    userId: body.userId || '',
    sessionId: body.sessionId || uuidv4(),
    name: body.name || '',
    phone: body.phone || '',
    address: body.address || '',
    profile,
    analysis: body.analysis || {},
    keyFinancialInsights: Array.isArray(body.keyFinancialInsights)
      ? body.keyFinancialInsights
      : Array.isArray(body.key_financial_insights)
      ? body.key_financial_insights
      : [],
    peakInsight: body.peakInsight || body.peak_insight || '',
    expenseBreakdown,
    monthlySalary: body.monthlySalary || profile.monthly_salary || 0,
    goal: body.goal || profile.goal || '',
    riskProfile: body.riskProfile || body.risk_profile || profile.risk_profile || 'moderate',
    status: body.status || 'new',
    conversationStartedAt: body.conversationStartedAt ? new Date(body.conversationStartedAt) : undefined,
    conversationCompletedAt: body.conversationCompletedAt ? new Date(body.conversationCompletedAt) : undefined,
  };
}

async function createLead(req, res) {
  try {
    const body = req.body || {};
    if (!body.name || !body.phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }

    const lead = new Lead(buildLeadPayload(body));
    await lead.save();

    return res.json({ success: true, lead });
  } catch (err) {
    console.error('[createLead]', err);
    return res.status(500).json({ error: 'Failed to save lead' });
  }
}

async function listLeads(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const leads = await Lead.find({}, {
      name: 1,
      phone: 1,
      address: 1,
      monthlySalary: 1,
      keyFinancialInsights: 1,
      peakInsight: 1,
      conversationStartedAt: 1,
      conversationCompletedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    return res.json({ leads, total: leads.length });
  } catch (err) {
    console.error('[listLeads]', err);
    return res.status(500).json({ error: 'Failed to read leads' });
  }
}

async function updateLeadStatus(req, res) {
  try {
    const id = req.params.id;
    const { status } = req.body || {};
    if (!id || !status) return res.status(400).json({ error: 'id and status required' });

    const query = { _id: id };
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      query.sessionId = id;
      delete query._id;
    }

    const lead = await Lead.findOneAndUpdate(
      query,
      {
        status,
        updatedAt: new Date(),
      },
      { new: true }
    ).lean();

    if (!lead) return res.status(404).json({ error: 'lead not found' });
    return res.json({ success: true, lead });
  } catch (err) {
    console.error('[updateLeadStatus]', err);
    return res.status(500).json({ error: 'Failed to update lead' });
  }
}

module.exports = {
  createLead,
  listLeads,
  updateLeadStatus,
};
