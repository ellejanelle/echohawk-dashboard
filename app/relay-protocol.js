// EchoHawk relay contract v1. Shared by the phone, gateway and contract tests.
export function validateEnvelope(e, now = Date.now()) {
  if (!e || e.version !== 1) return 'Unsupported envelope version';
  if (!/^[a-f0-9-]{36}$/i.test(e.message_id || '')) return 'Invalid message_id';
  if (!/^[a-z0-9_-]{8,80}$/i.test(e.device_id || '')) return 'Invalid device_id';
  if (!['report', 'beacon'].includes(e.type)) return 'Invalid message type';
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(e.zone_id || '')) return 'Set a district or zone first';
  if (!['unknown','power','water','gas','power_line','structure_fire','wildfire','road','flood','person','vehicle'].includes(e.target)) return 'Invalid target';
  if (!['unknown','dispatch_ems','dispatch_fire','dispatch_police','welfare_check','info_only','deflect_311','shelter_in_place','evacuate','all_clear'].includes(e.action)) return 'Invalid action';
  if (!Number.isInteger(e.severity) || e.severity < 1 || e.severity > 5) return 'Invalid severity';
  if (typeof e.text !== 'string' || e.text.length > 120) return 'Message must be 120 characters or fewer';
  if (e.frame_b64 !== undefined && (typeof e.frame_b64 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(e.frame_b64))) return 'Invalid radio frame';
  const created = Date.parse(e.created_at), expires = Date.parse(e.expires_at);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created > now + 300000 || expires <= now || expires <= created || expires - created > 86400000) return 'Message expired or timestamps invalid';
  return null;
}
// BLE GATT streams a newline-terminated UTF-8 envelope in conservative 20-byte writes.
export function frameEnvelope(e) {
  const error = validateEnvelope(e); if (error) throw new Error(error);
  const bytes = new TextEncoder().encode(JSON.stringify(e) + '\n');
  return Array.from({ length: Math.ceil(bytes.length / 20) }, (_, i) => bytes.slice(i * 20, i * 20 + 20));
}
