/**
 * Telegram Location Bot
 *
 * Responsibilities (dumb pipe, fast, reliable):
 *  1. Receive every Telegram location webhook
 *  2. Write raw ping to tg_bot_phase1_raw_locations immediately
 *  3. Buffer pings in memory per driver, tagged with GeoJSON + accuracy
 *  4. Every 15s: flush complete 5-min windows to raw_batches as structured GeoJSON batches
 *  5. Always hold back the most recent 5 min (safety net on disconnect)
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

// ── Config ────────────────────────────────────────────────────────────────
const WINDOW_MS    = 5 * 60 * 1000;  // 5-min window
const HOLD_BACK_MS = 5 * 60 * 1000;  // always keep newest 5 min in buffer
const STALE_MS     = 5 * 60 * 1000;  // silence → treat as disconnected
const SCAN_MS      = 15_000;         // scanner interval
const MIN_PINGS    = 2;              // minimum pings to form a flushable window

// ── Clients ───────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("✅ Bot started – polling for updates…");

// ── Per-user state ────────────────────────────────────────────────────────
const buffer   = new Map(); // Map<driverId, Ping[]>
const lastSeen = new Map(); // Map<driverId, ms>
const driverMeta = new Map(); // Map<driverId, {username, first_name, last_name}>

// ── Helpers ───────────────────────────────────────────────────────────────

/** Tag a single ping's accuracy */
function pingAccTag(accuracy) {
  if (accuracy == null)  return "red";
  if (accuracy > 300)    return "red";   // underground / no signal spike
  if (accuracy <= 10)    return "green";
  if (accuracy <= 30)    return "yellow";
  return "red";
}

/** Convert lat/lon to a GeoJSON Point object (industry standard) */
function toGeoJSON(lat, lon) {
  return {
    type: "Point",
    coordinates: [lon, lat],  // GeoJSON is [longitude, latitude]
  };
}

// ── Save raw ping to Tier 1 ───────────────────────────────────────────────
async function saveRawPing(msg, location) {
  const user = msg.from ?? {};
  const { error } = await supabase
    .from("tg_bot_phase1_raw_locations")
    .insert({
      telegram_user_id:       user.id,
      username:               user.username              ?? null,
      first_name:             user.first_name            ?? null,
      last_name:              user.last_name             ?? null,
      latitude:               location.latitude,
      longitude:              location.longitude,
      horizontal_accuracy:    location.horizontal_accuracy   ?? null,
      live_period:            location.live_period            ?? null,
      heading:                location.heading                ?? null,
      proximity_alert_radius: location.proximity_alert_radius ?? null,
      is_live:                location.live_period != null,
      message_id:             msg.message_id             ?? null,
      chat_id:                msg.chat?.id               ?? null,
    });
  if (error) console.error("❌ Raw ping insert error:", error.message);
}

// ── Flush a complete window to Supabase ───────────────────────────────────
async function flushWindow(driverId, pings) {
  if (pings.length < MIN_PINGS) return;

  const meta  = driverMeta.get(driverId) ?? {};
  const start = new Date(pings[0].ts).toISOString();
  const end   = new Date(pings[pings.length - 1].ts).toISOString();

  // Build structured batch — GeoJSON pings, sequenced, tagged
  const structuredPings = pings.map((p, i) => ({
    seq:      i + 1,
    ts:       new Date(p.ts).toISOString(),
    point:    toGeoJSON(p.lat, p.lon),
    accuracy: p.accuracy,
    heading:  p.heading ?? null,
    acc_tag:  p.acc_tag,
  }));

  console.log(
    `📤 Flushing  driver=${driverId}  pings=${pings.length}  ` +
    `${start.slice(11, 19)} → ${end.slice(11, 19)}`
  );

  const { error } = await supabase.from("raw_batches").insert({
    driver_id:        driverId,
    username:         meta.username   ?? null,
    batch_started_at: start,
    batch_ended_at:   end,
    ping_count:       pings.length,
    pings:            structuredPings,
  });

  if (error) {
    console.error("❌ Batch insert error:", error.message);
  } else {
    console.log(`✅ Batch saved  driver=${driverId}  ${start.slice(11,19)} → ${end.slice(11,19)}`);
  }
}

