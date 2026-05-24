# 🛰️ Telegram Location Bot – Phase 1

Records every live-location ping from Telegram users into Supabase.

## Files

```
tg-location-bot/
├── bot.js                  ← main bot logic
├── package.json
├── .env.example            ← copy → .env and fill in secrets
└── tg-location-bot.service ← systemd unit for auto-restart
```

## Supabase Table

`tg_bot_phase1_raw_locations` — already created in your `ping-collector` project.

| Column | Type | Notes |
|---|---|---|
| id | bigserial | PK |
| telegram_user_id | bigint | Telegram user numeric ID |
| username / first_name / last_name | text | nullable |
| latitude / longitude | float8 | |
| horizontal_accuracy | float4 | metres, nullable |
| live_period | int | seconds location stays live |
| heading | int | 1–360 degrees, nullable |
| proximity_alert_radius | int | metres, nullable |
| is_live | boolean | true = live share |
| message_id / chat_id | bigint | |
| received_at | timestamptz | default NOW() |

---

## Quick Start (local test)

```bash
# 1. Clone / copy the folder to your machine
cd tg-location-bot

# 2. Install dependencies
npm install

# 3. Create your .env
cp .env.example .env
# Edit .env – add TELEGRAM_BOT_TOKEN and SUPABASE_SERVICE_ROLE_KEY

# 4. Run
npm start
```

---

## Production Server Deployment (Ubuntu VPS)

### Step 1 – Provision a server
Any cheap VPS works (DigitalOcean $4/mo, Hetzner CX11, Railway, Render free tier, etc.).
You need Node 18+ and systemd.

```bash
# On a fresh Ubuntu 22.04 VPS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

### Step 2 – Upload bot files

```bash
# From your local machine
scp -r tg-location-bot ubuntu@YOUR_SERVER_IP:/home/ubuntu/
```

Or clone from your repo:
```bash
git clone https://github.com/YOUR_REPO/tg-location-bot.git
cd tg-location-bot
```

### Step 3 – Configure secrets

```bash
cp .env.example .env
nano .env        # fill in TELEGRAM_BOT_TOKEN and SUPABASE_SERVICE_ROLE_KEY
npm install
```

### Step 4 – Install as a systemd service

```bash
sudo cp tg-location-bot.service /etc/systemd/system/
# If your user isn't "ubuntu", edit the User= and WorkingDirectory= lines first

sudo systemctl daemon-reload
sudo systemctl enable tg-location-bot
sudo systemctl start  tg-location-bot

# Check it's running
sudo systemctl status tg-location-bot

# Live logs
sudo journalctl -u tg-location-bot -f
```

### Step 5 – Test

1. Open your bot in Telegram
2. Send `/start`
3. Share your Live Location for 15 minutes
4. Watch the console logs or check Supabase Table Editor

---

## Getting your Telegram Bot Token

1. Message `@BotFather` on Telegram
2. Send `/newbot`
3. Follow prompts → copy the token it gives you → paste into `.env`

## Getting your Supabase Service Role Key

1. Supabase Dashboard → Your project → Settings → API
2. Copy the `service_role` key (keep it secret – never commit to git!)
3. Paste into `.env`

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message + instructions |
| `/status` | How many pings are stored for this user |

---

## Next Phases

- **Phase 2** – Inactivity detection + nudge messages
- **Phase 3** – 3-tier aggregation pipeline (5min raw → speed calc → 15min summary)
