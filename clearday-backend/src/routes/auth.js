// src/routes/auth.js
//
// Device-based authentication — no email/password needed.
// The mobile app generates a UUID on first launch and sends it here.
// We return a JWT the app uses for all subsequent requests.
//
const express = require("express");
const router = express.Router();
const { findOrCreateUser, generateToken, isPremiumActive } = require("../services/userService");

const VALID_PLATFORMS = ["ios", "android", "web"];

/**
 * POST /api/auth/login
 *
 * Body: { deviceId: string, platform: "ios" | "android" | "web" }
 * Returns: { token, userId, isPremium }
 *
 * The app should:
 *  1. Generate a UUID on first launch and store it in secure storage
 *  2. Send that UUID here to get a JWT
 *  3. Store the JWT and send it as Bearer token on every request
 *  4. Call this again if the JWT expires (365 days by default)
 */
router.post("/login", (req, res) => {
  const { deviceId, platform } = req.body;

  if (!deviceId || typeof deviceId !== "string" || deviceId.trim().length < 8) {
    return res.status(400).json({ error: "Ungültige deviceId." });
  }

  const normalizedPlatform = VALID_PLATFORMS.includes(platform) ? platform : "unknown";

  try {
    const user  = findOrCreateUser(deviceId.trim(), normalizedPlatform);
    const token = generateToken(user);

    res.json({
      token,
      userId:    user.id,
      isPremium: isPremiumActive(user),
      premiumExpiresAt: user.premium_expires_at || null,
    });
  } catch (err) {
    console.error("Auth login error:", err);
    res.status(500).json({ error: "Login fehlgeschlagen." });
  }
});

/**
 * GET /api/auth/me
 *
 * Returns current user status (use after app comes to foreground
 * to check if premium is still active).
 */
router.get("/me", require("../middleware/auth").requireAuth, (req, res) => {
  const db = require("../db");
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);

  if (!user) return res.status(404).json({ error: "Nutzer nicht gefunden." });

  res.json({
    userId:          user.id,
    isPremium:       isPremiumActive(user),
    premiumExpiresAt: user.premium_expires_at || null,
    platform:        user.platform,
    createdAt:       user.created_at,
  });
});

module.exports = router;
