'use strict';
const path = require('node:path');

// Development-safe configuration. Everything overridable by environment
// variables; nothing secret is committed.
module.exports = {
  port: Number(process.env.PORT || 3000),
  dbFile: process.env.WG_DB_FILE || path.join(__dirname, '..', 'data', 'waiting-guest.db'),
  // Public base URL used inside QR codes. Falls back to the request host.
  publicBaseUrl: process.env.WG_PUBLIC_URL || '',
  // Waiting Guest number format: PREFIX-0001. Configurable, always unique.
  wgPrefix: process.env.WG_PREFIX || 'WG',
  wgPad: Number(process.env.WG_PAD || 4),
  sessionHours: Number(process.env.WG_SESSION_HOURS || 12),
  secureCookies: process.env.NODE_ENV === 'production',
  // Real hotel content. Left empty on purpose until supplied by the hotel.
  hotelWebsiteUrl: process.env.WG_HOTEL_WEBSITE || '',
};
