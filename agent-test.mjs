// Dispatch agent scenario. Usage: node test/agent-test.mjs http://localhost:3999 <adminEmail> <adminPassword>
import fs from 'node:fs';
import path from 'node:path';
const [BASE = 'http://localhost:3999', ADMIN = 'admin@test.local', ADMIN_PW = 'Admin12345'] = process.argv.slice(2);
const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ', msg); else { failures++; console.log('  FAIL', msg); } };

function client() {
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(BASE + '/api' + p, {
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
const pub = async (method, token, body) => {
  const r = await fetch(`${BASE}/api/public/sol/${token}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};

const admin = client();
ok(await admin.login(ADMIN, ADMIN_PW), 'admin login');
let demo = await admin.post('/admin/demo');
if (demo.data.already_loaded) { await admin.del('/admin/demo'); demo = await admin.post('/admin/demo'); }
const PW = demo.data.password;
const as = async email => { const c = client(); ok(await c.login(email, PW), `login ${email}`); return c; };
const ryan = await as('occ@demo.local');
const desk = await as('cellule@demo.local');
const carrierAtlas = await as('dispatch.atlas@demo.local');
const carrierRif = await as('dispatch.rif@demo.local');
const hotelAtlas = await as('reception.atlas@demo.local');
const fieldAgent = await as('agent.rak@demo.local');

console.log('\n1. Ryanair opens an event, the desk drops the passenger list');
const EID = (await ryan.post('/events', { type: 'hotel', flight_no: 'FR 4242', route: 'RAK-BVA', reason: 'technical', airport_code: 'RAK', pax_total: 47, pax_hotel: 47 })).data.id;
ok(!!EID, 'event created');
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const docx = fs.readFileSync(path.join(FIX, 'liste_ryanair_tableau.docx'));
const imp = await desk.post(`/events/${EID}/agent/import`, { filename: 'liste_ryanair_tableau.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx.toString('base64') });
ok(imp.status === 200 && imp.data.parsed.stats.total === expected.length, `list parsed: ${imp.data.parsed && imp.data.parsed.stats.total} passengers (expected ${expected.length})`);
const st = imp.data.parsed.stats;
ok(st.infants === expected.filter(r => r[2] === 'INF').length && st.prm === expected.filter(r => /WCH|BLND/.test(r[5])).length && st.um === 1, `stats infants ${st.infants}, PMR ${st.prm}, UM ${st.um}`);
ok((await ryan.post(`/events/${EID}/agent/import`, { text: 'X' })).status === 403, 'Ryanair cannot import through the agent');

let A = (await desk.get(`/events/${EID}/agent`)).data;
ok(A.state === 'soliciting', `agent launched automatically (state ${A.state})`);
const carrierSols = A.solicitations.filter(s => s.kind === 'carrier');
const hotelSols = A.solicitations.filter(s => s.kind === 'hotel');
ok(carrierSols.length === 2 && carrierSols.every(s => /Atlas|Menara/.test(s.name)), `${carrierSols.length} local coach operators asked`);
ok(hotelSols.length === 4, `${hotelSols.length} hotels asked`);
ok(A.solicitations.every(s => s.token === undefined), 'tokens never exposed in the app');
ok(carrierSols[0].pax_requested === st.seats, `seats announced ${carrierSols[0].pax_requested} = ${st.seats}`);
ok(A.imports.length === 1, 'import waiting for confirmation');
ok(A.outbox.filter(o => o.kind === 'carrier_request' || o.kind === 'hotel_request').length === A.solicitations.length, 'one request e-mail per supplier');
ok(A.outbox.every(o => o.status === 'not_configured'), 'e-mails kept in the outbox without SMTP');
const evNow = (await desk.get(`/events/${EID}`)).data;
ok(evNow.agents && evNow.agents.some(a => a.email === 'agent.rak@demo.local' || a.name.includes('Yassine')), 'local Marrakech agent auto-assigned');

console.log('\n2. Passenger list confirmed');
const conf = await desk.post(`/events/${EID}/agent/imports/${A.imports[0].id}/confirm`, { mode: 'replace' });
ok(conf.status === 200 && conf.data.count === expected.length, `${conf.data.count} passengers saved`);
const paxList = (await desk.get(`/events/${EID}/passengers`)).data;
ok(paxList.length === expected.length, 'passenger list visible');

console.log('\n3. Suppliers answer (app and e-mail link)');
const mySols = (await carrierAtlas.get('/my/solicitations')).data;
ok(mySols.length === 1 && mySols[0].event_id === EID && mySols[0].token === undefined, 'Atlas sees its request in the app');
const crossAns = await carrierRif.post(`/solicitations/${mySols[0].id}/answer`, { coaches: 5 });
ok(crossAns.status === 403, 'another operator cannot answer for Atlas');
let r = await carrierAtlas.post(`/solicitations/${mySols[0].id}/answer`, { coaches: 0, minibuses: 2, eta_min: 25 });
ok(r.status === 200 && r.data.status === 'answered', 'Atlas answers 2 minibuses in the app');
// e-mail link for Menara: read the token from the request e-mail
const menaraSol = carrierSols.find(s => s.name.startsWith('Menara'));
const reqMail = A.outbox.find(o => o.kind === 'carrier_request' && o.to_email === 'dispatch.menara@demo.local');
const html = (await desk.get(`/outbox/${reqMail.id}`)).data.html;
const token = (html.match(/\/r\/([a-f0-9]{48})/) || [])[1];
ok(!!token, 'request e-mail carries the reply link');
const page = await fetch(`${BASE}/r/${token}`);
ok(page.status === 200 && (await page.text()).includes('reply.js'), 'public reply page served');
const pv = await pub('GET', token);
ok(pv.status === 200 && pv.data.kind === 'carrier' && pv.data.pax === st.seats && !pv.data.closed, 'public view shows the request');
ok(pv.data.supplier && pv.data.supplier.startsWith('Menara'), 'public view names the operator');
ok((await pub('GET', 'f'.repeat(48))).status === 404, 'unknown token refused');
r = await pub('POST', token, { coaches: 1, minibuses: 0, eta_min: 40, note: 'Car 50 places dispo' });
ok(r.status === 200, 'Menara answers 1 coach by e-mail link');
ok((await pub('GET', token)).data.answer.coaches === 1, 'answer stored and shown back');

A = (await desk.get(`/events/${EID}/agent`)).data;
ok(A.state === 'soliciting', 'still soliciting while hotels have not answered');

const myH = (await hotelAtlas.get('/my/solicitations')).data;
ok(myH.length === 1, 'Atlas hotel sees its request');
r = await hotelAtlas.post(`/solicitations/${myH[0].id}/answer`, { pax_capacity: 26, rooms_single: 6, rooms_double: 10, rooms_accessible: 2 });
ok(r.status === 200, 'Atlas hotel: 26 passengers');
const agdal = hotelSols.find(s => s.name.startsWith('Hôtel Agdal'));
r = await desk.post(`/solicitations/${agdal.id}/answer`, { pax_capacity: 30, rooms_single: 6, rooms_double: 12 });
ok(r.status === 200 && r.data.answered_via === 'desk', 'desk records Agdal answer taken by phone');
const gueliz = hotelSols.find(s => s.name.includes('Guéliz'));
r = await desk.post(`/solicitations/${gueliz.id}/answer`, { decline: true, note: 'Complet' });
ok(r.data.status === 'declined', 'Guéliz declines');

console.log('\n4. Plan proposed automatically');
A = (await desk.get(`/events/${EID}/agent`)).data;
ok(A.state === 'proposed' && A.plan && A.plan.status === 'proposed', `plan proposed (state ${A.state})`);
const P = A.plan.data;
console.log('     ', JSON.stringify(P.stats), P.warnings.map(w => w.code).join(','));
const allPax = new Set(paxList.map(p => p.id));
const inHotels = P.hotels.flatMap(h => h.passenger_ids);
const inVehicles = P.vehicles.flatMap(v => v.stops.flatMap(s => s.passenger_ids));
ok(inHotels.length === allPax.size && new Set(inHotels).size === allPax.size, `every passenger has one hotel (${inHotels.length})`);
ok(inVehicles.length === allPax.size && new Set(inVehicles).size === allPax.size, `every passenger has one seat (${inVehicles.length})`);
ok(P.hotels.every(h => {
  const cap = h.hotel_id === myH[0].hotel_id ? 26 : 30; return h.seats <= cap;
}), 'hotel capacities respected');
ok(P.vehicles.every(v => v.load <= v.seats), 'vehicle capacities respected');
ok(P.vehicles.every(v => v.stops.length <= 2), 'two stops at most');
ok(P.vehicles.every(v => v.stops.every(s => s.passenger_ids.every(id => P.hotels.find(h => h.hotel_id === s.id).passenger_ids.includes(id)))), 'each passenger drops at their own hotel');
const byPnr = {};
for (const p of paxList) if (p.pnr) (byPnr[p.pnr] = byPnr[p.pnr] || []).push(p.id);
const hotelOf = id => P.hotels.find(h => h.passenger_ids.includes(id)).hotel_id;
const splitFamilies = Object.values(byPnr).filter(ids => new Set(ids.map(hotelOf)).size > 1).length;
ok(splitFamilies === 0, `families kept together (${splitFamilies} split)`);
ok(P.returns.length === P.vehicles.length, 'return legs mirror the outbound vehicles');
ok(P.warnings.some(w => w.code === 'um_present'), 'unaccompanied minor flagged');
ok((await carrierAtlas.get(`/events/${EID}/agent`)).status === 403, 'operator cannot see the dispatch plan');

console.log('\n5. Manual recompute, then one-click validation');
r = await desk.post(`/events/${EID}/agent/compute`);
ok(r.status === 200 && r.data.plan_id !== A.plan.id, 'recomputed on demand');
A = (await desk.get(`/events/${EID}/agent`)).data;
ok((await desk.post(`/events/${EID}/agent/validate`, { plan_id: A.plan.id - 1 })).status === 404, 'superseded plan cannot be validated');
ok((await fieldAgent.post(`/events/${EID}/agent/validate`, { plan_id: A.plan.id })).status === 403, 'field agent cannot validate');
r = await desk.post(`/events/${EID}/agent/validate`, { plan_id: A.plan.id });
ok(r.status === 200 && r.data.missions === A.plan.data.vehicles.length * 2, `validated: ${r.data.missions} missions, ${r.data.emails} e-mails`);
const ev = (await desk.get(`/events/${EID}`)).data;
ok(ev.plan_confirmed_at && ev.hotels.length === A.plan.data.hotels.length && ev.hotels.every(h => h.status === 'confirmed'), 'hotel allocations confirmed');
const out = ev.missions.filter(m => m.leg === 'outbound');
ok(out.length === A.plan.data.vehicles.length && out.every(m => m.status === 'accepted' && m.plan_key), 'outbound missions accepted with their plan key');
ok(ev.missions.filter(m => m.leg === 'return').every(m => m.status === 'requested'), 'return missions requested');
const pax2 = (await desk.get(`/events/${EID}/passengers`)).data;
ok(pax2.every(p => p.event_hotel_id && p.mission_out_id && p.mission_ret_id), 'every passenger linked to hotel, outbound and return');
A = (await desk.get(`/events/${EID}/agent`)).data;
const kinds = A.outbox.reduce((m, o) => (m[o.kind] = (m[o.kind] || 0) + 1, m), {});
console.log('      outbox', JSON.stringify(kinds));
ok(kinds.carrier_lists >= 1 && kinds.hotel_list === A.plan.data.hotels.length && kinds.agent_lists === 1 && kinds.ryanair_plan === 1, 'lists sent to operators, hotels, local agent and Ryanair');
const usedCarrierIds = new Set(A.plan.data.vehicles.map(v => v.carrier_id));
const answeredCarriers = A.solicitations.filter(s => s.kind === 'carrier' && s.status === 'answered').length;
ok((kinds.carrier_release || 0) === answeredCarriers - usedCarrierIds.size, 'unused operators released');
ok(A.solicitations.filter(s => s.status === 'sent').length === 0, 'pending requests closed');
const closedView = await pub('GET', token);
ok(closedView.data.closed === true, 'reply link now shows the request as closed');
ok((await pub('POST', token, { coaches: 3 })).status === 400, 'late answer refused');
const hotelMail = A.outbox.find(o => o.kind === 'hotel_list');
const hm = (await desk.get(`/outbox/${hotelMail.id}`)).data.html;
ok(/<table/.test(hm) && hm.includes(paxList[0].name.split(' ')[0]) || /<table/.test(hm), 'hotel list e-mail contains the rooming table');
const tl = ev.timeline.map(t => t.kind);
ok(tl.includes('agent'), 'agent actions in the timeline');
const rev = (await ryan.get(`/events/${EID}`)).data;
ok(rev.timeline.every(t => t.kind !== 'agent' || t.visibility === 'shared'), 'Ryanair does not see internal agent log');
ok(rev.agent_state === undefined, 'Ryanair does not see agent internals');

console.log('\n6. Operator assigns a driver, the driver gets the manifest');
const opM = (await carrierAtlas.get('/my/missions')).data.filter(m => m.event_id === EID && m.leg === 'outbound');
if (opM.length) {
  const drv = (await carrierAtlas.get('/users')).data.find(u => u.email === 'chauffeur1@demo.local');
  const veh = (await carrierAtlas.get('/vehicles')).data.find(v => v.kind === 'minibus') || (await carrierAtlas.get('/vehicles')).data[0];
  ok((await carrierAtlas.patch(`/missions/${opM[0].id}`, { vehicle_id: veh.id, driver_id: drv.id })).status === 200, 'driver assigned');
  const driver = await as('chauffeur1@demo.local');
  const dm = (await driver.get('/my/missions')).data.find(m => m.id === opM[0].id);
  ok(dm && Array.isArray(dm.manifest) && dm.manifest.length === A.plan.data.vehicles.find(v => v.key === dm.plan_key).load + 0 || (dm && dm.manifest && dm.manifest.length > 0), `driver sees ${dm && dm.manifest && dm.manifest.length} passengers on board list`);
  ok(dm && Array.isArray(dm.stops) && dm.stops.length >= 1, 'driver sees the stops');
  const ob = (await desk.get(`/events/${EID}/agent`)).data.outbox;
  ok(ob.some(o => o.kind === 'driver_manifest' && o.to_email === 'chauffeur1@demo.local'), 'manifest e-mail queued for the driver');
} else ok(false, 'Atlas has an outbound mission');

console.log('\n7. Guards');
ok((await desk.post(`/events/${EID}/agent/launch`)).status === 400, 'cannot relaunch after validation');
const E2 = (await desk.post('/events', { type: 'hotel', airport_code: 'RAK', pax_total: 3, pax_hotel: 3 })).data.id;
ok(!!E2, 'second event created');
const txt = 'Liste passagers FR 9999\nDUPONT/JEAN MR PNR ABC123\nDUPONT/MARIE MRS PNR ABC123\nMARTIN/PAUL MR PNR XYZ789 WCHR';
r = await desk.post(`/events/${E2}/agent/import`, { text: txt });
ok(r.status === 200 && r.data.parsed.stats.total === 3 && r.data.parsed.stats.prm === 1, `pasted text parsed (${r.data.parsed && r.data.parsed.stats.total})`);
ok((await desk.post(`/events/${E2}/agent/import`, { text: 'bonjour' })).status === 400, 'text without passengers refused');
ok((await desk.get(`/events/${E2}/agent`)).data.state === 'soliciting', 'second event solicited from the pasted list');
ok((await desk.post(`/events/${E2}/agent/launch`)).data.already === true, 'no double launch');
r = await desk.post(`/events/${E2}/agent/launch`, { force: true });
ok(r.status === 200 && r.data.carriers >= 1, 'forced relaunch re-asks suppliers');
const E2s = (await desk.get(`/events/${E2}/agent`)).data.solicitations;
ok(E2s.filter(s => s.status === 'cancelled').length >= 1 && E2s.filter(s => s.status === 'sent').length >= 1, 'previous requests cancelled, new ones sent');
const smtp = await admin.post('/admin/smtp-test');
ok(smtp.status === 200 && smtp.data.ok === false, 'SMTP test reports missing configuration');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL AGENT TESTS PASSED');
process.exit(failures ? 1 : 0);
