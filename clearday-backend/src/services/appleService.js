// src/services/appleService.js
//
// Apple StoreKit 2 — App Store Server API
// Docs: https://developer.apple.com/documentation/appstoreserverapi
//
// Flow:
//   1. App calls StoreKit 2 on device → gets a signed transaction
//   2. App sends transactionId to our server
//   3. We call Apple's server to verify and get subscription status
//   4. We activate premium based on the response
//
const fs = require("fs");
const jwt = require("jsonwebtoken");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));
const db = require("../db");
const { v4: uuidv4 } = require("uuid");

const APPLE_PROD_URL = "https://api.storekit.itunes.apple.com";
const APPLE_SANDBOX_URL = "https://api.storekit-sandbox.itunes.apple.com";

/**
 * Generates a short-lived JWT for authenticating with the App Store Server API.
 * Docs: https://developer.apple.com/documentation/appstoreserverapi/generating_a_json_web_token_jwts_for_api_requests
 */
function generateAppleJWT() {
  const privateKey = fs.readFileSync(process.env.APPLE_PRIVATE_KEY_PATH, "utf8");
  return jwt.sign(
    {
      iss: process.env.APPLE_ISSUER_ID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      aud: "appstoreconnect-v1",
      bid: process.env.APPLE_BUNDLE_ID,
    },
    privateKey,
    {
      algorithm: "ES256",
      header: {
        alg: "ES256",
        kid: process.env.APPLE_KEY_ID,
        typ: "JWT",
      },
    }
  );
}

/**
 * Fetches subscription status from Apple for a given originalTransactionId.
 * Returns the parsed subscription info.
 */
async function getSubscriptionStatus(originalTransactionId) {
  const appleJWT = generateAppleJWT();
  const isProd = process.env.NODE_ENV === "production";
  const baseUrl = isProd ? APPLE_PROD_URL : APPLE_SANDBOX_URL;

  const url = `${baseUrl}/inApps/v1/subscriptions/${originalTransactionId}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${appleJWT}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Apple API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data;
}

/**
 * Verifies an Apple purchase and returns subscription details.
 *
 * @param {string} originalTransactionId - From StoreKit 2 on the device
 * @returns {{ isActive, expiresAt, productId, originalTransactionId }}
 */
async function verifyApplePurchase(originalTransactionId) {
  const data = await getSubscriptionStatus(originalTransactionId);

  if (!data.data || data.data.length === 0) {
    throw new Error("Keine Subscription-Daten von Apple erhalten.");
  }

  // Find the most recent subscription item
  const subscriptionGroup = data.data[0];
  const lastTransaction = subscriptionGroup.lastTransactions?.[0];

  if (!lastTransaction) {
    throw new Error("Keine Transaktionen gefunden.");
  }

  // status: 1 = active, 2 = expired, 3 = in billing retry, 4 = in billing grace period, 5 = revoked
  const isActive = [1, 3, 4].includes(lastTransaction.status);

  // expiresDate is in milliseconds
  const expiresAt = lastTransaction.expiresDate
    ? new Date(lastTransaction.expiresDate).toISOString()
    : null;

  return {
    isActive,
    expiresAt,
    productId: lastTransaction.productId,
    originalTransactionId: lastTransaction.originalTransactionId,
    transactionId: lastTransaction.transactionId,
    status: lastTransaction.status,
    isTrial: lastTransaction.offerType === 1,
  };
}

/**
 * Saves a verified Apple receipt to the database.
 */
function saveAppleReceipt(userId, receiptData, rawResponse) {
  const id = uuidv4();
  db.prepare(`
    INSERT OR REPLACE INTO iap_receipts
      (id, user_id, platform, product_id, transaction_id, expires_at, is_trial, raw_response)
    VALUES (?, ?, 'ios', ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    receiptData.productId,
    receiptData.transactionId,
    receiptData.expiresAt,
    receiptData.isTrial ? 1 : 0,
    JSON.stringify(rawResponse)
  );
}

/**
 * Processes an Apple App Store Server Notification (webhook).
 * Apple sends these for subscription lifecycle events.
 * Docs: https://developer.apple.com/documentation/appstoreservernotifications
 *
 * @param {object} payload - The decoded JWS payload from Apple
 * @returns {{ type, originalTransactionId, expiresAt, shouldActivate }}
 */
function processAppleNotification(payload) {
  const { notificationType, subtype, data } = payload;

  // Decode the signedTransactionInfo (it's a JWS — we trust it since it passed signature check)
  // In production, verify the JWS signature using Apple's root certificates
  const transactionInfo = decodeAppleJWS(data.signedTransactionInfo);
  const renewalInfo = data.signedRenewalInfo
    ? decodeAppleJWS(data.signedRenewalInfo)
    : null;

  const result = {
    notificationType,
    subtype,
    originalTransactionId: transactionInfo?.originalTransactionId,
    expiresAt: transactionInfo?.expiresDate
      ? new Date(transactionInfo.expiresDate).toISOString()
      : null,
    shouldActivate: false,
    shouldDeactivate: false,
  };

  // Determine what action to take
  switch (notificationType) {
    case "SUBSCRIBED":
    case "DID_RENEW":
    case "OFFER_REDEEMED":
      result.shouldActivate = true;
      break;
    case "DID_FAIL_TO_RENEW":
    case "EXPIRED":
    case "REVOKE":
      result.shouldDeactivate = true;
      break;
    case "GRACE_PERIOD_EXPIRED":
      result.shouldDeactivate = true;
      break;
    case "REFUND":
      result.shouldDeactivate = true;
      break;
    // CONSUMPTION_REQUEST, PRICE_INCREASE, TEST — no action needed
    default:
      break;
  }

  return result;
}

/**
 * Decodes a JWS payload (without verifying signature — for reading only).
 * In production, verify using Apple's root certificate.
 */
function decodeAppleJWS(jws) {
  if (!jws) return null;
  try {
    const parts = jws.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Saves an Apple server notification to the DB (idempotency).
 */
function saveAppleNotification(notificationUUID, type, subtype, bundleId, rawPayload) {
  const existing = db
    .prepare("SELECT id FROM apple_notifications WHERE id = ?")
    .get(notificationUUID);
  if (existing) return false; // already processed

  db.prepare(`
    INSERT INTO apple_notifications (id, notification_type, subtype, bundle_id, raw_payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(notificationUUID, type, subtype || null, bundleId || null, JSON.stringify(rawPayload));
  return true;
}

module.exports = {
  verifyApplePurchase,
  saveAppleReceipt,
  processAppleNotification,
  saveAppleNotification,
  decodeAppleJWS,
};
