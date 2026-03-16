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
  CREATE TABLE IF NOT EXISTS users (
    id                   TEXT PRIMARY KEY,
    device_id            TEXT UNIQUE NOT NULL,
    platform             TEXT NOT NULL DEFAULT 'unknown',
    is_premium           INTEGER NOT NULL DEFAULT 0,
    premium_expires_at   TEXT,
    original_purchase_id TEXT,
    lang                 TEXT NOT NULL DEFAULT 'en',
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- start_iso  = full ISO timestamp for second-precision timer
  -- why        = personal motivation note entered at onboarding
  -- best_time  = personal record in seconds
  -- run_history = JSON array [{startISO, endISO, totalSec}]
  -- unlocked_milestones = JSON array of milestone id strings
  CREATE TABLE IF NOT EXISTS trackers (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    habit_id             TEXT NOT NULL,
    habit_name           TEXT NOT NULL,
    emoji                TEXT NOT NULL DEFAULT 'X',
    color                TEXT NOT NULL DEFAULT '#6741D9',
    cost_per_day         REAL NOT NULL DEFAULT 0,
    start_date           TEXT NOT NULL,
    start_iso            TEXT,
    why                  TEXT,
    best_time            INTEGER NOT NULL DEFAULT 0,
    run_history          TEXT NOT NULL DEFAULT '[]',
    unlocked_milestones  TEXT NOT NULL DEFAULT '[]',
    is_active            INTEGER NOT NULL DEFAULT 1,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id          TEXT PRIMARY KEY,
    tracker_id  TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tracker_id, date)
  );

  CREATE TABLE IF NOT EXISTS relapses (
    id          TEXT PRIMARY KEY,
    tracker_id  TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS iap_receipts (
    id                    TEXT PRIMARY KEY,
    user_id               TEXT NOT NULL REFERENCES users(id),
    platform              TEXT NOT NULL,
    product_id            TEXT NOT NULL,
    transaction_id        TEXT UNIQUE NOT NULL,
    purchase_token        TEXT,
    expires_at            TEXT,
    is_trial              INTEGER NOT NULL DEFAULT 0,
    raw_response          TEXT,
    verified_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS apple_notifications (
    id                TEXT PRIMARY KEY,
    notification_type TEXT NOT NULL,
    subtype           TEXT,
    bundle_id         TEXT,
    raw_payload       TEXT NOT NULL,
    processed_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS google_notifications (
    id                TEXT PRIMARY KEY,
    notification_type INTEGER NOT NULL,
    purchase_token    TEXT NOT NULL,
    raw_payload       TEXT NOT NULL,
    processed_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trackers_user    ON trackers(user_id);
  CREATE INDEX IF NOT EXISTS idx_checkins_tracker ON checkins(tracker_id);
  CREATE INDEX IF NOT EXISTS idx_relapses_tracker ON relapses(tracker_id);
  CREATE INDEX IF NOT EXISTS idx_users_device     ON users(device_id);
`);

// Live migrations — safe to run on existing DBs (columns already added = no-op)
const migrations = [
  "ALTER TABLE trackers ADD COLUMN start_iso TEXT",
  "ALTER TABLE trackers ADD COLUMN why TEXT",
  "ALTER TABLE trackers ADD COLUMN best_time INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE trackers ADD COLUMN run_history TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE trackers ADD COLUMN unlocked_milestones TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE users    ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'",
];
for (const sql of migrations) {
  try { db.prepare(sql).run(); } catch (_) { /* column already exists, skip */ }
}

console.log("Database migrated:", dbPath);
db.close();
