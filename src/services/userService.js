// src/services/userService.js
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const db = require("../db");

/**
 * Finds an existing user by device_id, or creates a new one.
 * This is the only "login" method — no email/password needed.
 */
function findOrCreateUser(deviceId, platform = "unknown") {
  let user = db
    .prepare("SELECT * FROM users WHERE device_id = ?")
    .get(deviceId);

  if (!user) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO users (id, device_id, platform)
      VALUES (?, ?, ?)
    `).run(id, deviceId, platform);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }

  return user;
}

/**
 * Returns whether the user currently has an active premium subscription.
 */
function isPremiumActive(user) {
  if (!user.is_premium) return false;
  if (!user.premium_expires_at) return true; // lifetime (rare)
  return new Date(user.premium_expires_at) > new Date();
}

/**
 * Activates premium for a user. Called after successful IAP verification.
 */
function activatePremium(userId, { expiresAt, transactionId, platform }) {
  db.prepare(`
    UPDATE users
    SET is_premium = 1,
        premium_expires_at = ?,
        original_purchase_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(expiresAt, transactionId, userId);
}

/**
 * Deactivates premium. Called from Apple/Google webhook on cancellation.
 */
function deactivatePremium(userId) {
  db.prepare(`
    UPDATE users
    SET is_premium = 0,
        premium_expires_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(userId);
}

/**
 * Find user by their original purchase ID (for webhook lookups).
 */
function findByPurchaseId(purchaseId) {
  return db
    .prepare("SELECT * FROM users WHERE original_purchase_id = ?")
    .get(purchaseId);
}

/**
 * Generates a signed JWT for the user.
 */
function generateToken(user) {
  return jwt.sign(
    {
      sub:       user.id,
      deviceId:  user.device_id,
      isPremium: isPremiumActive(user),
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "365d" }
  );
}

/**
 * Re-fetches user and returns a fresh token (used after premium changes).
 */
function refreshToken(userId) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw new Error("User not found");
  return { token: generateToken(user), isPremium: isPremiumActive(user) };
}

module.exports = {
  findOrCreateUser,
  isPremiumActive,
  activatePremium,
  deactivatePremium,
  findByPurchaseId,
  generateToken,
  refreshToken,
};
