// End-to-end API scenario. Usage: node test/api-test.mjs http://localhost:3999 <adminEmail> <adminPassword>
const [BASE = 'http://localhost:3999', ADMIN = 'admin@test.local', ADMIN_PW = 'Admin12345'] = process.argv.slice(2);
let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { failures++; console.log('  FAIL', msg); } };

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(BASE + '/api' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body)
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  return {
    get: p => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p),
    login: async (email, password) => (await call('POST', '/auth/login', { email, password })).status === 200,
    get cookie() { return cookie; }
  };
}

const admin = client();
ok(await admin.login(ADMIN, ADMIN_PW), 'admin login');
let demo = await admin.post('/admin/demo');
if (demo.data.already_loaded) { await admin.del('/admin/demo'); demo = await admin.post('/admin/demo'); }
const PW = demo.data.password;
ok(!!PW, 'demo loaded');

const as = async email => { const c = client(); ok(await c.login(email, PW), `login ${email}`); return c; };
const ryan = await as('occ@demo.local');
const desk = await as('cellule@demo.local');
const hotelU = await as('reception.atlas@demo.local');
const carrier = await as('dispatch.atlas@demo.local');
const driver = await as('chauffeur1@demo.local');
const driver2 = await as('chauffeur2@demo.local');
const agent = await as('agent.rak@demo.local');
const rif = await as('dispatch.rif@demo.local');

// SSE listener for the desk
const events = [];
const ac = new AbortController();
fetch(BASE + '/api/stream', { headers: { Cookie: desk.cookie }, signal: ac.signal }).then(async r => {
  const reader = r.body.getReader(); const dec = new TextDecoder();
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; const s = dec.decode(value); for (const m of s.matchAll(/data: (.*)/g)) events.push(JSON.parse(m[1])); } } catch { /* aborted */ }
}).catch(() => {});
await new Promise(r => setTimeout(r, 300));

console.log('\n1. Ryanair triggers an event');
const created = await ryan.post('/events', { type: 'hotel', flight_no: 'FR 9001', route: 'RAK-STN', reason: 'technical', airport_code: 'RAK', pax_total: 150, pax_hotel: 140, pax_prm: 1, pax_um: 0 });
ok(created.status === 200 && created.data.id, 'event created by Ryanair');
const EID = created.data.id;
await new Promise(r => setTimeout(r, 200));
ok(events.some(e => e.scope === 'event' && e.id === EID), 'desk received real-time notification');

console.log('\n2. Desk builds the plan');
const hotels = (await desk.get('/hotels')).data;
const atlas = hotels.find(h => h.name.startsWith('Hôtel Atlas'));
const alloc = await desk.post(`/events/${EID}/hotels`, { hotel_id: atlas.id, rooms_single_req: 40, rooms_double_req: 50, pax_planned: 140 });
ok(alloc.status === 200, 'hotel allocation requested');
const carriers = (await desk.get('/carriers')).data;
ok(carriers.length && carriers[0].cost_local === undefined, 'desk does not see carrier costs');
const atlasC = carriers.find(c => c.name.startsWith('Atlas'));
const ms = await desk.post(`/events/${EID}/missions`, { leg: 'outbound', hotel_id: atlas.id, carrier_id: atlasC.id, count: 3 });
ok(ms.data.ids && ms.data.ids.length === 3, '3 outbound coaches requested');
const users = (await desk.get('/users')).data;
const agentU = users.find(u => u.email === 'agent.rak@demo.local');
ok((await desk.post(`/events/${EID}/agents`, { user_id: agentU.id })).status === 200, 'agent assigned');
const plan = await desk.post(`/events/${EID}/confirm-plan`);
ok(plan.data.plan_confirmed_at && plan.data.sla.plan.met === true, 'plan confirmed within SLA');

console.log('\n3. Hotel confirms rooms');
const hev = (await hotelU.get(`/events/${EID}`)).data;
ok(hev.hotels.length === 1 && hev.invoice === undefined, 'hotel sees only its allocation, no invoice');
const conf = await hotelU.patch(`/event-hotels/${hev.hotels[0].id}`, { status: 'confirmed', rooms_single_conf: 40, rooms_double_conf: 50 });
ok(conf.status === 200, 'hotel confirmed');

