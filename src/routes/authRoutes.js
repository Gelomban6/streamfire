const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many authentication attempts, please try again later.',
    standardHeaders: true,
    legacyHeaders: false
});

router.get('/login', authController.getLogin);
router.post('/login', authLimiter, authController.postLogin);
router.get('/setup', authController.getSetup);
router.post('/setup', authLimiter, authController.postSetup);
router.get('/logout', authController.logout);

module.exports = router;
