// Radio drivers feed newline-delimited envelopes to stdin; receipts go back on stdout.
// Radio hardware/framing is intentionally external to this adapter.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { validateEnvelope } from '../../app/relay-protocol.js';

export function createGateway({ url, token, spool, fetchImpl = fetch }) {
  let queue = [];
  try { queue = JSON.parse(readFileSync(spool, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const persist = () => { mkdirSync(dirname(spool), { recursive: true }); writeFileSync(spool + '.tmp', JSON.stringify(queue), { mode: 0o600 }); renameSync(spool + '.tmp', spool); };
  let busy = false;
  return {
    pending: () => queue.length,
    accept(envelope) {
      const error = validateEnvelope(envelope); if (error) throw new Error(error);
      if (!queue.some(e => e.message_id === envelope.message_id)) { queue.push(envelope); persist(); }
      return { version: 1, state: 'gateway_received', message_id: envelope.message_id };
    },
    async flush(gatewayId, onReceipt = () => {}) {
      if (busy) return; busy = true;
      try {
        for (const envelope of [...queue]) {
          if (Date.parse(envelope.expires_at) <= Date.now()) { queue = queue.filter(e => e.message_id !== envelope.message_id); persist(); onReceipt({ version: 1, state: 'expired', message_id: envelope.message_id }); continue; }
          try {
            const response = await fetchImpl(url.replace(/\/$/, '') + '/relay/ingest', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ gateway_id: gatewayId, envelope }), signal: AbortSignal.timeout(10000) });
            if (!response.ok) continue;
            const receipt = await response.json();
            if (receipt.state !== 'dashboard_received' || receipt.message_id !== envelope.message_id) continue;
            // Keep it until the radio driver has accepted the receipt for forwarding.
            await onReceipt(receipt);
            queue = queue.filter(e => e.message_id !== envelope.message_id); persist();
          } catch { /* Durable spool retries when the dashboard connection recovers. */ }
        }
      } finally { busy = false; }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const token = process.env.RELAY_GATEWAY_TOKEN;
  if (!token) throw new Error('Set RELAY_GATEWAY_TOKEN on the gateway and dashboard server.');
  const gateway = createGateway({ url: process.env.ECHOHAWK_GATEWAY_URL || 'http://127.0.0.1:8787', token, spool: process.env.RELAY_SPOOL || 'data/relay-outbox.json' });
  const id = process.env.RELAY_GATEWAY_ID || 'local-gateway';
  const emit = receipt => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(receipt) + '\n', error => error ? reject(error) : resolve()));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => { if (line.length > 8192) return; try { const receipt = gateway.accept(JSON.parse(line)); void emit(receipt).then(() => gateway.flush(id, emit)).catch(() => {}); } catch (e) { process.stderr.write(e.message + '\n'); } });
  setInterval(() => void gateway.flush(id, emit), 15000);
  void gateway.flush(id, emit);
}
