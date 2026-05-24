export function normalizeTelegramLocation(msg) {
  const loc = msg.location;

  return {
    timestamp: new Date().toISOString(),

    latitude: loc.latitude,
    longitude: loc.longitude,

    accuracy: loc.horizontal_accuracy || null,
    heading: loc.heading || null
  };
}
