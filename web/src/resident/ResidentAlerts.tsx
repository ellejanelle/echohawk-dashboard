import { useEffect, useState } from 'react';
import { normalizeZone, readSaved, request, save, type Settings } from './transport';
import { speak } from '../app/frame';

type Alert = { id: string; label: string; agency: string; text: string; language: string; kind: string; machine_translated: boolean };
// Automatic foreground reception, using the same agency broadcasts as the existing app.
export function ResidentAlerts({ settings, deviceId }: { settings: Settings; deviceId: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let disposed = false;
    const zone = normalizeZone(settings.zone);
    setAlerts([]); setReplies({}); setError('');
    if (!zone) return;
    const key = `alerts:${settings.server}:${zone}:${settings.language}`;
    let refreshed = false;
    void readSaved<Alert[]>(key, []).then(cached => { if (!disposed && !refreshed) { setAlerts(cached); setStale(true); } });
    const pull = async () => {
      try {
        const list = await request<Alert[]>(settings, `/broadcasts/active?zone=${encodeURIComponent(zone)}&lang=${encodeURIComponent(settings.language)}`);
        if (disposed) return;
        refreshed = true; setAlerts(list); setStale(false); await save(key, list);
      } catch { if (!disposed) setStale(true); }
    };
    void pull(); const timer = setInterval(() => void pull(), 8000);
    return () => { disposed = true; clearInterval(timer); };
  }, [settings.server, settings.zone, settings.language]);
  async function reply(id: string, status: string) {
    setBusy(id); setError('');
    try {
      await request(settings, `/broadcasts/${id}/ack`, { status, zone: normalizeZone(settings.zone), device: deviceId, lang: settings.language });
      setReplies(r => ({ ...r, [id]: status === 'need_help' ? 'Help request received by dashboard.' : status === 'left' ? 'Your update was received.' : 'Your safe check-in was received.' }));
    } catch { setError('Your reply was not received. Please retry when connected.'); }
    finally { setBusy(''); }
  }
  if (!alerts.length) return null;
  return <section className="resident-alerts" aria-label="Alerts for your area" aria-live="polite">
    {stale && <p className="fine-print">Last saved alerts · unable to check for updates.</p>}
    {alerts.map(a => <article className="resident-alert" key={a.id}>
      <p className="eyebrow">{a.label}</p><strong>{a.agency}</strong><p>{a.text}</p>
      {a.machine_translated && <small>Automatically translated</small>}
      <div className="alert-actions"><button onClick={() => speak(a.text, a.language)}>Read aloud</button>
        {!['advisory', 'all_clear'].includes(a.kind) && (replies[a.id] ? <p>{replies[a.id]}</p> : <>
          <button disabled={!!busy} onClick={() => void reply(a.id, 'safe')}>I'm safe</button>
          <button disabled={!!busy} onClick={() => void reply(a.id, 'left')}>I've left</button>
          <button disabled={!!busy} onClick={() => void reply(a.id, 'need_help')}>I need help</button>
        </>)}
      </div>
    </article>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
