'use strict';

const express = require('express');
const router = express.Router();

const controller = require('../controllers/adminController');
const { adminAuth } = require('../middleware/adminAuth');

// Auth
router.post('/login', controller.login);
router.post('/logout', controller.logout);
router.get('/me', adminAuth, controller.me);

// Data
router.get('/leads', adminAuth, controller.listLeads);

module.exports = router;
