import express from "express";
import TelegramBot from "node-telegram-bot-api";

import { buffers } from "./buffer.js";
import { normalizeTelegramLocation } from "./telegram.js";
import { flushBuffers } from "./flush.js";

const app = express();

app.use(express.json());

const bot = new TelegramBot(process.env.BOT_TOKEN);

app.post("/webhook", async (req, res) => {
  const msg = req.body.message;

  if (!msg?.location) {
    return res.sendStatus(200);
  }

  const driverId = String(msg.from.id);

  if (!buffers[driverId]) {
    buffers[driverId] = [];
  }

  const normalized =
    normalizeTelegramLocation(msg);

  buffers[driverId].push(normalized);

  res.sendStatus(200);
});

setInterval(flushBuffers, 5 * 60 * 1000);

app.listen(process.env.PORT || 3000);
