// src/routes/sync.js
const express = require("express");
const router  = express.Router();
const { v4: uuidv4 } = require("uuid");
const { requireAuth } = require("../middleware/auth");
const { isPremiumActive } = require("../services/userService");
const db = require("../db");

const FREE_TRACKER_LIMIT = 1;

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeJson(val, fallback) {
  try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
}

function getUserTrackers(userId) {
  const rows = db
    .prepare("SELECT * FROM trackers WHERE user_id = ? AND is_active = 1 ORDER BY created_at ASC")
    .all(userId);

  return rows.map((t) => {
    const checkins = db
      .prepare("SELECT date FROM checkins WHERE tracker_id = ? ORDER BY date ASC")
      .all(t.id).map((c) => c.date);

    const relapses = db
      .prepare("SELECT date FROM relapses WHERE tracker_id = ? ORDER BY date ASC")
      .all(t.id).map((r) => r.date);

    return {
      id:                 t.id,
      habitId:            t.habit_id,
      habitName:          t.habit_name,
      emoji:              t.emoji,
      color:              t.color,
      costPerDay:         t.cost_per_day,
      startDate:          t.start_date,
      startISO:           t.start_iso || null,
      why:                t.why || "",
      bestTime:           t.best_time || 0,
      runHistory:         safeJson(t.run_history, []),
      unlockedMilestones: safeJson(t.unlocked_milestones, []),
      checkins,
      relapses,
      createdAt:          t.created_at,
    };
  });
}

// ── GET /api/sync ─────────────────────────────────────────────────────────────
// Pull all data. Called on app launch to restore from server.

router.get("/", requireAuth, (req, res) => {
  try {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found." });

    res.json({
      trackers:         getUserTrackers(req.user.userId),
      isPremium:        isPremiumActive(user),
      premiumExpiresAt: user.premium_expires_at || null,
      lang:             user.lang || "en",
      syncedAt:         new Date().toISOString(),
    });
  } catch (err) {
    console.error("Sync GET error:", err);
    res.status(500).json({ error: "Sync failed." });
  }
});

// ── POST /api/sync/tracker ────────────────────────────────────────────────────
// Create or update a single tracker.

router.post("/tracker", requireAuth, (req, res) => {
  const {
    id, habitId, habitName, emoji, color, costPerDay,
    startDate, startISO, why, bestTime, runHistory, unlockedMilestones,
  } = req.body;

  if (!habitId || !habitName || !startDate) {
    return res.status(400).json({ error: "habitId, habitName and startDate are required." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ error: "startDate must be YYYY-MM-DD." });
  }

  try {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);

    if (!isPremiumActive(user)) {
      const count = db
        .prepare("SELECT COUNT(*) as n FROM trackers WHERE user_id = ? AND is_active = 1")
        .get(req.user.userId).n;
      if (!id && count >= FREE_TRACKER_LIMIT) {
        return res.status(403).json({ error: "free_limit_reached" });
      }
    }

    const runHistoryJson         = JSON.stringify(runHistory || []);
    const unlockedMilestonesJson = JSON.stringify(unlockedMilestones || []);

    if (id) {
      const existing = db
        .prepare("SELECT * FROM trackers WHERE id = ? AND user_id = ?")
        .get(id, req.user.userId);

      if (!existing) return res.status(404).json({ error: "Tracker not found." });

      db.prepare(`
        UPDATE trackers SET
          habit_id = ?, habit_name = ?, emoji = ?, color = ?,
          cost_per_day = ?, start_date = ?, start_iso = ?, why = ?,
          best_time = ?, run_history = ?, unlocked_milestones = ?,
          updated_at = datetime('now')
        WHERE id = ? AND user_id = ?
      `).run(
        habitId, habitName, emoji || "✦", color || "#6741D9",
        costPerDay || 0, startDate, startISO || null, why || null,
        bestTime || 0, runHistoryJson, unlockedMilestonesJson,
        id, req.user.userId
      );

      res.json({ success: true, trackerId: id });
    } else {
      const trackerId = uuidv4();
      db.prepare(`
        INSERT INTO trackers
          (id, user_id, habit_id, habit_name, emoji, color, cost_per_day,
           start_date, start_iso, why, best_time, run_history, unlocked_milestones)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trackerId, req.user.userId, habitId, habitName,
        emoji || "✦", color || "#6741D9", costPerDay || 0,
        startDate, startISO || null, why || null,
        bestTime || 0, runHistoryJson, unlockedMilestonesJson
      );

      res.status(201).json({ success: true, trackerId });
    }
  } catch (err) {
    console.error("Sync tracker error:", err);
    res.status(500).json({ error: "Could not save tracker." });
  }
});

// ── DELETE /api/sync/tracker/:id ──────────────────────────────────────────────

router.delete("/tracker/:trackerId", requireAuth, (req, res) => {
  try {
    const t = db
      .prepare("SELECT * FROM trackers WHERE id = ? AND user_id = ?")
      .get(req.params.trackerId, req.user.userId);

    if (!t) return res.status(404).json({ error: "Tracker not found." });

    db.prepare("UPDATE trackers SET is_active = 0, updated_at = datetime('now') WHERE id = ?")
      .run(req.params.trackerId);

    res.json({ success: true });
  } catch (err) {
    console.error("Delete tracker error:", err);
    res.status(500).json({ error: "Could not delete tracker." });
  }
});

// ── POST /api/sync/relapse ────────────────────────────────────────────────────
// Record a relapse + reset the tracker. Saves full run history entry.

router.post("/relapse", requireAuth, (req, res) => {
  const { trackerId, date, note, startISO, bestTime, runHistory } = req.body;

  if (!trackerId || !date) {
    return res.status(400).json({ error: "trackerId and date are required." });
  }

  try {
    const t = db
      .prepare("SELECT * FROM trackers WHERE id = ? AND user_id = ?")
      .get(trackerId, req.user.userId);

    if (!t) return res.status(404).json({ error: "Tracker not found." });

    const newRunHistory = JSON.stringify(runHistory || []);
    const newStartISO   = new Date().toISOString();
    const newStartDate  = date;

    db.transaction(() => {
      // Save relapse record
      db.prepare(
        "INSERT INTO relapses (id, tracker_id, date, note) VALUES (?, ?, ?, ?)"
      ).run(uuidv4(), trackerId, date, note || null);

      // Reset tracker + update run history + best time
      db.prepare(`
        UPDATE trackers SET
          start_date = ?, start_iso = ?,
          best_time = ?, run_history = ?,
          unlocked_milestones = '[]',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(newStartDate, newStartISO, bestTime || 0, newRunHistory, trackerId);
    })();

    res.json({ success: true, newStartISO });
  } catch (err) {
    console.error("Relapse error:", err);
    res.status(500).json({ error: "Could not save relapse." });
  }
});

