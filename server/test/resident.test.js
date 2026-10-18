import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.js';
import { Engine } from '../engine.js';
import { RetellHub } from '../retell_ws.js';
import { createHttpServer } from '../http.js';
import { showKitCard } from '../kits.js';
import { validateEnvelope, frameEnvelope } from '../../app/relay-protocol.js';
import { createGateway } from '../../device/relay/gateway.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function boot(t) {
  const store = new Store(), engine = new Engine(store), hub = new RetellHub({ store, engine });
  const server = createHttpServer({ store, engine, hub }); hub.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const s of hub.sessions.values()) s.ws.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, data, token) => {
    const res = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, data: await res.json() };
  };
  return { store, engine, hub, api };
}
test('resident demo uses the shared call and kit controls, with call-scoped access', async t => {
  const { api, store } = await boot(t);
  const a = (await api('/resident/calls', { mode: 'demo', line: 'emergency' })).data;
  const b = (await api('/resident/calls', { mode: 'demo', line: 'nonemergency' })).data;
  const path = '/resident/calls/' + a.call_id;
  assert.equal((await api(path)).status, 403);
  assert.equal((await api(path, undefined, b.resident_token)).status, 403);
  assert.ok((await api('/calls')).data.some(c => c.id === a.call_id && c.direction === 'web'));
  let snap = (await api(path + '/message', { text: 'Severe bleeding demo' }, a.resident_token)).data;
  assert.equal(snap.kit.kit_id, 'EH-BLEED-001');
  assert.equal((await api('/resident/calls/' + b.call_id, undefined, b.resident_token)).data.kit, null);
  assert.equal((await api('/calls/' + a.call_id + '/takeover', {}, 'dev-dispatcher')).status, 200);
  assert.equal((await api(path, undefined, a.resident_token)).data.dispatcher_connected, true);
  const agentCount = store.turns.filter(x => x.call_id === a.call_id && x.role === 'agent').length;
  await api(path + '/message', { text: 'I can hear you' }, a.resident_token);
  assert.equal(store.turns.filter(x => x.call_id === a.call_id && x.role === 'agent').length, agentCount, 'AI stays quiet after takeover');
  await api('/calls/' + a.call_id + '/say', { text: 'Keep talking to me.', lang_from: 'en' }, 'dev-dispatcher');
  assert.equal((await api(path, undefined, a.resident_token)).data.messages.at(-1).role, 'dispatcher');
  await api('/calls/' + a.call_id + '/kit', { kit_id: null }, 'dev-dispatcher');
  assert.equal((await api(path, undefined, a.resident_token)).data.kit, null);
  await api('/calls/' + a.call_id + '/kit', { kit_id: 'EH-BAG-001' }, 'dev-dispatcher');
  assert.equal((await api(path, undefined, a.resident_token)).data.kit.kit_id, 'EH-BAG-001');
  snap = (await api(path + '/end', {}, a.resident_token)).data;
  assert.equal(snap.status, 'ended');
  assert.equal((await api(path + '/message', { text: 'late' }, a.resident_token)).status, 409);
});
test('live resident calls cannot show pending medical kits or start without pilot configuration', async t => {
  const { api, store } = await boot(t);
  assert.equal((await api('/resident/calls', { mode: 'live', line: 'emergency', access_code: 'wrong' })).status, 403);
  store.calls.push({ id: 'live-resident', resident_demo: false });
  assert.equal(showKitCard({ kit_id: 'EH-BLEED-001', call_id: 'live-resident' }, store).status, 409);
  assert.equal(store.kitShows.length, 0);
});
const report = () => ({ version: 1, message_id: randomUUID(), device_id: 'app-test-123', type: 'beacon', zone_id: 'Z04', target: 'person', severity: 5, action: 'welfare_check', text: 'Check on me', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() });
test('internet and authenticated radio delivery produce one packet across retries', async t => {
  const { api, store } = await boot(t);
  const old = process.env.RELAY_GATEWAY_TOKEN; process.env.RELAY_GATEWAY_TOKEN = 'gateway-test';
  t.after(() => { if (old === undefined) delete process.env.RELAY_GATEWAY_TOKEN; else process.env.RELAY_GATEWAY_TOKEN = old; });
  const e = report();
  assert.equal((await api('/relay/ingest', { gateway_id: 'town-1', envelope: e })).status, 401);
  const first = await api('/relay/ingest', { gateway_id: 'town-1', envelope: e }, 'gateway-test');
  assert.equal(first.status, 201); assert.equal(first.data.state, 'dashboard_received');
  const retry = await api('/resident/reports', e);
  assert.equal(retry.status, 200); assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.packet_id, first.data.packet_id); assert.equal(store.packets.length, 1);
  assert.equal(store.packets[0].source, 'ehawk');
  assert.equal((await api('/resident/reports', { ...report(), expires_at: '2000-01-01' })).status, 400);
});
test('BLE envelope chunks round-trip UTF-8 and reject malformed or expired reports', () => {
  const e = { ...report(), text: 'Ayuda: el niño está aquí.' };
  const chunks = frameEnvelope(e); assert.ok(chunks.every(x => x.length <= 20));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)).trim()), e);
  assert.match(validateEnvelope({ ...e, severity: 9 }), /severity/);
  assert.match(validateEnvelope({ ...e, expires_at: 'bad' }), /timestamps/);
  assert.match(validateEnvelope({ ...e, zone_id: '123 Main Street' }), /zone/);
});
test('radio gateway keeps its spool across outage and restart, then forwards one receipt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'echohawk-gateway-')); t.after(() => rmSync(dir, { recursive: true }));
  const spool = join(dir, 'queue.json'); const e = report();
  const down = createGateway({ spool, token: 'test', url: 'http://dashboard', fetchImpl: async () => { throw new Error('offline'); } });
  down.accept(e); down.accept(e); assert.equal(down.pending(), 1);
  await down.flush('node-1'); assert.equal(down.pending(), 1);
  const up = createGateway({ spool, token: 'test', url: 'http://dashboard', fetchImpl: async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer test');
    assert.equal(JSON.parse(options.body).envelope.message_id, e.message_id);
    return { ok: true, json: async () => ({ message_id: e.message_id, state: 'dashboard_received' }) };
  } });
  const receipts = []; await up.flush('node-1', r => receipts.push(r));
  assert.equal(receipts.length, 1); assert.equal(up.pending(), 0);
});

