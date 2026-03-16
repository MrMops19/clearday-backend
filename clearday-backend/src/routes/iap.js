// src/routes/iap.js
//
// In-App Purchase verification for iOS (Apple) and Android (Google Play).
// All payment logic happens here — never on the client.
//
const express = require("express");
const router  = express.Router();

const { requireAuth }      = require("../middleware/auth");
const { iapLimiter }       = require("../middleware/rateLimiter");
const userService          = require("../services/userService");
const appleService         = require("../services/appleService");
const googleService        = require("../services/googleService");

// ══════════════════════════════════════════════════════════════
// iOS — Apple StoreKit 2
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/iap/apple/verify
 *
 * Called by the iOS app after a StoreKit 2 purchase succeeds.
 * Body: { originalTransactionId: string }
 */
router.post("/apple/verify", requireAuth, iapLimiter, async (req, res) => {
  const { originalTransactionId } = req.body;

  if (!originalTransactionId || typeof originalTransactionId !== "string") {
    return res.status(400).json({ error: "originalTransactionId fehlt." });
  }

  try {
    // Verify with Apple's servers
    const receipt = await appleService.verifyApplePurchase(originalTransactionId);

    if (!receipt.isActive) {
      return res.status(402).json({
        error: "Subscription nicht aktiv.",
        status: receipt.status,
      });
    }

    // Check product ID matches our expected product
    if (receipt.productId !== process.env.APPLE_PRODUCT_ID) {
      return res.status(400).json({
        error: `Unbekanntes Produkt: ${receipt.productId}`,
      });
    }

    // Activate premium in our database
    userService.activatePremium(req.user.userId, {
      expiresAt:     receipt.expiresAt,
      transactionId: receipt.originalTransactionId,
      platform:      "ios",
    });

    // Save receipt for audit trail
    appleService.saveAppleReceipt(req.user.userId, receipt, {});

    // Return a fresh JWT with updated isPremium = true
    const { token, isPremium } = userService.refreshToken(req.user.userId);

    res.json({
      success: true,
      isPremium,
      premiumExpiresAt: receipt.expiresAt,
      token, // app should replace its stored JWT with this
    });
  } catch (err) {
    console.error("Apple IAP verify error:", err);
    res.status(500).json({ error: "Apple-Verifizierung fehlgeschlagen." });
  }
});

/**
 * POST /api/iap/apple/notifications
 *
 * Apple App Store Server Notifications webhook.
 * Register this URL in App Store Connect → App Information → App Store Server Notifications.
 * Apple sends lifecycle events (renewals, cancellations, refunds) here.
 *
 * Apple sends a signed JWS payload — we decode and process it.
 */
router.post("/apple/notifications", express.text({ type: "application/json" }), async (req, res) => {
  // Respond immediately to Apple (they expect < 5s)
  res.status(200).json({ received: true });

  try {
    let body;
    try {
      body = JSON.parse(req.body);
    } catch {
      console.error("Apple notification: invalid JSON body");
      return;
    }

    // The signedPayload is a JWS — decode the payload part
    const decoded = appleService.decodeAppleJWS(body.signedPayload);
    if (!decoded) {
      console.error("Apple notification: could not decode signedPayload");
      return;
    }

    const { notificationType, subtype, notificationUUID, data } = decoded;

    // Idempotency check — skip if already processed
    const isNew = appleService.saveAppleNotification(
      notificationUUID,
      notificationType,
      subtype,
      data?.bundleId,
      decoded
    );
    if (!isNew) return;

    // Process the notification
    const result = appleService.processAppleNotification(decoded);

    if (!result.originalTransactionId) return;

    // Find the user by their original transaction ID
    const user = userService.findByPurchaseId(result.originalTransactionId);
    if (!user) {
      console.warn(`Apple notification: no user found for txId ${result.originalTransactionId}`);
      return;
    }

    if (result.shouldActivate) {
      userService.activatePremium(user.id, {
        expiresAt:     result.expiresAt,
        transactionId: result.originalTransactionId,
        platform:      "ios",
      });
      console.log(`✅ Apple: Premium aktiviert für User ${user.id} (${notificationType})`);
    } else if (result.shouldDeactivate) {
      userService.deactivatePremium(user.id);
      console.log(`❌ Apple: Premium deaktiviert für User ${user.id} (${notificationType})`);
    }
  } catch (err) {
    console.error("Apple notification processing error:", err);
  }
});

// ══════════════════════════════════════════════════════════════
// Android — Google Play Billing
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/iap/google/verify
 *
 * Called by the Android app after a Google Play purchase succeeds.
 * Body: { purchaseToken: string, productId: string }
 */
