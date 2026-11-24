'use strict';
const { canSeeEvent, isStaff } = require('./logic');

const clients = new Set();

function attach(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 4000\n\n');
  const client = { res, user: req.user };
  clients.add(client);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(client); });
}

function send(client, payload) {
  try { client.res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_) { clients.delete(client); }
}

// Notify every connected user allowed to see the event.
function eventChanged(eventId, extra = {}) {
  const payload = { scope: 'event', id: eventId, ...extra };
  for (const c of clients) {
    try { if (canSeeEvent(c.user, eventId)) send(c, payload); } catch (_) { /* ignore */ }
  }
}
function positionChanged(eventId, pos) {
  const payload = { scope: 'pos', event_id: eventId, ...pos };
  for (const c of clients) {
    try { if (canSeeEvent(c.user, eventId)) send(c, payload); } catch (_) { /* ignore */ }
  }
}
function refChanged(what) {
  for (const c of clients) if (isStaff(c.user) || c.user.role === 'carrier' || c.user.role === 'hotel') send(c, { scope: 'ref', what });
}
// Notify connected users matching a predicate (e.g. the staff of a coach operator or of a hotel)
function notify(predicate, payload) {
  for (const c of clients) { try { if (predicate(c.user)) send(c, payload); } catch (_) { /* ignore */ } }
}
function connectedCount() { return clients.size; }

module.exports = { attach, eventChanged, positionChanged, refChanged, connectedCount, notify };