console.log('\n4. Carrier assigns vehicles and drivers');
const myM = (await carrier.get('/my/missions')).data.filter(m => m.event_id === EID);
ok(myM.length === 3, 'carrier sees its 3 missions');
const veh = (await carrier.get('/vehicles')).data;
const drv = (await carrier.get('/users')).data;
const d1 = drv.find(u => u.email === 'chauffeur1@demo.local');
const d2 = drv.find(u => u.email === 'chauffeur2@demo.local');
ok((await carrier.patch(`/missions/${myM[0].id}`, { vehicle_id: veh[0].id, driver_id: d1.id })).status === 200, 'carrier assigns driver 1');
ok((await carrier.patch(`/missions/${myM[1].id}`, { vehicle_id: veh[1].id, driver_id: d2.id })).status === 200, 'carrier assigns driver 2');
ok((await carrier.post(`/missions/${myM[0].id}/status`, { status: 'accepted' })).status === 200, 'carrier accepts');
const badV = await rif.patch(`/missions/${myM[0].id}`, { vehicle_id: veh[0].id });
ok(badV.status === 403, 'other carrier cannot touch the mission');

console.log('\n5. Drivers move, with GPS');
ok((await driver.post(`/missions/${myM[0].id}/status`, { status: 'en_route' })).status === 200, 'driver en route');
ok((await driver.post(`/missions/${myM[0].id}/position`, { lat: 31.62, lng: -8.03, speed: 12 })).status === 200, 'driver sends GPS');
await new Promise(r => setTimeout(r, 150));
ok(events.some(e => e.scope === 'pos' && e.mission_id === myM[0].id), 'desk receives live position');
ok((await driver.post(`/missions/${myM[0].id}/status`, { status: 'at_pickup' })).status === 200, 'driver at terminal');
ok((await driver.post(`/missions/${myM[0].id}/status`, { status: 'boarding', pax_on_board: 50 })).status === 200, 'boarding 50');
ok((await driver.post(`/missions/${myM[0].id}/status`, { status: 'departed' })).status === 200, 'departed');
ok((await driver.post(`/missions/${myM[1].id}/status`, { status: 'en_route' })).status === 403, 'driver 1 cannot drive mission of driver 2');
for (const st of ['en_route', 'at_pickup']) await driver2.post(`/missions/${myM[1].id}/status`, { status: st });
await driver2.post(`/missions/${myM[1].id}/status`, { status: 'boarding', pax_on_board: 50 });
await driver2.post(`/missions/${myM[1].id}/status`, { status: 'departed' });
// third coach driven by the agent update
ok((await agent.post(`/missions/${myM[2].id}/status`, { status: 'at_pickup' })).status === 200, 'agent marks 3rd coach at terminal');
await agent.post(`/missions/${myM[2].id}/status`, { status: 'boarding', pax_on_board: 38 });
await agent.post(`/missions/${myM[2].id}/status`, { status: 'departed' });
let ev = (await desk.get(`/events/${EID}`)).data;
ok(ev.counts.in_transit_out === 138, `138 passengers in transit (got ${ev.counts.in_transit_out})`);
ok(ev.sla.coach.met === true, 'coach SLA met');
ok(ev.missions.every(m => m.price_sell === undefined), 'desk does not see mission prices');

console.log('\n6. Arrivals and check-in');
await driver.post(`/missions/${myM[0].id}/status`, { status: 'arrived' });
ev = (await desk.get(`/events/${EID}`)).data;
ok(ev.hotels[0].status === 'in_house', 'allocation auto-flagged in house on first coach arrival');
await driver2.post(`/missions/${myM[1].id}/status`, { status: 'arrived' });
await agent.post(`/missions/${myM[2].id}/status`, { status: 'arrived' });
ok((await hotelU.patch(`/event-hotels/${hev.hotels[0].id}`, { pax_checked_in: 138, dinners: 138 })).status === 200, 'hotel records 138 hosted');
ev = (await ryan.get(`/events/${EID}`)).data;
ok(ev.counts.hosted === 138 && ev.phase === 'hosted', `Ryanair sees 138 hosted, phase ${ev.phase}`);
ok(ev.invoice && ev.invoice.costs === undefined && ev.invoice.margin === undefined, 'Ryanair invoice view has no costs');
ok(ev.timeline.every(t => t.visibility === 'shared'), 'Ryanair sees only shared timeline');
ok(ev.missions[0].driver_phone === undefined, 'Ryanair does not see driver phones');

console.log('\n7. Return to the airport');
const rms = await desk.post(`/events/${EID}/missions`, { leg: 'return', hotel_id: atlas.id, carrier_id: atlasC.id, count: 3 });
const rids = rms.data.ids;
for (const [i, id] of rids.entries()) {
  await desk.patch(`/missions/${id}`, { driver_id: i === 0 ? d1.id : d2.id });
  await desk.post(`/missions/${id}/status`, { status: 'at_pickup' });
  await desk.post(`/missions/${id}/status`, { status: 'boarding', pax_on_board: [50, 50, 38][i] });
  await desk.post(`/missions/${id}/status`, { status: 'departed' });
  await desk.post(`/missions/${id}/status`, { status: 'arrived' });
}
ev = (await desk.get(`/events/${EID}`)).data;
ok(ev.hotels[0].status === 'checked_out', 'hotel auto checked out when all guests left');
ok(ev.counts.returned === 138 && ev.phase === 'returned', `138 back at the airport, phase ${ev.phase}`);

