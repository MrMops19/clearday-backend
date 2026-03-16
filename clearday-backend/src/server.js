// src/server.js
require("dotenv").config();

const express = require("express");
const helmet  = require("helmet");
const cors    = require("cors");

const authRouter = require("./routes/auth");
const iapRouter  = require("./routes/iap");
const syncRouter = require("./routes/sync");

const { apiLimiter, authLimiter } = require("./middleware/rateLimiter");

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());
app.set("trust proxy", 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Mobile apps don't need CORS, but the web version does.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: Origin ${origin} nicht erlaubt.`));
    },
    methods: ["GET", "POST", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ─── Body parsers ─────────────────────────────────────────────────────────────
// NOTE: Apple webhook needs raw body — registered BEFORE express.json()
app.use("/api/iap", iapRouter); // has its own body parser per route

app.use(express.json({ limit: "512kb" }));

// ─── Rate limiting ─────────────────────────────────────────────────────────────
app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/sync", syncRouter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    version: "1.0.0",
    env:     process.env.NODE_ENV,
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Route nicht gefunden." });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  // Don't leak stack traces in production
  if (process.env.NODE_ENV === "production") {
    console.error("Unhandled error:", err.message);
    res.status(500).json({ error: "Interner Serverfehler." });
  } else {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3001", 10);

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║  ✦  Clearday Backend                    ║
  ║  Port  : ${PORT}                             ║
  ║  Env   : ${(process.env.NODE_ENV || "development").padEnd(12)}                ║
  ╚══════════════════════════════════════════╝
  `);
});

module.exports = app;
