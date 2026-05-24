import fetch from "node-fetch";
import { buffers } from "./buffer.js";

const SUPABASE_FUNCTION =
  process.env.SUPABASE_FUNCTION_URL;

export async function flushBuffers() {
  const users = Object.keys(buffers);

  for (const driverId of users) {
    const pings = buffers[driverId];

    if (!pings.length) continue;

    const payload = {
      driver_id: driverId,

      batch_started_at: pings[0].timestamp,
      batch_ended_at: pings[pings.length - 1].timestamp,

      pings
    };

    try {
      await fetch(SUPABASE_FUNCTION, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      buffers[driverId] = [];
    } catch (err) {
      console.error("Flush failed:", err);
    }
  }
}
