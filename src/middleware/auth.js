// src/middleware/auth.js
const jwt = require("jsonwebtoken");

/**
 * Verifies the JWT from the Authorization header.
 * Attaches req.user = { userId, deviceId, isPremium } on success.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Kein Token vorhanden." });
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      userId:    payload.sub,
      deviceId:  payload.deviceId,
      isPremium: payload.isPremium || false,
    };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token abgelaufen. Bitte neu anmelden." });
    }
    return res.status(401).json({ error: "Ungültiger Token." });
  }
}

module.exports = { requireAuth };
