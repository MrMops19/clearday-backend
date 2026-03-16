# ✦ Clearday — Backend

Node.js + Express Backend für iOS & Android mit echten In-App-Purchases.

---

## ⚠️ Wichtig: Apple & Google zahlen — kein Stripe

Für digitale Inhalte (Subscriptions, Premium-Features) in Apps:
- **iOS App Store**: Apple verlangt StoreKit / In-App Purchase → Apple nimmt 15–30%
- **Google Play Store**: Google verlangt Play Billing → Google nimmt 15–30%
- Stripe oder direkte Kreditkartenzahlung für digitale Inhalte ist **verboten** und führt zur App-Ablehnung

---

## Architektur

```
Mobile App (iOS/Android)
    │
    │  POST /api/auth/login          → JWT holen (device ID)
    │  POST /api/iap/apple/verify    → Apple-Kauf verifizieren
    │  POST /api/iap/google/verify   → Google-Kauf verifizieren
    │  GET  /api/sync                → Daten laden
    │  POST /api/sync/bulk           → Daten hochladen
    │  POST /api/sync/checkin        → Check-in speichern
    │  POST /api/sync/relapse        → Rückfall speichern
    ▼
Express Backend
    ├── JWT Auth (device-based, kein Login nötig)
    ├── Apple StoreKit 2 Verifikation
    ├── Google Play Developer API Verifikation
    ├── Webhook Handler (Apple & Google)
    └── SQLite Datenbank
```

---

## Quick Start

### 1. Installieren
```bash
npm install
cp .env.example .env
```

### 2. .env ausfüllen (Schritt-für-Schritt unten)

### 3. Datenbank erstellen
```bash
npm run db:migrate
```

### 4. Starten
```bash
npm run dev        # Development
npm start          # Production
```

---

## API Dokumentation

### Auth

| Method | Endpoint | Beschreibung |
|--------|----------|-------------|
| POST | `/api/auth/login` | Device einloggen, JWT holen |
| GET  | `/api/auth/me` | Aktueller User-Status |

**Login Request:**
```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "platform": "ios"
}
```

**Login Response:**
```json
{
  "token": "eyJ...",
  "userId": "uuid",
  "isPremium": false,
  "premiumExpiresAt": null
}
```

### In-App Purchases

| Method | Endpoint | Beschreibung |
|--------|----------|-------------|
| POST | `/api/iap/apple/verify` | Apple-Kauf verifizieren |
| POST | `/api/iap/apple/notifications` | Apple Webhook |
| POST | `/api/iap/google/verify` | Google-Kauf verifizieren |
| POST | `/api/iap/google/notifications` | Google Pub/Sub Webhook |
| GET  | `/api/iap/status` | Premium-Status prüfen |

**Apple Verify Request:**
```json
{ "originalTransactionId": "2000000123456789" }
```

**Google Verify Request:**
```json
{
  "purchaseToken": "xxxxxxxx...",
  "productId": "clearday_premium_monthly"
}
```

### Sync

| Method | Endpoint | Beschreibung |
|--------|----------|-------------|
| GET  | `/api/sync` | Alle Tracker laden |
| POST | `/api/sync/bulk` | Alle lokalen Daten hochladen |
| POST | `/api/sync/tracker` | Tracker erstellen/updaten |
| DELETE | `/api/sync/tracker/:id` | Tracker löschen |
| POST | `/api/sync/checkin` | Check-in speichern |
| POST | `/api/sync/relapse` | Rückfall speichern |

---

## Apple Setup (iOS)

### Schritt 1: App Store Connect
1. → [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
2. Deine App → **Features** → **In-App Purchases** → **+**
3. Typ: **Auto-Renewable Subscription**
4. Produkt-ID: `clearday_premium_monthly`
5. Preis: 4,99 € / Monat
6. Subscription Group erstellen

### Schritt 2: API Key für Server
1. → **Users & Access** → **Integrations** → **In-App Purchase**
2. **Generate API Key** → lade die `.p8` Datei herunter
3. Notiere `Key ID` und `Issuer ID`
4. Speichere die `.p8` Datei unter `secrets/apple_iap.p8`
5. In `.env` eintragen:
   ```
   APPLE_KEY_ID=XXXXXXXXXX
   APPLE_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   APPLE_PRIVATE_KEY_PATH=./secrets/apple_iap.p8
   APPLE_BUNDLE_ID=com.deinname.clearday
   APPLE_PRODUCT_ID=clearday_premium_monthly
   ```

### Schritt 3: Server Notifications (Webhook)
1. App Store Connect → deine App → **App Information**
2. **App Store Server Notifications** → URL eintragen:
   `https://dein-server.com/api/iap/apple/notifications`
3. Version 2 auswählen (empfohlen)

---

## Google Play Setup (Android)

### Schritt 1: Subscription erstellen
1. → [play.google.com/console](https://play.google.com/console)
2. **Monetize** → **Subscriptions** → **Create subscription**
3. Produkt-ID: `clearday_premium_monthly`
4. Preis: 4,99 € / Monat

### Schritt 2: Service Account
1. → **Setup** → **API access** → Google Cloud verknüpfen
2. **Service Account erstellen** → Rolle: **Financial data viewer** + **Orders manager**
3. JSON-Key herunterladen → speichern unter `secrets/google_play_service_account.json`
4. In `.env` eintragen:
   ```
   GOOGLE_SERVICE_ACCOUNT_PATH=./secrets/google_play_service_account.json
   GOOGLE_PACKAGE_NAME=com.deinname.clearday
   GOOGLE_PRODUCT_ID=clearday_premium_monthly
   ```

### Schritt 3: Real-Time Notifications
1. → **Monetization setup** → **Real-time developer notifications**
2. Google Cloud Pub/Sub Topic erstellen
3. Webhook URL: `https://dein-server.com/api/iap/google/notifications?token=DEIN_TOKEN`
4. `GOOGLE_PUBSUB_TOKEN` in `.env` setzen

---

## Deployment

### Railway (empfohlen — einfachste Option)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```
Dann in Railway Dashboard alle `.env` Variablen setzen.

### Render
1. GitHub Repo verbinden
2. Build command: `npm install && npm run db:migrate`
3. Start command: `npm start`
4. Disk hinzufügen für SQLite unter `/data`

### Wichtig für Production:
- `NODE_ENV=production` setzen
- `JWT_SECRET` mit mindestens 64 zufälligen Zeichen
- `secrets/` Ordner **niemals** in Git committen (`.gitignore`!)
- HTTPS erforderlich (Railway/Render machen das automatisch)

---

## Freemium Logik

| Feature | Kostenlos | Premium (4,99€/Mo) |
|---------|-----------|-------------------|
| Tracker | 1 | Unbegrenzt |
| Kalender | ✓ | ✓ |
| Badges | ✓ | ✓ |
| Designs | 2 | 7 + Custom |
| Datensync | ✗ | ✓ |

---

## Sicherheit

- ✅ API Key niemals im Client
- ✅ Alle IAP-Verifizierungen laufen server-seitig
- ✅ Apple/Google Webhooks werden idempotent verarbeitet
- ✅ JWT mit 365-Tage-Laufzeit (device-basiert)
- ✅ Rate Limiting auf allen Endpoints
- ✅ Helmet.js Security Headers
- ✅ Input-Validierung auf allen Routen
