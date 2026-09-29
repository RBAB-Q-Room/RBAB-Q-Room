'use strict';
const { EventEmitter } = require('node:events');

// In-process pub/sub used to push changes to open browsers over SSE.
// The database stays the source of truth; events only say "this changed,
// re-read it". Swap for Redis/Postgres NOTIFY if the app ever scales out.
const bus = new EventEmitter();
bus.setMaxListeners(0);
module.exports = bus;