test('resident reports keep backend triage and a beacon escalates to a person', async t => {
  const { api, store } = await boot(t);
  const normal = { ...report(), type: 'report', text: 'A cat is in a tree', action: 'info_only' };
  const received = await api('/resident/reports', normal);
  assert.equal(received.status, 201);
  assert.equal(store.packets[0].severity, 3);
  assert.equal(store.packets[0].reported_severity, 5);
  const beacon = await api('/resident/reports', report());
  const incident = store.incidents.find(i => i.id === beacon.data.incident_id);
  assert.equal(incident.rung, 'hand');
});

test('signed native frame and internet retries share one report in either arrival order', async t => {
  const { encodeFrame, toBase64 } = await import('../../device/frame.js');
  const { config } = await import('../config.js');
  const { api, store } = await boot(t);
  const make = sequence => {
    const e = report();
    return { ...e, sequence, frame_b64: toBase64(encodeFrame({ type: 'sos', zone: 4, target: e.target, severity: e.severity, action: e.action, language: 'en', sequence }, config.frameKey)) };
  };
  const first = make(301);
  const online = await api('/resident/reports', first);
  const radio = await api('/device/packets', { frame_b64: first.frame_b64, node_id: 'N-0812-A', channel: 'ble' });
  assert.equal(online.status, 201);
  assert.equal(radio.status, 200);
  assert.equal(radio.data.packet_id, online.data.packet_id);
  assert.ok(radio.data.ack_b64);
  const second = make(302);
  const radio2 = await api('/device/packets', { frame_b64: second.frame_b64, node_id: 'N-0812-B', channel: 'radio' });
  const online2 = await api('/resident/reports', second);
  assert.equal(online2.data.packet_id, radio2.data.packet_id);
  assert.equal(online2.data.duplicate, true);
  assert.equal(store.packets.length, 2);
  const bad = { ...make(303), target: 'water' };
  assert.equal((await api('/resident/reports', bad)).status, 400);
  const forged = { ...make(304), frame_b64: 'AAAAAAAAAAAAAAAAAAAAAA==' };
  assert.equal((await api('/resident/reports', forged)).status, 400);
});
