/**
 * Telegram Location Bot
 *
 * Responsibilities (dumb pipe, fast, reliable):
 *  1. Receive every Telegram location webhook
 *  2. Buffer pings in RAM per driver, tagged with GeoJSON + accuracy
 *  3. Every 15s: flush complete 5-min windows to raw_batches
 *  4. Always hold back the most recent 5 min (safety net on disconnect)
 *
 *  Raw pings are NOT written to Supabase individually — batches only.
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const WINDOW_MS    = 5 * 60 * 1000;
const HOLD_BACK_MS = 5 * 60 * 1000;
const STALE_MS     = 5 * 60 * 1000;
const SCAN_MS      = 15_000;
const MIN_PINGS    = 2;

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("✅ Bot started – polling for updates…");

const buffer     = new Map();
const lastSeen   = new Map();
const driverMeta = new Map();

function pingAccTag(accuracy) {
  if (accuracy == null || accuracy > 300) return "red";
  if (accuracy <= 10) return "green";
  if (accuracy <= 30) return "yellow";
  return "red";
}

function toGeoJSON(lat, lon) {
  return { type: "Point", coordinates: [lon, lat] };
}

async function flushWindow(driverId, pings) {
  if (pings.length < MIN_PINGS) return;

  const meta  = driverMeta.get(driverId) ?? {};
  const start = new Date(pings[0].ts).toISOString();
  const end   = new Date(pings[pings.length - 1].ts).toISOString();

  const structuredPings = pings.map((p, i) => ({
    seq:      i + 1,
    ts:       new Date(p.ts).toISOString(),
    point:    toGeoJSON(p.lat, p.lon),
    accuracy: p.accuracy,
    heading:  p.heading ?? null,
    acc_tag:  p.acc_tag,
  }));

  console.log(`📤 Flushing  driver=${driverId}  pings=${pings.length}  ${start.slice(11,19)} → ${end.slice(11,19)}`);

  const { error } = await supabase.from("raw_batches").insert({
    driver_id:        driverId,
    username:         meta.username ?? null,
    batch_started_at: start,
    batch_ended_at:   end,
    ping_count:       pings.length,
    pings:            structuredPings,
  });

  if (error) console.error("❌ Batch insert error:", error.message);
  else console.log(`✅ Batch saved  driver=${driverId}  ${start.slice(11,19)} → ${end.slice(11,19)}`);
}

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

function runScanner() {
  const now = Date.now();
  for (const [driverId, pings] of buffer.entries()) {
    if (!pings.length) continue;
    const silence        = now - (lastSeen.get(driverId) ?? now);
    const holdBackCutoff = now - HOLD_BACK_MS;
    const isStale        = silence > STALE_MS;

    if (isStale) {
      if (pings.length >= MIN_PINGS) flushWindow(driverId, [...pings]);
      buffer.set(driverId, []);
      continue;
    }

    const flushable = pings.filter(p => p.ts <= holdBackCutoff);
    if (flushable.length < MIN_PINGS) continue;

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
    if (!windows.length) continue;
    for (const win of windows) flushWindow(driverId, win);
    const lastFlushedTs = windows[windows.length - 1].slice(-1)[0].ts;
    buffer.set(driverId, pings.filter(p => p.ts > lastFlushedTs));
  }
}

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id,
    "👋 *Location Tracker*\n\nShare your *Live Location* and every ping will be recorded.\n\nTap 📎 → Location → *Share Live Location*\n\nCommands: /status /buffer",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, async msg => {
  const id = msg.from?.id;
  if (!id) return;
  const { count } = await supabase.from("raw_batches").select("*", { count: "exact", head: true }).eq("driver_id", id);
  bot.sendMessage(msg.chat.id, `📊 *Status*\nBatches flushed: ${count ?? 0}`, { parse_mode: "Markdown" });
});

bot.onText(/\/buffer/, msg => {
  const id = msg.from?.id;
  if (!id) return;
  const pings   = buffer.get(id) ?? [];
  const silence = lastSeen.has(id) ? Math.round((Date.now() - lastSeen.get(id)) / 1000) + "s ago" : "never";
  const span    = pings.length >= 2 ? Math.round((pings[pings.length-1].ts - pings[0].ts) / 1000) + "s" : "—";
  const tags    = pings.reduce((a, p) => { a[p.acc_tag] = (a[p.acc_tag]||0)+1; return a; }, {});
  bot.sendMessage(msg.chat.id,
    `🗂 *Buffer*\nPings buffered: ${pings.length}\nSpan: ${span}\nLast ping: ${silence}\nTags: 🟢${tags.green||0} 🟡${tags.yellow||0} 🔴${tags.red||0}`,
    { parse_mode: "Markdown" }
  );
});

// Buffer only — no Supabase write per ping
bot.on("location",       msg => { bufferPing(msg.from.id, msg.location, msg.from); });
bot.on("edited_message", msg => { if (!msg.location) return; bufferPing(msg.from.id, msg.location, msg.from); });

process.once("SIGINT",  () => { bot.stopPolling(); process.exit(0); });
process.once("SIGTERM", () => { bot.stopPolling(); process.exit(0); });

setInterval(runScanner, SCAN_MS);
