import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { signFrame, readAck, b64, unb64, NUS_UUIDS } from '../app/frame';
import { BleClient } from '@capacitor-community/bluetooth-le';

export type Envelope = { version: 1; message_id: string; device_id: string; type: 'report' | 'beacon'; created_at: string; expires_at: string; zone_id: string; target: string; severity: number; action: string; text: string; frame_b64?: string; sequence?: number };
export type Delivery = { envelope: Envelope; state: 'queued' | 'node_received' | 'dashboard_received'; error?: string; packet_id?: string };
export type Settings = { server: string; zone: string; accessCode: string; service: string; tx: string; rx: string; wire: 'frame16' | 'json'; language: string };
export const defaults: Settings = { server: '', zone: '', accessCode: '', service: NUS_UUIDS.service, tx: NUS_UUIDS.rx, rx: NUS_UUIDS.tx, wire: 'frame16', language: 'en' };
export const native = Capacitor.isNativePlatform();
export const supportsBluetooth = native || ('bluetooth' in navigator && window.isSecureContext);
export function base(settings: Settings) { return settings.server.replace(/\/$/, ''); }
export async function readSaved<T>(key: string, fallback: T): Promise<T> { try { const r = await Preferences.get({ key: 'echohawk.' + key }); return r.value ? JSON.parse(r.value) : fallback; } catch { return fallback; } }
export async function save(key: string, value: unknown) { await Preferences.set({ key: 'echohawk.' + key, value: JSON.stringify(value) }); }
export async function request<T>(settings: Settings, path: string, data?: unknown, token?: string): Promise<T> {
  if (native && !settings.server) throw new Error('Set your dashboard address in Settings to connect. Offline reports can still be saved.');
  const r = await fetch(base(settings) + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const result = await r.json(); if (!r.ok) throw new Error(result.error || 'Connection unavailable'); return result;
}
export function normalizeZone(zone: string) {
  const z = zone.trim().toUpperCase();
  const m = /^Z?0?(\d{1,2})$/.exec(z);
  const demoDistricts: Record<string, string> = { '0801':'Z01','0802':'Z02','0803':'Z03','0804':'Z04','0811':'Z05','0812':'Z06','0813':'Z07','0814':'Z08','0821':'Z09','0822':'Z10','0823':'Z11','0824':'Z12','0831':'Z13','0832':'Z14','0833':'Z15','0834':'Z16' };
  if (demoDistricts[z.padStart(4, '0')]) return demoDistricts[z.padStart(4, '0')];
  return m && +m[1] >= 1 && +m[1] <= 16 ? 'Z' + m[1].padStart(2, '0') : /^\d{3,4}$/.test(z) ? z.padStart(4, '0') : z;
}
export async function envelope(device: string, zone: string, type: 'report' | 'beacon', text: string, target = 'person', wire: Settings['wire'] = 'json', language = 'en'): Promise<Envelope> {
  zone = normalizeZone(zone);
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(zone)) throw new Error('Set your district or zone in Settings first.');
  const now = Date.now();
  const message: Envelope = { version: 1, message_id: crypto.randomUUID(), device_id: device, type, zone_id: zone, target, severity: type === 'beacon' ? 5 : 2, action: type === 'beacon' ? 'welfare_check' : 'info_only', text: text.slice(0, 120), created_at: new Date(now).toISOString(), expires_at: new Date(now + (wire === 'frame16' ? 600000 : 86400000)).toISOString() };
  if (wire === 'frame16') {
    const radioZone = Number(zone.replace(/^Z/, ''));
    if (!Number.isInteger(radioZone) || radioZone < 1 || radioZone > 65535) throw new Error('This radio profile needs a numeric district or a demo zone such as Z06.');
    message.sequence = crypto.getRandomValues(new Uint16Array(1))[0];
    message.frame_b64 = b64(await signFrame({ type: type === 'beacon' ? 'sos' : 'checkin', zone: radioZone, target, severity: message.severity, action: message.action, language, sequence: message.sequence }));
  }
  return message;
}

// Foreground BLE adapter. iPhone uses Core Bluetooth through Capacitor; web support is detected.
// A GATT write alone is NOT delivery. Support the existing demo signed frame and an optional richer JSON adapter.
export class NodeRelay {
  deviceId?: string;
  private settings?: Settings;
  private buffer = '';
  private decoder = new TextDecoder();
  private serial: Promise<void> = Promise.resolve();
  private pending = new Map<string, Envelope>();
  constructor(private onReceipt: (id: string, state: 'node_received' | 'dashboard_received') => void, private onDisconnect: () => void) {}
  async connect(settings: Settings) {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (![settings.service, settings.tx, settings.rx].every(x => uuid.test(x))) throw new Error('Enter the node service and characteristic UUIDs in Settings.');
    if (!supportsBluetooth) throw new Error('Bluetooth requires the installed iPhone app on this device.');
    await this.disconnect();
    await BleClient.initialize();
    const device = await BleClient.requestDevice({ services: [settings.service] });
    await BleClient.connect(device.deviceId, () => { this.deviceId = undefined; this.onDisconnect(); });
    this.settings = { ...settings }; this.deviceId = device.deviceId; this.buffer = ''; this.decoder = new TextDecoder();
    try {
      await BleClient.startNotifications(device.deviceId, settings.service, settings.rx, value => {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (this.settings?.wire === 'frame16') {
          if (bytes.length !== 16 || bytes[0] !== 0x13) return;
          for (const message of this.pending.values()) {
            if (message.sequence === undefined || Date.parse(message.expires_at) <= Date.now()) continue;
            void readAck(bytes, message.sequence).then(ack => {
              if (ack && [1, 2, 3].includes(ack.stage)) this.onReceipt(message.message_id, ack.stage >= 2 ? 'dashboard_received' : 'node_received');
            });
          }
          return;
        }
        this.buffer += this.decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), { stream: true });
        if (this.buffer.length > 8192) { this.buffer = ''; return; }
        let end: number;
        while ((end = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          try { const receipt = JSON.parse(line); if (receipt.version === 1 && receipt.state === 'node_received' && typeof receipt.message_id === 'string') this.onReceipt(receipt.message_id, 'node_received'); } catch { /* incomplete/invalid receipt is never delivery */ }
        }
      });
    } catch (e) { await this.disconnect(); throw e; }
    return device.name || 'Nearby node';
  }
  send(message: Envelope) {
    // Serialize the complete envelope, not just individual GATT writes, to avoid interleaving messages.
    const job = this.serial.catch(() => {}).then(async () => {
      const id = this.deviceId, s = this.settings;
      if (!id || !s) throw new Error('Connect to a nearby node first.');
      if (Date.parse(message.expires_at) <= Date.now()) throw new Error('This report expired. Create a new report if help is still needed.');
      this.pending.set(message.message_id, message);
      if (s.wire === 'frame16') {
        if (!message.frame_b64) throw new Error('This queued report uses another radio profile. Reconnect the matching node.');
        const bytes = unb64(message.frame_b64);
        await BleClient.write(id, s.service, s.tx, new DataView(bytes.buffer));
        return;
      }
      const bytes = new TextEncoder().encode(JSON.stringify(message) + '\n');
      for (let offset = 0; offset < bytes.length; offset += 20) { const part = bytes.slice(offset, offset + 20); await BleClient.write(id, s.service, s.tx, new DataView(part.buffer)); }
    });
    this.serial = job; return job;
  }
  async disconnect() { const id = this.deviceId; this.deviceId = undefined; if (id) await BleClient.disconnect(id).catch(() => {}); }
}
