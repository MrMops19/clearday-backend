// src/middleware/rateLimiter.js
const rateLimit = require("express-rate-limit");

// General API: 120 req / 15 min
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Anfragen. Bitte warte kurz." },
});

// Auth endpoints: 20 req / 15 min (prevents brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Auth-Versuche." },
});

// IAP verification: 10 req / 15 min per IP
const iapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele IAP-Anfragen." },
});

module.exports = { apiLimiter, authLimiter, iapLimiter };