// ── POST /api/sync/lang ───────────────────────────────────────────────────────
// Save language preference for the user.

router.post("/lang", requireAuth, (req, res) => {
  const { lang } = req.body;
  if (!["en", "de"].includes(lang)) {
    return res.status(400).json({ error: "lang must be 'en' or 'de'." });
  }
  try {
    db.prepare("UPDATE users SET lang = ?, updated_at = datetime('now') WHERE id = ?")
      .run(lang, req.user.userId);
    res.json({ success: true, lang });
  } catch (err) {
    console.error("Lang update error:", err);
    res.status(500).json({ error: "Could not update language." });
  }
});

// ── POST /api/sync/bulk ───────────────────────────────────────────────────────
// Full sync — push all local data to server (first launch / after offline).

router.post("/bulk", requireAuth, (req, res) => {
  const { trackers, lang } = req.body;

  if (!Array.isArray(trackers)) {
    return res.status(400).json({ error: "trackers must be an array." });
  }

  try {
    const user    = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);
    const premium = isPremiumActive(user);
    const list    = premium ? trackers : trackers.slice(0, FREE_TRACKER_LIMIT);

    // Update language preference if provided
    if (lang && ["en","de"].includes(lang)) {
      db.prepare("UPDATE users SET lang = ?, updated_at = datetime('now') WHERE id = ?")
        .run(lang, req.user.userId);
    }

    db.transaction(() => {
      for (const t of list) {
        if (!t.habitId || !t.startDate) continue;

        const tid = t.id || uuidv4();

        db.prepare(`
          INSERT INTO trackers
            (id, user_id, habit_id, habit_name, emoji, color, cost_per_day,
             start_date, start_iso, why, best_time, run_history, unlocked_milestones)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            habit_name          = excluded.habit_name,
            start_date          = excluded.start_date,
            start_iso           = excluded.start_iso,
            why                 = excluded.why,
            best_time           = excluded.best_time,
            run_history         = excluded.run_history,
            unlocked_milestones = excluded.unlocked_milestones,
            updated_at          = datetime('now')
        `).run(
          tid, req.user.userId, t.habitId,
          t.habitName || t.habitId,
          t.emoji || "✦",
          t.color || "#6741D9",
          t.costPerDay || 0,
          t.startDate,
          t.startISO || null,
          t.why || null,
          t.bestTime || 0,
          JSON.stringify(t.runHistory || []),
          JSON.stringify(t.unlockedMilestones || [])
        );

        // Checkins
        for (const date of (t.checkins || [])) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            db.prepare("INSERT OR IGNORE INTO checkins (id, tracker_id, date) VALUES (?, ?, ?)")
              .run(uuidv4(), tid, date);
          }
        }

        // Relapses
        for (const date of (t.relapses || [])) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            const exists = db
              .prepare("SELECT id FROM relapses WHERE tracker_id = ? AND date = ?")
              .get(tid, date);
            if (!exists) {
              db.prepare("INSERT INTO relapses (id, tracker_id, date) VALUES (?, ?, ?)")
                .run(uuidv4(), tid, date);
            }
          }
        }
      }
    })();

    res.json({ success: true, trackers: getUserTrackers(req.user.userId) });
  } catch (err) {
    console.error("Bulk sync error:", err);
    res.status(500).json({ error: "Bulk sync failed." });
  }
});

module.exports = router;
