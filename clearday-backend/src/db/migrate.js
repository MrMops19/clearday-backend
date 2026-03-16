// src/db/migrate.js
require("dotenv").config();
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dbPath = process.env.DB_PATH || "./data/clearday.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  -- ── Users ──────────────────────────────────────────────────────────────────
  -- Identified by device_id (UUID generated on first app launch).
  -- No email/password required — frictionless onboarding.
  CREATE TABLE IF NOT EXISTS users (
    id                  TEXT PRIMARY KEY,
    device_id           TEXT UNIQUE NOT NULL,
    platform            TEXT NOT NULL DEFAULT 'unknown', -- 'ios' | 'android' | 'web'
    is_premium          INTEGER NOT NULL DEFAULT 0,
    premium_expires_at  TEXT,             -- ISO datetime, NULL = no active sub
    original_purchase_id TEXT,            -- Apple original_transaction_id or Google purchaseToken
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Trackers ───────────────────────────────────────────────────────────────
  -- Each user can have multiple habit trackers.
  CREATE TABLE IF NOT EXISTS trackers (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    habit_id    TEXT NOT NULL,            -- matches frontend HABITS[].id
    habit_name  TEXT NOT NULL,
    emoji       TEXT NOT NULL DEFAULT '✦',
    color       TEXT NOT NULL DEFAULT '#6741D9',
    cost_per_day REAL NOT NULL DEFAULT 0,
    start_date  TEXT NOT NULL,            -- YYYY-MM-DD
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Check-ins ──────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS checkins (
    id          TEXT PRIMARY KEY,
    tracker_id  TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,            -- YYYY-MM-DD
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tracker_id, date)              -- one check-in per day per tracker
  );

  -- ── Relapses ───────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS relapses (
    id          TEXT PRIMARY KEY,
    tracker_id  TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── IAP Receipts ───────────────────────────────────────────────────────────
  -- Raw receipt log for Apple + Google — idempotency & audit trail
  CREATE TABLE IF NOT EXISTS iap_receipts (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL REFERENCES users(id),
    platform              TEXT NOT NULL,  -- 'ios' | 'android'
    product_id            TEXT NOT NULL,
    transaction_id        TEXT UNIQUE NOT NULL, -- Apple transaction_id or Google orderId
    purchase_token        TEXT,           -- Google only
    expires_at            TEXT,           -- subscription expiry
    is_trial              INTEGER NOT NULL DEFAULT 0,
    raw_response          TEXT,           -- JSON blob of full receipt
    verified_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Apple Notification Events ──────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS apple_notifications (
    id              TEXT PRIMARY KEY,     -- notification_uuid from Apple
    notification_type TEXT NOT NULL,
    subtype         TEXT,
    bundle_id       TEXT,
    raw_payload     TEXT NOT NULL,
    processed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Google Pub/Sub Events ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS google_notifications (
    id              TEXT PRIMARY KEY,     -- Google message ID
    notification_type INTEGER NOT NULL,
    purchase_token  TEXT NOT NULL,
    raw_payload     TEXT NOT NULL,
    processed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Indexes ────────────────────────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_trackers_user ON trackers(user_id);
  CREATE INDEX IF NOT EXISTS idx_checkins_tracker ON checkins(tracker_id);
  CREATE INDEX IF NOT EXISTS idx_relapses_tracker ON relapses(tracker_id);
  CREATE INDEX IF NOT EXISTS idx_users_device ON users(device_id);
`);

console.log("✅ Datenbank migriert:", dbPath);
db.close();
