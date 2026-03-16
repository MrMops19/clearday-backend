// src/routes/sync.js
//
// Data sync — saves and restores tracker data server-side.
// This lets users keep their data if they reinstall the app or switch phones.
//
const express = require("express");
const router  = express.Router();
const { v4: uuidv4 } = require("uuid");
const { requireAuth } = require("../middleware/auth");
const { isPremiumActive } = require("../services/userService");
const db = require("../db");

const FREE_TRACKER_LIMIT = 1;

// ─── Helper ──────────────────────────────────────────────────────────────────

function getUserTrackers(userId) {
  const trackers = db
    .prepare("SELECT * FROM trackers WHERE user_id = ? AND is_active = 1 ORDER BY created_at ASC")
    .all(userId);

  return trackers.map((t) => {
    const checkins = db
      .prepare("SELECT date FROM checkins WHERE tracker_id = ? ORDER BY date DESC")
      .all(t.id)
      .map((c) => c.date);

    const relapses = db
      .prepare("SELECT date, note FROM relapses WHERE tracker_id = ? ORDER BY date DESC")
      .all(t.id)
      .map((r) => r.date);

    return {
      id:          t.id,
      habitId:     t.habit_id,
      habitName:   t.habit_name,
      emoji:       t.emoji,
      color:       t.color,
      costPerDay:  t.cost_per_day,
      startDate:   t.start_date,
      checkins,
      relapses,
      createdAt:   t.created_at,
    };
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/sync
 *
 * Pull all tracker data for the current user.
 * App calls this on launch to restore data.
 */
router.get("/", requireAuth, (req, res) => {
  try {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);
    if (!user) return res.status(404).json({ error: "User nicht gefunden." });

    const trackers = getUserTrackers(req.user.userId);

    res.json({
      trackers,
      isPremium:       isPremiumActive(user),
      premiumExpiresAt: user.premium_expires_at || null,
      syncedAt:        new Date().toISOString(),
    });
  } catch (err) {
    console.error("Sync GET error:", err);
    res.status(500).json({ error: "Sync fehlgeschlagen." });
  }
});

/**
 * POST /api/sync/tracker
 *
 * Create or update a single tracker.
 * If id is provided and exists → update. Otherwise → create.
 *
 * Body: { id?, habitId, habitName, emoji, color, costPerDay, startDate }
 */
router.post("/tracker", requireAuth, (req, res) => {
  const { id, habitId, habitName, emoji, color, costPerDay, startDate } = req.body;

  if (!habitId || !habitName || !startDate) {
    return res.status(400).json({ error: "habitId, habitName und startDate sind erforderlich." });
  }

  // Validate startDate format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ error: "startDate muss im Format YYYY-MM-DD sein." });
  }

  try {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);

    // Check tracker limit for free users
    if (!isPremiumActive(user)) {
      const count = db
        .prepare("SELECT COUNT(*) as n FROM trackers WHERE user_id = ? AND is_active = 1")
        .get(req.user.userId).n;

      if (!id && count >= FREE_TRACKER_LIMIT) {
        return res.status(403).json({
          error: "free_limit_reached",
          message: `Kostenlos nur ${FREE_TRACKER_LIMIT} Tracker. Upgrade auf Premium.`,
        });
      }
    }

    if (id) {
      // Update existing tracker
      const existing = db
        .prepare("SELECT * FROM trackers WHERE id = ? AND user_id = ?")
        .get(id, req.user.userId);

      if (!existing) {
        return res.status(404).json({ error: "Tracker nicht gefunden." });
      }

      db.prepare(`
        UPDATE trackers
        SET habit_id = ?, habit_name = ?, emoji = ?, color = ?,
            cost_per_day = ?, start_date = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?
      `).run(
        habitId, habitName, emoji || "✦", color || "#6741D9",
        costPerDay || 0, startDate, id, req.user.userId
      );

      res.json({ success: true, trackerId: id });
    } else {
      // Create new tracker
      const trackerId = uuidv4();
      db.prepare(`
        INSERT INTO trackers (id, user_id, habit_id, habit_name, emoji, color, cost_per_day, start_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trackerId, req.user.userId, habitId, habitName,
        emoji || "✦", color || "#6741D9", costPerDay || 0, startDate
      );

      res.status(201).json({ success: true, trackerId });
    }
  } catch (err) {
    console.error("Sync tracker error:", err);
    res.status(500).json({ error: "Tracker konnte nicht gespeichert werden." });
  }
});

/**
 * DELETE /api/sync/tracker/:trackerId
 *
 * Soft-deletes a tracker (sets is_active = 0).
 */
router.delete("/tracker/:trackerId", requireAuth, (req, res) => {
  const { trackerId } = req.params;

  try {
    const tracker = db
      .prepare("SELECT * FROM trackers WHERE id = ? AND user_id = ?")
      .get(trackerId, req.user.userId);

    if (!tracker) {
      return res.status(404).json({ error: "Tracker nicht gefunden." });
    }

    db.prepare("UPDATE trackers SET is_active = 0, updated_at = datetime('now') WHERE id = ?")
      .run(trackerId);

    res.json({ success: true });
  } catch (err) {
    console.error("Delete tracker error:", err);
    res.status(500).json({ error: "Tracker konnte nicht gelöscht werden." });
  }
});

/**
 * POST /api/sync/checkin
 *
 * Record a daily check-in.
 * Body: { trackerId, date }  (date = YYYY-MM-DD)
 */
router.post("/checkin", requireAuth, (req, res) => {
  const { trackerId, date } = req.body;

  if (!trackerId || !date) {
    return res.status(400).json({ error: "trackerId und date sind erforderlich." });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date muss im Format YYYY-MM-DD sein." });
  }

  try {
    // Verify tracker belongs to user
    const tracker = db
      .prepare("SELECT * FROM trackers WHERE id = ? AND user_id = ?")
      .get(trackerId, req.user.userId);

    if (!tracker) {
      return res.status(404).json({ error: "Tracker nicht gefunden." });
    }

    const checkinId = uuidv4();
    db.prepare(
      "INSERT OR IGNORE INTO checkins (id, tracker_id, date) VALUES (?, ?, ?)"
    ).run(checkinId, trackerId, date);

    res.json({ success: true });
  } catch (err) {
    console.error("Checkin error:", err);
    res.status(500).json({ error: "Check-in konnte nicht gespeichert werden." });
  }
});

/**
 * POST /api/sync/relapse
 *
 * Record a relapse and reset the tracker start date to today.
 * Body: { trackerId, date, note? }
 */
router.post("/relapse", requireAuth, (req, res) => {
  const { trackerId, date, note } = req.body;

  if (!trackerId || !date) {
    return res.status(400).json({ error: "trackerId und date sind erforderlich." });
  }

  try {
    const tracker = db
      .prepare("SELECT * FROM trackers WHERE id = ? AND user_id = ?")
      .get(trackerId, req.user.userId);

    if (!tracker) {
      return res.status(404).json({ error: "Tracker nicht gefunden." });
    }

    const tx = db.transaction(() => {
      // Save relapse
      db.prepare(
        "INSERT INTO relapses (id, tracker_id, date, note) VALUES (?, ?, ?, ?)"
      ).run(uuidv4(), trackerId, date, note || null);

      // Reset start date
      db.prepare(
        "UPDATE trackers SET start_date = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(date, trackerId);

      // Clear checkins from the new start date onwards (keep history)
      // We DON'T delete old checkins — they're part of the history
    });

    tx();

    res.json({ success: true });
  } catch (err) {
    console.error("Relapse error:", err);
    res.status(500).json({ error: "Rückfall konnte nicht gespeichert werden." });
  }
});

/**
 * POST /api/sync/bulk
 *
 * Full sync — push all local data to server (called on first sync
 * or after offline period). Server merges intelligently.
 *
 * Body: { trackers: [...] }
 */
router.post("/bulk", requireAuth, (req, res) => {
  const { trackers } = req.body;

  if (!Array.isArray(trackers)) {
    return res.status(400).json({ error: "trackers muss ein Array sein." });
  }

  try {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);
    const premium = isPremiumActive(user);

    // Limit to FREE_TRACKER_LIMIT for free users
    const trackersToSync = premium ? trackers : trackers.slice(0, FREE_TRACKER_LIMIT);

    const tx = db.transaction(() => {
      for (const t of trackersToSync) {
        if (!t.habitId || !t.startDate) continue;

        const trackerId = t.id || uuidv4();

        // Upsert tracker
        db.prepare(`
          INSERT INTO trackers (id, user_id, habit_id, habit_name, emoji, color, cost_per_day, start_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            habit_name = excluded.habit_name,
            start_date = excluded.start_date,
            updated_at = datetime('now')
        `).run(
          trackerId, req.user.userId, t.habitId,
          t.habitName || t.habitId,
          t.emoji || "✦",
          t.color || "#6741D9",
          t.costPerDay || 0,
          t.startDate
        );

        // Upsert checkins
        for (const date of (t.checkins || [])) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            db.prepare(
              "INSERT OR IGNORE INTO checkins (id, tracker_id, date) VALUES (?, ?, ?)"
            ).run(uuidv4(), trackerId, date);
          }
        }

        // Upsert relapses
        for (const date of (t.relapses || [])) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            const exists = db
              .prepare("SELECT id FROM relapses WHERE tracker_id = ? AND date = ?")
              .get(trackerId, date);
            if (!exists) {
              db.prepare(
                "INSERT INTO relapses (id, tracker_id, date) VALUES (?, ?, ?)"
              ).run(uuidv4(), trackerId, date);
            }
          }
        }
      }
    });

    tx();

    // Return merged data
    const updatedTrackers = getUserTrackers(req.user.userId);
    res.json({ success: true, trackers: updatedTrackers });
  } catch (err) {
    console.error("Bulk sync error:", err);
    res.status(500).json({ error: "Bulk-Sync fehlgeschlagen." });
  }
});

module.exports = router;