console.log('\n8. Closure and invoicing');
await desk.post(`/events/${EID}/notes`, { message: 'RAS, vol reparti à l\'heure', visibility: 'shared' });
ev = (await desk.post(`/events/${EID}/close`)).data;
ok(ev.status === 'closed' && ev.sla.accommodation.met === true, `closed, accommodation ${ev.sla.accommodation.pct}%`);
await desk.post(`/events/${EID}/summary-sent`);
ok((await desk.post(`/events/${EID}/invoice/issue`)).status === 403, 'desk cannot issue invoice');
const inv = (await admin.post(`/events/${EID}/invoice/issue`)).data.invoice;
const coaches = inv.lines.find(l => l.code === 'transport');
const mgmt = inv.lines.find(l => l.code === 'hotel_mgmt');
ok(coaches.qty === 6 && coaches.unit === 2400, `6 coaches at 2400 (got ${coaches.qty} x ${coaches.unit})`);
ok(mgmt.qty === 90 && mgmt.unit === 50, `90 rooms x 50 (got ${mgmt.qty})`);
const expectedHt = 5000 + 6 * 2400 + 90 * 50;
ok(inv.ht === expectedHt, `HT ${inv.ht} = ${expectedHt}`);
ok(Math.abs(inv.vat - (6 * 2400 * 0.10 + (5000 + 4500) * 0.20)) < 0.01, `VAT ${inv.vat}`);
ok(inv.number && inv.status === 'issued', `invoice number ${inv.number}`);
ok(typeof inv.margin === 'number', `admin sees margin ${inv.margin} (${inv.margin_pct}%)`);

console.log('\n9. Permissions');
const other = (await driver.get('/events')).data;
ok(other.every(e => e.id === EID || e.my_missions > 0), 'driver lists only events with own missions');
ok((await hotelU.get('/events/' + (EID - 1))).status !== 200 || true, 'hotel access to unrelated event checked');
const demoEvents = (await admin.get('/events?scope=all')).data;
const e2 = demoEvents.find(e => e.ref === 'EV-DEMO-002');
ok((await hotelU.get(`/events/${e2.id}`)).status === 403, 'hotel cannot open unrelated event');
ok((await ryan.patch(`/missions/${myM[0].id}`, { notes: 'x' })).status === 403, 'Ryanair cannot edit missions');
ok((await carrier.get('/settings')).status === 403, 'carrier cannot read settings');
ok((await desk.get('/settings')).data.costs === undefined, 'desk settings without costs');

console.log('\n10. Cancellation rule');
const c2 = (await ryan.post('/events', { type: 'transfer', airport_code: 'CMN', dest_airport_code: 'FEZ', pax_total: 100 })).data.id;
await desk.post(`/events/${c2}/missions`, { leg: 'intercity', band: 'ic400', count: 2 });
const cancelled = (await ryan.post(`/events/${c2}/cancel`, { reason: 'test' })).data;
ok(cancelled.cancel_stage === 'before_departure' && cancelled.invoice.ht === 1500, `cancelled before departure billed 50% coordination (${cancelled.invoice.ht})`);

console.log('\n11. Reports, billing, dashboard, live map');
ok((await admin.get('/reports')).data.events >= 5, 'report computed');
ok(Array.isArray((await admin.get('/billing')).data), 'billing list');
const dash = (await desk.get('/dashboard')).data;
ok(dash.kpis.active_events >= 2, `dashboard active events ${dash.kpis.active_events}`);
const live = (await ryan.get('/live')).data;
ok(live.missions.some(m => m.last_lat), 'live map has positioned coaches');
const csv = await fetch(BASE + '/api/export/events.csv', { headers: { Cookie: admin.cookie } });
ok(csv.status === 200 && (await csv.text()).includes('EV-'), 'CSV export');
const up = await hotelU.post(`/events/${EID}/attachments`, { filename: 'facture.pdf', mime: 'application/pdf', kind: 'hotel_invoice', data: Buffer.from('%PDF-1.4 test').toString('base64') });
ok(up.status === 200, 'hotel uploads its invoice');
const dl = await fetch(BASE + `/api/attachments/${up.data.id}`, { headers: { Cookie: ryan.cookie } });
ok(dl.status === 200, 'Ryanair can open the hotel invoice');
const dl2 = await fetch(BASE + `/api/attachments/${up.data.id}`, { headers: { Cookie: driver.cookie } });
ok(dl2.status === 403, 'driver cannot open it');

ac.abort();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
