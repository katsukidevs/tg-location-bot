/**
 * Phase 1 – Telegram Live-Location Bot
 * Receives live location updates and writes every ping to Supabase
 * table: tg_bot_phase1_raw_locations
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

// ── Clients ────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY   // service role bypasses RLS
);

console.log("✅ Bot started – polling for updates…");

// ── Helpers ────────────────────────────────────────────────────────────────

/** Persist one location ping to Supabase */
async function savePing(msg, location) {
  const user = msg.from ?? {};

  const row = {
    telegram_user_id:     user.id,
    username:             user.username          ?? null,
    first_name:           user.first_name        ?? null,
    last_name:            user.last_name         ?? null,
    latitude:             location.latitude,
    longitude:            location.longitude,
    horizontal_accuracy:  location.horizontal_accuracy  ?? null,
    live_period:          location.live_period           ?? null,
    heading:              location.heading               ?? null,
    proximity_alert_radius: location.proximity_alert_radius ?? null,
    is_live:              location.live_period != null,   // static share → false
    message_id:           msg.message_id         ?? null,
    chat_id:              msg.chat?.id            ?? null,
  };

  const { error } = await supabase
    .from("tg_bot_phase1_raw_locations")
    .insert(row);

  if (error) {
    console.error("❌ Supabase insert error:", error.message);
  } else {
    console.log(
      `📍 Saved ping  user=${user.id}  ` +
      `lat=${location.latitude.toFixed(5)}  lon=${location.longitude.toFixed(5)}  ` +
      `acc=${location.horizontal_accuracy ?? "?"}m`
    );
  }
}

// ── Bot Handlers ───────────────────────────────────────────────────────────

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "👋 *Location Tracker – Phase 1*\n\n" +
    "Share your *Live Location* with this chat and every ping will be recorded.\n\n" +
    "• Tap the 📎 attachment icon\n" +
    "• Choose *Location*\n" +
    "• Select *Share Live Location* and pick a duration\n\n" +
    "That's it – I'll record every update automatically!",
    { parse_mode: "Markdown" }
  );
});

// /status – show row count for this user
bot.onText(/\/status/, async (msg) => {
  const userId = msg.from?.id;
  if (!userId) return;

  const { count, error } = await supabase
    .from("tg_bot_phase1_raw_locations")
    .select("*", { count: "exact", head: true })
    .eq("telegram_user_id", userId);

  if (error) {
    bot.sendMessage(msg.chat.id, "⚠️ Could not fetch status.");
    return;
  }

  bot.sendMessage(
    msg.chat.id,
    `📊 *Your location pings stored:* ${count ?? 0}`,
    { parse_mode: "Markdown" }
  );
});

// Incoming location (both static share and live updates)
bot.on("location", async (msg) => {
  await savePing(msg, msg.location);
});

// Edited message = live location update tick
bot.on("edited_message", async (msg) => {
  if (!msg.location) return;
  await savePing(msg, msg.location);
});

// Graceful shutdown
process.once("SIGINT",  () => { console.log("Shutting down…"); bot.stopPolling(); process.exit(0); });
process.once("SIGTERM", () => { console.log("Shutting down…"); bot.stopPolling(); process.exit(0); });
