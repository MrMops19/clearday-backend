require("dotenv").config();

const express = require("express");
const helmet  = require("helmet");
const cors    = require("cors");

const authRouter = require("./routes/auth");
const iapRouter  = require("./routes/iap");
const syncRouter = require("./routes/sync");

const { apiLimiter, authLimiter } = require("./middleware/rateLimiter");

const app = express();

app.use(helmet());
app.set("trust proxy", 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",").map((o) => o.trim());
const allowAll = allowedOrigins.includes("*");

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowAll) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: Origin ${origin} not allowed.`));
  },
  methods: ["GET", "POST", "DELETE", "PATCH", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));
app.options("*", cors());

app.use("/api/iap", iapRouter);
app.use(express.json({ limit: "512kb" }));
app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter);
app.use("/api/auth", authRouter);
app.use("/api/sync", syncRouter);

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0", env: process.env.NODE_ENV });
});

app.use((req, res) => {
  res.status(404).json({ error: "Route nicht gefunden." });
});

app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  res.status(500).json({ error: "Interner Serverfehler." });
});

const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, () => {
  console.log(`✦ Clearday Backend · Port ${PORT} · ${process.env.NODE_ENV}`);
});

module.exports = app;
