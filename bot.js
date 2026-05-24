/**
 * Telegram Location Bot — Phase 3 buffer logic
 *
 * Buffer rules:
 *  - Every ping is pushed into a per-user in-memory buffer
 *  - A scanner runs every 15s and looks for "complete" windows:
 *      a group of pings whose span covers ≥5 min AND whose newest
 *      ping is older than (now - HOLD_BACK_MS) — i.e. not the
 *      current live window
 *  - Complete windows are flushed to the Edge Function
 *  - The most-recent 5-min window is ALWAYS kept in buffer (safety net)
 *  - On silence > STALE_MS the last known position is frozen in memory
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

// ── Config ────────────────────────────────────────────────────────────────
const WINDOW_MS    = 5 * 60 * 1000;   // 5 minutes per tier-2 window
const HOLD_BACK_MS = 5 * 60 * 1000;   // always keep newest 5 min in buffer
const STALE_MS     = 5 * 60 * 1000;   // 5 min silence = disconnected
const SCAN_INTERVAL_MS = 15_000;      // scanner runs every 15s
const MIN_PINGS    = 2;               // minimum pings to form a flushable window

// ── Clients ───────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const EDGE_URL    = `${process.env.SUPABASE_URL}/functions/v1/process-batch`;
const BOT_SECRET  = process.env.BOT_SECRET;

console.log("✅ Bot started – polling for updates…");

// ── Per-user state ────────────────────────────────────────────────────────
// buffer:    Map<userId, Ping[]>
// lastSeen:  Map<userId, timestamp ms>
// lastGood:  Map<userId, { lat, lon, ts }> — last known position before stale
const buffer   = new Map();
const lastSeen = new Map();
const lastGood = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────

/** Haversine distance in metres */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Accuracy tag from median accuracy of a set of pings */
function accuracyTag(pings) {
  const values = pings
    .map((p) => p.accuracy)
    .filter((a) => a != null)
    .sort((a, b) => a - b);

  if (!values.length) return "red";
  if (values[values.length - 1] > 300) return "red";   // underground spike

  const median = values[Math.floor(values.length / 2)];
  if (median <= 10) return "green";
  if (median <= 30) return "yellow";
  return "red";
}

/** Save a single raw ping to Supabase Tier 1 */
async function savePing(msg, location) {
  const user = msg.from ?? {};
  const { error } = await supabase.from("tg_bot_phase1_raw_locations").insert({
    telegram_user_id:      user.id,
    username:              user.username            ?? null,
    first_name:            user.first_name          ?? null,
    last_name:             user.last_name           ?? null,
    latitude:              location.latitude,
    longitude:             location.longitude,
    horizontal_accuracy:   location.horizontal_accuracy  ?? null,
    live_period:           location.live_period           ?? null,
    heading:               location.heading               ?? null,
    proximity_alert_radius: location.proximity_alert_radius ?? null,
    is_live:               location.live_period != null,
    message_id:            msg.message_id           ?? null,
    chat_id:               msg.chat?.id             ?? null,
  });
  if (error) console.error("❌ Tier 1 insert error:", error.message);
}

