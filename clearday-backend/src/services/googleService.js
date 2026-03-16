// src/services/googleService.js
//
// Google Play Billing — Server-side Verification
// Docs: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
//
// Flow:
//   1. App purchases via Google Play Billing Library on device
//   2. App sends purchaseToken + productId to our server
//   3. We call Google Play Developer API to verify
//   4. We activate premium
//
const { google } = require("googleapis");
const db = require("../db");
const { v4: uuidv4 } = require("uuid");

// ─── Auth ──────────────────────────────────────────────────────────────────────
function getGoogleAuth() {
  return new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
}

function getAndroidPublisher() {
  const auth = getGoogleAuth();
  return google.androidpublisher({ version: "v3", auth });
}

// ─── Verify ────────────────────────────────────────────────────────────────────

/**
 * Verifies a Google Play subscription purchase.
 *
 * @param {string} purchaseToken - From Google Play Billing Library on device
 * @param {string} productId     - The subscription product ID
 * @returns {{ isActive, expiresAt, orderId, purchaseToken, isTrial, paymentState }}
 */
async function verifyGooglePurchase(purchaseToken, productId) {
  const androidPublisher = getAndroidPublisher();

  // Use subscriptionsv2.get (recommended over v1 subscriptions.get)
  const res = await androidPublisher.purchases.subscriptionsv2.get({
    packageName: process.env.GOOGLE_PACKAGE_NAME,
    token: purchaseToken,
  });

  const sub = res.data;

  if (!sub) {
    throw new Error("Keine Subscription-Daten von Google erhalten.");
  }

  // subscriptionState:
  // SUBSCRIPTION_STATE_ACTIVE | SUBSCRIPTION_STATE_PAUSED |
  // SUBSCRIPTION_STATE_IN_GRACE_PERIOD | SUBSCRIPTION_STATE_ON_HOLD |
  // SUBSCRIPTION_STATE_CANCELED | SUBSCRIPTION_STATE_EXPIRED
  const activeStates = [
    "SUBSCRIPTION_STATE_ACTIVE",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  ];

  const isActive = activeStates.includes(sub.subscriptionState);

  // expiryTime is an ISO string
  const expiresAt = sub.lineItems?.[0]?.expiryTime || null;

  // acknowledgement — must acknowledge within 3 days or Google will refund
  // We'll acknowledge in the purchase route
  const isAcknowledged = sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";

  // orderId from the latest order
  const latestOrderId = sub.latestOrderId;

  // isTrial: check introductory pricing state
  const isTrial = sub.lineItems?.[0]?.offerDetails?.some(
    (o) => o.offerType === "INTRODUCTORY_PRICE_OFFER_TYPE_FREE_TRIAL"
  ) || false;

  return {
    isActive,
    expiresAt,
    orderId: latestOrderId,
    purchaseToken,
    productId,
    isTrial,
    isAcknowledged,
    subscriptionState: sub.subscriptionState,
    raw: sub,
  };
}

/**
 * Acknowledges a Google Play purchase.
 * IMPORTANT: Must be called within 3 days of purchase or Google auto-refunds.
 */
async function acknowledgePurchase(purchaseToken, productId) {
  const androidPublisher = getAndroidPublisher();

  await androidPublisher.purchases.subscriptions.acknowledge({
    packageName: process.env.GOOGLE_PACKAGE_NAME,
    subscriptionId: productId,
    token: purchaseToken,
    requestBody: {},
  });
}

/**
 * Saves a verified Google receipt to the database.
 */
function saveGoogleReceipt(userId, receiptData, rawResponse) {
  const id = uuidv4();
  db.prepare(`
    INSERT OR REPLACE INTO iap_receipts
      (id, user_id, platform, product_id, transaction_id, purchase_token, expires_at, is_trial, raw_response)
    VALUES (?, ?, 'android', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    receiptData.productId,
    receiptData.orderId,
    receiptData.purchaseToken,
    receiptData.expiresAt,
    receiptData.isTrial ? 1 : 0,
    JSON.stringify(rawResponse)
  );
}

// ─── Real-Time Developer Notifications ────────────────────────────────────────

// Notification type constants from Google
const GOOGLE_NOTIFICATION_TYPES = {
  1:  "SUBSCRIPTION_RECOVERED",
  2:  "SUBSCRIPTION_RENEWED",
  3:  "SUBSCRIPTION_CANCELED",
  4:  "SUBSCRIPTION_PURCHASED",
  5:  "SUBSCRIPTION_ON_HOLD",
  6:  "SUBSCRIPTION_IN_GRACE_PERIOD",
  7:  "SUBSCRIPTION_RESTARTED",
  8:  "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED",
  9:  "SUBSCRIPTION_DEFERRED",
  10: "SUBSCRIPTION_PAUSED",
  11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED",
  12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED",
};

/**
 * Processes a Google Play RTDN (Real-Time Developer Notification).
 * These arrive via Pub/Sub webhook.
 *
 * @param {object} notification - The parsed Pub/Sub message data
 * @returns {{ type, purchaseToken, shouldVerify, shouldDeactivate }}
 */
function processGoogleNotification(notification) {
  const { subscriptionNotification } = notification;

  if (!subscriptionNotification) {
    return { type: "OTHER", shouldVerify: false, shouldDeactivate: false };
  }

  const typeId = subscriptionNotification.notificationType;
  const type   = GOOGLE_NOTIFICATION_TYPES[typeId] || `UNKNOWN_${typeId}`;
  const purchaseToken = subscriptionNotification.purchaseToken;

  // Types that mean we should re-verify and potentially activate/extend
  const verifyTypes = [1, 2, 4, 6, 7];   // recovered, renewed, purchased, grace period, restarted
  // Types that mean we should deactivate
  const deactivateTypes = [3, 12, 13];    // canceled, revoked, expired

  return {
    type,
    purchaseToken,
    subscriptionId: subscriptionNotification.subscriptionId,
    shouldVerify: verifyTypes.includes(typeId),
    shouldDeactivate: deactivateTypes.includes(typeId),
  };
}

/**
 * Saves a Google notification to the DB (idempotency).
 * Returns false if already processed.
 */
function saveGoogleNotification(messageId, typeId, purchaseToken, rawPayload) {
  const existing = db
    .prepare("SELECT id FROM google_notifications WHERE id = ?")
    .get(messageId);
  if (existing) return false;

  db.prepare(`
    INSERT INTO google_notifications (id, notification_type, purchase_token, raw_payload)
    VALUES (?, ?, ?, ?)
  `).run(messageId, typeId, purchaseToken, JSON.stringify(rawPayload));
  return true;
}

module.exports = {
  verifyGooglePurchase,
  acknowledgePurchase,
  saveGoogleReceipt,
  processGoogleNotification,
  saveGoogleNotification,
  GOOGLE_NOTIFICATION_TYPES,
};