// ── Buffer a ping ─────────────────────────────────────────────────────────
function bufferPing(driverId, location, from) {
  if (!buffer.has(driverId)) buffer.set(driverId, []);

  buffer.get(driverId).push({
    lat:      location.latitude,
    lon:      location.longitude,
    accuracy: location.horizontal_accuracy ?? null,
    heading:  location.heading             ?? null,
    acc_tag:  pingAccTag(location.horizontal_accuracy),
    ts:       Date.now(),
  });

  lastSeen.set(driverId, Date.now());

  if (from && !driverMeta.has(driverId)) {
    driverMeta.set(driverId, {
      username:   from.username   ?? null,
      first_name: from.first_name ?? null,
      last_name:  from.last_name  ?? null,
    });
  }
}

// ── Scanner: runs every 15s ───────────────────────────────────────────────
function runScanner() {
  const now = Date.now();

  for (const [driverId, pings] of buffer.entries()) {
    if (!pings.length) continue;

    const silence        = now - (lastSeen.get(driverId) ?? now);
    const holdBackCutoff = now - HOLD_BACK_MS;
    const isStale        = silence > STALE_MS;

    if (isStale) {
      // Driver went offline — flush everything we have and clear buffer
      if (pings.length >= MIN_PINGS) {
        flushWindow(driverId, [...pings]);
      }
      buffer.set(driverId, []);
      continue;
    }

    // Normal: find all pings older than hold-back boundary
    const flushable = pings.filter(p => p.ts <= holdBackCutoff);
    if (flushable.length < MIN_PINGS) continue;

    // Split into complete 5-min windows
    const windows = [];
    let winStart = flushable[0].ts;
    let current  = [];

    for (const ping of flushable) {
      if (ping.ts - winStart >= WINDOW_MS && current.length >= MIN_PINGS) {
        windows.push(current);
        current  = [ping];
        winStart = ping.ts;
      } else {
        current.push(ping);
      }
    }
    // 'current' = last incomplete group, stays in buffer

    if (!windows.length) continue;

    for (const win of windows) flushWindow(driverId, win);

    // Keep everything after the last flushed ping
    const lastFlushedTs = windows[windows.length - 1].slice(-1)[0].ts;
    buffer.set(driverId, pings.filter(p => p.ts > lastFlushedTs));
  }
}

// ── Bot handlers ──────────────────────────────────────────────────────────
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    "👋 *Location Tracker*\n\n" +
    "Share your *Live Location* and every ping will be recorded.\n\n" +
    "Tap 📎 → Location → *Share Live Location*\n\n" +
    "Commands: /status /buffer",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, async msg => {
  const id = msg.from?.id;
  if (!id) return;
  const { count: rawCount }   = await supabase.from("tg_bot_phase1_raw_locations").select("*", { count: "exact", head: true }).eq("telegram_user_id", id);
  const { count: batchCount } = await supabase.from("raw_batches").select("*", { count: "exact", head: true }).eq("driver_id", id);
  bot.sendMessage(msg.chat.id,
    `📊 *Status*\nRaw pings stored: ${rawCount ?? 0}\nBatches flushed: ${batchCount ?? 0}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/buffer/, msg => {
  const id = msg.from?.id;
  if (!id) return;
  const pings   = buffer.get(id) ?? [];
  const silence = lastSeen.has(id) ? Math.round((Date.now() - lastSeen.get(id)) / 1000) + "s ago" : "never";
  const span    = pings.length >= 2 ? Math.round((pings[pings.length-1].ts - pings[0].ts) / 1000) + "s" : "—";
  const tags    = pings.reduce((a, p) => { a[p.acc_tag] = (a[p.acc_tag]||0)+1; return a; }, {});
  bot.sendMessage(msg.chat.id,
    `🗂 *Buffer*\n` +
    `Pings buffered: ${pings.length}\n` +
    `Span: ${span}\n` +
    `Last ping: ${silence}\n` +
    `Tags: 🟢${tags.green||0} 🟡${tags.yellow||0} 🔴${tags.red||0}`,
    { parse_mode: "Markdown" }
  );
});

bot.on("location",       async msg => { bufferPing(msg.from.id, msg.location, msg.from); await saveRawPing(msg, msg.location); });
bot.on("edited_message", async msg => { if (!msg.location) return; bufferPing(msg.from.id, msg.location, msg.from); await saveRawPing(msg, msg.location); });

process.once("SIGINT",  () => { bot.stopPolling(); process.exit(0); });
process.once("SIGTERM", () => { bot.stopPolling(); process.exit(0); });

setInterval(runScanner, SCAN_MS);