/** Flush a completed window to the Edge Function */
async function flushWindow(userId, pings) {
  const windowStart = new Date(pings[0].ts).toISOString();
  const windowEnd   = new Date(pings[pings.length - 1].ts).toISOString();
  const tag         = accuracyTag(pings);

  console.log(
    `📤 Flushing window  user=${userId}  pings=${pings.length}  ` +
    `${windowStart.slice(11, 19)} → ${windowEnd.slice(11, 19)}  tag=${tag}`
  );

  try {
    const res = await fetch(EDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bot-secret": BOT_SECRET,
      },
      body: JSON.stringify({
        telegram_user_id: userId,
        pings: pings.map((p) => ({
          lat:      p.lat,
          lon:      p.lon,
          accuracy: p.accuracy,
          ts:       new Date(p.ts).toISOString(),
        })),
        window_start: windowStart,
        window_end:   windowEnd,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error(`❌ Edge Function error ${res.status}:`, data);
    } else {
      console.log(
        `✅ Window saved  tier3=${data.tier3}` +
        (data.permanent_id ? `  permanent_id=${data.permanent_id}` : "")
      );
    }
  } catch (err) {
    console.error("❌ Flush fetch error:", err.message);
  }
}

/** Scanner: runs every SCAN_INTERVAL_MS, flushes complete windows */
function runScanner() {
  const now = Date.now();

  for (const [userId, pings] of buffer.entries()) {
    if (!pings.length) continue;

    // Update last known good position before any trimming
    const latest = pings[pings.length - 1];
    lastGood.set(userId, { lat: latest.lat, lon: latest.lon, ts: latest.ts });

    // ── Check for stale (disconnected) user ──────────────────────────
    const silence = now - lastSeen.get(userId);
    if (silence > STALE_MS) {
      // Flush everything older than the hold-back window
      const cutoff = latest.ts - HOLD_BACK_MS;
      const toFlush = pings.filter((p) => p.ts <= cutoff);

      if (toFlush.length >= MIN_PINGS) {
        // Check it actually spans a meaningful time
        const span = toFlush[toFlush.length - 1].ts - toFlush[0].ts;
        if (span >= 60_000) {  // at least 1 min of data
          flushWindow(userId, toFlush);
          buffer.set(userId, pings.filter((p) => p.ts > cutoff));
        }
      }
      continue;
    }

    // ── Normal operation: flush completed 5-min windows ──────────────
    // Hold-back boundary: anything older than (now - HOLD_BACK_MS) is safe to flush
    const holdBackCutoff = now - HOLD_BACK_MS;

    // Find all pings older than the hold-back boundary
    const flushable = pings.filter((p) => p.ts <= holdBackCutoff);
    if (flushable.length < MIN_PINGS) continue;

    // Split flushable pings into 5-minute windows
    const windows = [];
    let windowStart = flushable[0].ts;
    let current = [];

    for (const ping of flushable) {
      if (ping.ts - windowStart >= WINDOW_MS && current.length >= MIN_PINGS) {
        windows.push(current);
        current = [ping];
        windowStart = ping.ts;
      } else {
        current.push(ping);
      }
    }
    // Don't flush the last partial group — it stays until it's complete

    for (const win of windows) {
      flushWindow(userId, win);
    }

    // Keep: pings from incomplete last group + hold-back window
    const flushedUpTo = windows.length
      ? windows[windows.length - 1].slice(-1)[0].ts
      : null;

    if (flushedUpTo !== null) {
      buffer.set(userId, pings.filter((p) => p.ts > flushedUpTo));
    }
  }
}

// ── Buffer a ping ─────────────────────────────────────────────────────────
function bufferPing(userId, location) {
  if (!buffer.has(userId)) buffer.set(userId, []);

  buffer.get(userId).push({
    lat:      location.latitude,
    lon:      location.longitude,
    accuracy: location.horizontal_accuracy ?? null,
    ts:       Date.now(),
  });

  lastSeen.set(userId, Date.now());
}

// ── Bot handlers ──────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "👋 *Location Tracker*\n\n" +
    "Share your *Live Location* and every ping will be recorded and processed.\n\n" +
    "• Tap 📎 → Location → *Share Live Location*\n\n" +
    "Commands: /status /buffer",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, async (msg) => {
  const userId = msg.from?.id;
  if (!userId) return;
  const { count } = await supabase
    .from("tg_bot_phase1_raw_locations")
    .select("*", { count: "exact", head: true })
    .eq("telegram_user_id", userId);
  bot.sendMessage(msg.chat.id, `📊 *Raw pings stored:* ${count ?? 0}`, { parse_mode: "Markdown" });
});

bot.onText(/\/buffer/, (msg) => {
  const userId = msg.from?.id;
  if (!userId) return;
  const pings    = buffer.get(userId) ?? [];
  const silence  = lastSeen.has(userId) ? Math.round((Date.now() - lastSeen.get(userId)) / 1000) : null;
  const good     = lastGood.get(userId);
  bot.sendMessage(
    msg.chat.id,
    `🗂 *Buffer status*\n` +
    `Buffered pings: ${pings.length}\n` +
    `Last ping: ${silence != null ? silence + "s ago" : "never"}\n` +
    `Last good pos: ${good ? `${good.lat.toFixed(5)}, ${good.lon.toFixed(5)}` : "none"}`,
    { parse_mode: "Markdown" }
  );
});

bot.on("location", async (msg) => {
  bufferPing(msg.from.id, msg.location);
  await savePing(msg, msg.location);
});

bot.on("edited_message", async (msg) => {
  if (!msg.location) return;
  bufferPing(msg.from.id, msg.location);
  await savePing(msg, msg.location);
});

// ── Start scanner ─────────────────────────────────────────────────────────
setInterval(runScanner, SCAN_INTERVAL_MS);

// ── Graceful shutdown ─────────────────────────────────────────────────────
process.once("SIGINT",  () => { bot.stopPolling(); process.exit(0); });
process.once("SIGTERM", () => { bot.stopPolling(); process.exit(0); });
