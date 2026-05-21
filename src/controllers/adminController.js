'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const Lead = require('../models/Lead');
const AdminUser = require('../models/AdminUser');
const { getJwtSecret } = require('../middleware/adminAuth');

const COOKIE_NAME = 'admin_token';

function resolveCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  const rawSameSite = String(process.env.ADMIN_COOKIE_SAMESITE || (isProd ? 'none' : 'lax')).trim().toLowerCase();
  const sameSite = rawSameSite === 'none' ? 'none' : 'lax';

  // Browsers require Secure=true whenever SameSite=None is used.
  const secure = sameSite === 'none' ? true : isProd;

  return {
    httpOnly: true,
    sameSite,
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, resolveCookieOptions());
}

function clearAuthCookie(res) {
  const opts = resolveCookieOptions();
  res.clearCookie(COOKIE_NAME, {
    path: opts.path,
    sameSite: opts.sameSite,
    secure: opts.secure,
  });
}

async function login(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  if (!process.env.MONGODB_URI) {
    return res.status(500).json({ error: 'MongoDB is not configured (missing MONGODB_URI).' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 200, 500);

  const leads = await Lead.find(
    {},
    {
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
    }
  )
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .exec();


  return res.json({ leads, total: leads.length });
}

module.exports = {
  login,
  logout,
  me,
  listLeads,
};

