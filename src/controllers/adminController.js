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

  const user = await AdminUser.findOne({ username: String(username).trim() }).exec();
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(String(password), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  user.lastLoginAt = new Date();
  await user.save();

  const token = jwt.sign(
    { sub: String(user._id), username: user.username, role: user.role },
    getJwtSecret(),
    { expiresIn: '7d' }
  );

  setAuthCookie(res, token);
  return res.json({ success: true, username: user.username, role: user.role });
}

async function logout(req, res) {
  clearAuthCookie(res);
  return res.json({ success: true });
}

async function me(req, res) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, getJwtSecret());
    return res.json({ username: payload.username, role: payload.role });
  } catch (_e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

async function listLeads(req, res) {
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