router.post("/google/verify", requireAuth, iapLimiter, async (req, res) => {
  const { purchaseToken, productId } = req.body;

  if (!purchaseToken || typeof purchaseToken !== "string") {
    return res.status(400).json({ error: "purchaseToken fehlt." });
  }
  if (!productId || typeof productId !== "string") {
    return res.status(400).json({ error: "productId fehlt." });
  }

  try {
    // Verify with Google Play API
    const receipt = await googleService.verifyGooglePurchase(purchaseToken, productId);

    if (!receipt.isActive) {
      return res.status(402).json({
        error: "Subscription nicht aktiv.",
        state: receipt.subscriptionState,
      });
    }

    // Acknowledge purchase if not yet done
    // Google will refund automatically if not acknowledged within 3 days
    if (!receipt.isAcknowledged) {
      await googleService.acknowledgePurchase(purchaseToken, productId);
    }

    // Activate premium
    userService.activatePremium(req.user.userId, {
      expiresAt:     receipt.expiresAt,
      transactionId: receipt.purchaseToken, // Google uses purchaseToken as the identifier
      platform:      "android",
    });

    // Save receipt
    googleService.saveGoogleReceipt(req.user.userId, receipt, receipt.raw);

    // Return fresh JWT
    const { token, isPremium } = userService.refreshToken(req.user.userId);

    res.json({
      success: true,
      isPremium,
      premiumExpiresAt: receipt.expiresAt,
      token,
    });
  } catch (err) {
    console.error("Google IAP verify error:", err);
    res.status(500).json({ error: "Google-Verifizierung fehlgeschlagen." });
  }
});

/**
 * POST /api/iap/google/notifications
 *
 * Google Play Real-Time Developer Notifications (RTDN) via Pub/Sub.
 * Set up in Google Play Console → Monetization setup → Real-time developer notifications.
 *
 * Google wraps the notification in a Pub/Sub message with base64-encoded data.
 */
router.post("/google/notifications", async (req, res) => {
  // Respond immediately
  res.status(200).json({ received: true });

  try {
    const message = req.body?.message;
    if (!message?.data) {
      console.warn("Google notification: no message data");
      return;
    }

    // Verify the token matches our expected token (simple security check)
    const token = req.query.token;
    if (process.env.GOOGLE_PUBSUB_TOKEN && token !== process.env.GOOGLE_PUBSUB_TOKEN) {
      console.warn("Google notification: invalid token");
      return;
    }

    // Decode base64 Pub/Sub data
    const decodedData = Buffer.from(message.data, "base64").toString("utf8");
    let notification;
    try {
      notification = JSON.parse(decodedData);
    } catch {
      console.error("Google notification: invalid JSON data");
      return;
    }

    const { subscriptionNotification } = notification;
    if (!subscriptionNotification) return;

    // Idempotency
    const isNew = googleService.saveGoogleNotification(
      message.messageId,
      subscriptionNotification.notificationType,
      subscriptionNotification.purchaseToken,
      notification
    );
    if (!isNew) return;

    // Process notification
    const result = googleService.processGoogleNotification(notification);

    if (result.shouldDeactivate) {
      // Find user by purchase token
      const db = require("../db");
      const receipt = db
        .prepare("SELECT user_id FROM iap_receipts WHERE purchase_token = ? AND platform = 'android'")
        .get(result.purchaseToken);

      if (receipt) {
        userService.deactivatePremium(receipt.user_id);
        console.log(`❌ Google: Premium deaktiviert (${result.type})`);
      }
    } else if (result.shouldVerify && result.purchaseToken) {
      // Re-verify the subscription with Google to get updated expiry
      try {
        const db = require("../db");
        const existingReceipt = db
          .prepare("SELECT user_id FROM iap_receipts WHERE purchase_token = ? AND platform = 'android'")
          .get(result.purchaseToken);

        if (existingReceipt) {
          const updated = await googleService.verifyGooglePurchase(
            result.purchaseToken,
            result.subscriptionId || process.env.GOOGLE_PRODUCT_ID
          );
          if (updated.isActive) {
            userService.activatePremium(existingReceipt.user_id, {
              expiresAt:     updated.expiresAt,
              transactionId: result.purchaseToken,
              platform:      "android",
            });
            console.log(`✅ Google: Premium verlängert (${result.type})`);
          }
        }
      } catch (verifyErr) {
        console.error("Google re-verify error:", verifyErr);
      }
    }
  } catch (err) {
    console.error("Google notification processing error:", err);
  }
});

/**
 * GET /api/iap/status
 *
 * Returns the current subscription status for the logged-in user.
 * App calls this on launch to sync premium state.
 */
router.get("/status", requireAuth, (req, res) => {
  const db = require("../db");
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);

  if (!user) return res.status(404).json({ error: "User nicht gefunden." });

  const active = userService.isPremiumActive(user);

  res.json({
    isPremium:       active,
    premiumExpiresAt: user.premium_expires_at || null,
    platform:        user.platform,
  });
});

module.exports = router;
