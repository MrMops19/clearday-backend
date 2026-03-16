# Clearday Backend

Node.js + Express + SQLite backend for the Clearday habit tracker app.

## Stack
- **Runtime:** Node.js 18+
- **Framework:** Express 4
- **Database:** SQLite via `better-sqlite3`
- **Auth:** JWT (device-based, no email/password)
- **IAP:** Apple StoreKit 2 + Google Play Billing

---

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your secrets
npm run migrate        # create database
npm run dev            # start dev server (port 3001)
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3001) |
| `JWT_SECRET` | Random secret string (min 32 chars) |
| `DB_PATH` | SQLite DB file path (default: ./data/clearday.db) |
| `APPLE_BUNDLE_ID` | e.g. `com.yourname.clearday` |
| `APPLE_ISSUER_ID` | From App Store Connect → Keys |
| `APPLE_KEY_ID` | From App Store Connect → Keys |
| `APPLE_PRIVATE_KEY` | Contents of the .p8 file (with newlines as `\n`) |
| `GOOGLE_PACKAGE_NAME` | e.g. `com.yourname.clearday` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service account JSON as single-line string |
| `PRODUCT_ID_MONTHLY` | e.g. `clearday_premium_monthly` |
| `PRODUCT_ID_YEARLY` | e.g. `clearday_premium_yearly` |

---

## API Endpoints

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Device login → JWT token |

**Body:** `{ deviceId: string, platform: "ios" | "android" | "web" }`  
**Returns:** `{ token, userId, isPremium }`

---

### Sync
All routes require `Authorization: Bearer <token>` header.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sync` | Pull all tracker data |
| `POST` | `/api/sync/tracker` | Create or update a tracker |
| `DELETE` | `/api/sync/tracker/:id` | Delete a tracker |
| `POST` | `/api/sync/relapse` | Record relapse + reset tracker |
| `POST` | `/api/sync/lang` | Save language preference (en/de) |
| `POST` | `/api/sync/bulk` | Full offline sync |

#### Tracker object (all fields)
```json
{
  "id": "uuid",
  "habitId": "alcohol",
  "habitName": "Alcohol",
  "emoji": "🍺",
  "color": "#E86A3A",
  "costPerDay": 15,
  "startDate": "2025-03-16",
  "startISO": "2025-03-16T14:32:01.000Z",
  "why": "I want to be present for my family.",
  "bestTime": 604800,
  "runHistory": [
    { "startISO": "2025-01-01T00:00:00Z", "endISO": "2025-03-16T14:32:00Z", "totalSec": 604800 }
  ],
  "unlockedMilestones": ["m1h", "m6h", "m1d"],
  "checkins": ["2025-03-16"],
  "relapses": ["2025-03-16"]
}
```

---

### IAP
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/iap/apple/verify` | Verify Apple subscription |
| `POST` | `/api/iap/apple/verify-lifetime` | Verify Apple one-time purchase |
| `POST` | `/api/iap/google/verify` | Verify Google subscription |
| `POST` | `/api/iap/google/verify-lifetime` | Verify Google one-time purchase |
| `POST` | `/api/iap/apple/notifications` | Apple server-to-server webhook |
| `POST` | `/api/iap/google/notifications` | Google Pub/Sub webhook |
| `GET` | `/api/iap/status` | Check premium status |

---

## Deploy on Railway

1. Push this folder to a GitHub repo
2. Create a new project on [railway.app](https://railway.app)
3. Connect your GitHub repo
4. Add all environment variables in the Railway dashboard
5. Railway auto-detects Node.js and deploys

**Start command:** `npm start`  
**Build command:** `npm run migrate && npm start`

Railway gives you a public URL like `https://clearday-backend.up.railway.app` — use this as your API base URL in the app.

---

## Deploy on Render

1. Push to GitHub
2. New Web Service on [render.com](https://render.com)
3. Build Command: `npm install`
4. Start Command: `npm run migrate && npm start`
5. Add environment variables
6. Free tier available (spins down after inactivity — upgrade for always-on)

---

## Data Model

```
users
  └── trackers (1:many)
        ├── checkins (1:many)
        └── relapses (1:many)

iap_receipts (audit log)
apple_notifications (webhook log)
google_notifications (webhook log)
```

All tracker metadata (why, runHistory, unlockedMilestones, bestTime) is stored directly on the tracker row. Checkins and relapses are stored as separate rows for query efficiency.
