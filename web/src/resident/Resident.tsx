import { useEffect, useRef, useState } from 'react';
import { ResidentAlerts } from './ResidentAlerts';
import { LANGUAGES } from '../shared/languages';
import type { WebCallSession } from 'retell-client-js-sdk';
import { deliverRequest } from '../../../app/delivery.js';
import { NodeRelay, SoundRelay, defaults, envelope, native, readSaved, request, save, supportsBluetooth, type Delivery, type Settings } from './transport';

type Kit = { kit_id: string; title: string; show_id?: string; medical_review: string; display_steps: string[]; authority: string; reference_url: string };
type CallKey = { call_id: string; resident_token: string; demo: boolean; receipt?: { message_id: string; state: string; packet_id?: string } };
type Call = { id: string; status: 'connecting' | 'connected' | 'ended'; started_at: string; demo: boolean; dispatcher_connected: boolean; kit: Kit | null; messages: { id: string; role: string; text: string }[] };
type View = 'home' | 'call' | 'kits' | 'beacon' | 'settings' | 'report';
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Please try again.';
const deliveryLabel = { queued: 'Saved on this phone', node_received: 'Received by a nearby node', dashboard_received: 'Received by the dashboard' };
function Icon({ name, size = 28 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    phone: <path d="M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-5-2-2 2a13 13 0 0 1-7-7l2-2-2-5Z" />,
    kit: <><rect x="3" y="6" width="18" height="15" rx="3"/><path d="M8 6V3h8v3M12 10v7m-3-3.5h6"/></>,
    beacon: <><circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M3 3a13 13 0 0 0 0 18M21 3a13 13 0 0 1 0 18"/></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></>,
    audio: <><path d="M3 9h4l5-5v16l-5-5H3ZM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    back: <path d="m14 5-7 7 7 7"/>,
    end: <path d="M3 17v-5c5-5 13-5 18 0v5h-5v-4a13 13 0 0 0-8 0v4Z"/>,
    check: <path d="m5 12 4 4L19 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.phone}</svg>;
}
export function Resident() {
  const [view, setView] = useState<View>('home');
  const [settings, setSettings] = useState<Settings>(defaults);
  const [ready, setReady] = useState(false);
  const [demo, setDemo] = useState(true);
  const [liveAvailable, setLiveAvailable] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [callKey, setCallKey] = useState<CallKey | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [audioLive, setAudioLive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [updatesLost, setUpdatesLost] = useState(false);
  const [hiddenKit, setHiddenKit] = useState<string | null>(null);
  const [libraryKit, setLibraryKit] = useState<Kit | null>(null);
  const [kits, setKits] = useState<Kit[]>([]);
  const [message, setMessage] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [outbox, setOutbox] = useState<Delivery[]>([]);
  const [nodeName, setNodeName] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [reportText, setReportText] = useState('');
  const [reportTarget, setReportTarget] = useState('water');
  const voice = useRef<WebCallSession | null>(null);
  const device = useRef('');
  const queue = useRef<Delivery[]>([]);
  const flushing = useRef(false);
  const storageJobs = useRef<Promise<void>>(Promise.resolve());
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const persistQueue = (update: (rows: Delivery[]) => Delivery[]) => {
    const job = storageJobs.current.catch(() => {}).then(async () => {
      const rows = update(queue.current);
      await save('outbox', rows);
      queue.current = rows; setOutbox(rows);
    });
    storageJobs.current = job; return job;
  };
  const recordReceipt = (id: string, state: Delivery['state'], packetId?: string) => persistQueue(rows => rows.map(r => r.envelope.message_id === id && r.state !== 'dashboard_received' ? { ...r, state, packet_id: packetId || r.packet_id, error: undefined } : r));
  const onLocalReceipt = (id: string, state: 'node_received' | 'dashboard_received') => { void recordReceipt(id, state).catch(() => setNotice('Could not save the node receipt.')); };
  const relay = useRef<NodeRelay | null>(null);
  const sound = useRef<SoundRelay | null>(null);
  if (!relay.current) relay.current = new NodeRelay(onLocalReceipt, () => setNodeName(''));
  if (!sound.current) sound.current = new SoundRelay(onLocalReceipt);
  useEffect(() => () => { sound.current?.disconnect(); void relay.current?.disconnect(); }, []);


  useEffect(() => {
    void (async () => {
      const [stored, rows, savedId, cached] = await Promise.all([readSaved('settings', defaults), readSaved<Delivery[]>('outbox', []), readSaved('device', ''), readSaved<Kit[]>('kits', [])]);
      setSettings({ ...defaults, ...stored, accessCode: '' }); queue.current = rows; setOutbox(rows); setKits(cached);
      if (native && !cached.length) fetch('/kit-catalog.json').then(r => r.json()).then(r => setKits(r.kits)).catch(() => {});
      if (!native && 'serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
      device.current = savedId || 'app-' + crypto.randomUUID(); await save('device', device.current); setReady(true);
    })().catch(() => { setReady(true); setNotice('Device storage is unavailable. Reports cannot be queued safely.'); });
    const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    request<{ live_available: boolean }>(settings, '/resident/config').then(r => { if (!disposed) setLiveAvailable(r.live_available); }).catch(() => { if (!disposed) setLiveAvailable(false); });
    request<{ kits: Kit[] }>(settings, '/kits').then(r => { if (!disposed) { setKits(r.kits); void save('kits', r.kits); } }).catch(() => {});
    return () => { disposed = true; };
  }, [ready, settings.server, online]);
  useEffect(() => {
    if (!callKey) return;
    let disposed = false;
    const refresh = async () => { try { const r = await request<Call>(settingsRef.current, '/resident/calls/' + callKey.call_id, undefined, callKey.resident_token); if (!disposed) { setCall(!r.demo && voice.current?.status === 'ended' ? { ...r, status: 'ended' } : r); setUpdatesLost(false); } } catch { if (!disposed) setUpdatesLost(true); } };
    void refresh(); const timer = setInterval(refresh, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [callKey]);
  useEffect(() => {
    const tick = () => setSeconds(call?.started_at ? Math.max(0, Math.floor((Date.now() - Date.parse(call.started_at)) / 1000)) : 0);
    tick(); if (call?.status === 'ended') return;
    const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [call?.started_at, call?.status]);

  async function flush() {
    if (flushing.current) return; flushing.current = true;
    try {
      for (const row of [...queue.current]) {
        if (row.state === 'dashboard_received') continue;
        if (Date.parse(row.envelope.expires_at) <= Date.now()) { await persistQueue(rows => rows.map(x => x.envelope.message_id === row.envelope.message_id ? { ...x, error: 'Expired. Create a new report if help is still needed.' } : x)); continue; }
        const state = () => queue.current.find(x => x.envelope.message_id === row.envelope.message_id)?.state || 'queued';
        try {
          await deliverRequest(row.envelope, {
            internet: message => navigator.onLine ? request(settingsRef.current, '/resident/reports', message) : Promise.reject(new Error('Offline')),
            received: receipt => recordReceipt(receipt.message_id, 'dashboard_received', receipt.packet_id),
            state,
            bluetooth: relay.current?.deviceId ? message => relay.current!.send(message) : undefined,
            waitForReceipt: async () => { const until = Date.now() + 3000; while (state() === 'queued' && Date.now() < until) await new Promise(r => setTimeout(r, 100)); },
            sound: sound.current?.enabled ? message => sound.current!.send(message) : undefined,
          });
        } catch (e) { setNotice(errorText(e)); }

      }
    } finally { flushing.current = false; }
  }
  useEffect(() => { if (!ready) return; void flush(); const timer = setInterval(() => void flush(), 15000); return () => clearInterval(timer); }, [ready, online, settings.server]);

  async function startCall(line: 'emergency' | 'nonemergency') {
    if (busy || (call && call.status !== 'ended')) { setView('call'); return; }
    setNotice(''); setBusy(true); setCall(null); setHiddenKit(null); setLibraryKit(null); setMuted(false); setAudioLive(false); setView('call');
    let help: Delivery['envelope'] | undefined;
    try {
      if (line === 'emergency') {
        help = await envelope(device.current, settings.zone, 'beacon', 'Emergency help requested from the app', 'person', demo ? settings.wire : 'json', settings.language);
        await persistQueue(rows => [...rows, { envelope: help!, state: 'queued' }]);
        void flush();
      }
      if (demo) {
        const key = await request<CallKey>(settings, '/resident/calls', { mode: 'demo', line, request: help }); setCallKey(key);
        if (key.receipt?.state === 'dashboard_received') await recordReceipt(key.receipt.message_id, 'dashboard_received', key.receipt.packet_id);
      } else {
        sound.current?.disconnect(); setSoundEnabled(false);
        const { RetellClient } = await import('retell-client-js-sdk');
        const client = new RetellClient({ key: 'server-proxy', fetch: async (url) => {
          if (!String(url).endsWith('/v3/create-web-call')) throw new Error('This operation is not available from the resident app.');
          const result = await request<CallKey & Record<string, unknown>>(settings, '/resident/calls', { mode: 'live', line, access_code: settings.accessCode, request: help });
          if (result.receipt?.state === 'dashboard_received') await recordReceipt(result.receipt.message_id, 'dashboard_received', result.receipt.packet_id);
          setCallKey({ call_id: result.call_id, resident_token: result.resident_token, demo: false, receipt: result.receipt });
          return new Response(JSON.stringify(result), { status: 201, headers: { 'content-type': 'application/json' } });
        } });
        const session = client.createWebCall({ agent_id: 'server-selected', hooks: {
          onStatus: status => { setAudioLive(status === 'live'); if (status === 'ended') setCall(c => c ? { ...c, status: 'ended' } : c); },
          onError: e => setNotice(e.message || 'The voice connection failed. Please retry.'),
          onEnd: () => { setAudioLive(false); setMuted(false); setCall(c => c ? { ...c, status: 'ended' } : c); },
        } }); voice.current = session; await session.ready;
      }
    } catch (e) { setNotice(errorText(e) + (help ? ' Your request is saved; check its delivery status below.' : '')); setView(help ? 'beacon' : 'home'); if (help) void flush(); }
    finally { setBusy(false); }
  }
  async function endCall() {
    if (!callKey || busy) return; setBusy(true);
    try { if (!callKey.demo) await voice.current?.end(); else await request(settings, '/resident/calls/' + callKey.call_id + '/end', {}, callKey.resident_token); setCall(c => c ? { ...c, status: 'ended', kit: null } : c); setHiddenKit(call?.kit?.show_id || null); setCallKey(null); setAudioLive(false); }
    catch (e) { setNotice(errorText(e)); } finally { setBusy(false); }
  }
  async function sendMessage(text = message) {
    if (!callKey || !text.trim() || busy) return; setBusy(true);
    try { setCall(await request<Call>(settings, '/resident/calls/' + callKey.call_id + '/message', { text }, callKey.resident_token)); setMessage(''); }
    catch (e) { setNotice(errorText(e)); } finally { setBusy(false); }
  }
  async function queueReport(type: 'report' | 'beacon') {
    setBusy(true); setNotice('');
    try { if (!demo && settings.wire === 'frame16') throw new Error('The signed-frame profile is for demo hardware. A deployment key and node setup are required for live use.'); const msg = await envelope(device.current, settings.zone, type, type === 'beacon' ? 'I need someone to check on me.' : reportText, type === 'beacon' ? 'person' : reportTarget, settings.wire, settings.language); await persistQueue(rows => [...rows, { envelope: msg, state: 'queued' }]); setReportText(''); setView('beacon'); void flush(); }
    catch (e) { setNotice(errorText(e)); } finally { setBusy(false); }
  }
  async function connectNode() {
    setBusy(true); setNotice('');
    try { setNodeName(await relay.current!.connect(settings)); void flush(); }
    catch (e) { setNotice(errorText(e)); } finally { setBusy(false); }
  }
  async function enableSound() {
    setBusy(true); setNotice('');
    try { await sound.current!.connect(); setSoundEnabled(true); void flush(); }
    catch (e) { setNotice(errorText(e)); } finally { setBusy(false); }
  }
  async function saveSettings(e: React.FormEvent) {
    e.preventDefault(); setNotice('');
    if (settings.server && !/^https:\/\/[^\s]+$/.test(settings.server)) { setNotice('Use an HTTPS dashboard address.'); return; }
    try { await save('settings', { ...settings, accessCode: '' }); setView('home'); } catch (err) { setNotice(errorText(err)); }
  }
  const connected = !!call && call.status !== 'ended';
  const visibleKit = view === 'call' && connected && call?.kit?.show_id !== hiddenKit ? call?.kit : libraryKit;
  const bleeding = visibleKit?.kit_id === 'EH-BLEED-001';
  const duration = Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + (seconds % 60).toString().padStart(2, '0');
  const who = call?.dispatcher_connected ? 'Dispatcher' : 'AI assistant';
  const networkLabel = !online ? 'Offline · trying available relay routes' : 'Online';
  const changeView = (v: View) => { setLibraryKit(null); setNotice(''); setView(v); };

  useEffect(() => { window.scrollTo({ top: 0 }); }, [view, call?.kit?.show_id, hiddenKit, libraryKit?.kit_id]);

  return <div className="resident-shell">
    <header className="resident-header"><button className="wordmark" onClick={() => changeView('home')} aria-label="EchoHawk home">Echo<span>Hawk</span></button>
      {visibleKit ? <div className="close-kit"><button onClick={() => { setHiddenKit(call?.kit?.show_id || null); setLibraryKit(null); }}><Icon name="close" size={20}/>Close kit</button><small>{connected ? 'Call stays connected' : 'Back to kits'}</small></div> : <button className="subtle" onClick={() => changeView(view === 'settings' ? 'home' : 'settings')}>{view === 'settings' ? 'Close' : 'Settings'}</button>}
    </header>
    <div className="pilot-strip">{demo ? 'Demo · no emergency services contacted' : 'Pilot voice line · not a 911 connection'}</div>
    {notice && <div className="notice" role="alert">{notice}<button aria-label="Dismiss message" onClick={() => setNotice('')}><Icon name="close" size={20}/></button></div>}
    {connected && view !== 'call' && <button className="return-call" onClick={() => changeView('call')}><span className="status-dot"/>{call?.demo ? 'Demo call' : 'Call'} with {who.toLowerCase()}<span>Return →</span></button>}
    {ready && <ResidentAlerts settings={settings} deviceId={device.current}/>}
    <main className={view === 'call' ? 'call-main' : ''}>
      {visibleKit ? <article className="kit-view"><p className="eyebrow">{bleeding ? 'SEVERE BLEEDING' : visibleKit.title}</p><h1>{bleeding ? <>Press firmly.<br/>Keep pressing.</> : visibleKit.title}</h1>
        {bleeding ? <><p className="kit-lead">Place a cloth over the wound and press down firmly.</p><img className="pressure-photo" src="/app/media/bleeding-pressure-prototype.png" alt="Demonstration of two hands applying pressure through gauze over a supported forearm"/><p className="pressure-reminder">Keep steady pressure on the wound.</p></> : <ol className="kit-steps">{visibleKit.display_steps.map(step => <li key={step}>{step}</li>)}</ol>}
        <details className="source"><summary>{visibleKit.medical_review === 'pending' ? 'Prototype · pending medical review' : 'Source and details'}</summary><p>{visibleKit.authority}</p><a href={visibleKit.reference_url} target="_blank" rel="noreferrer">Read source</a>{bleeding && <p>Generated demonstration image. Content and image need clinical approval before live use.</p>}</details>
      </article> : <>
        {view === 'home' && <section className="home"><div className="connection"><span className={'status-dot ' + (!online ? 'amber' : '')}/>{networkLabel}</div><h1>How can we<br/>help you?</h1><p className="intro">Choose what you need.</p><div className="home-tiles">
          <button className="tile blue" disabled={!ready || busy} onClick={() => startCall('nonemergency')}><Icon name="phone" size={36}/><strong>NONEMERGENCY<br/>HELP</strong><span>Talk to an assistant</span></button>
          <button className="tile red" disabled={!ready || busy} onClick={() => startCall('emergency')}><Icon name="phone" size={36}/><strong>EMERGENCY<br/>HELP</strong><span>{demo ? 'Try a demo call' : 'Reach the pilot line'}</span></button>
          <button className="tile teal" onClick={() => changeView('kits')}><Icon name="kit" size={36}/><strong>KITS FOR<br/>INFO</strong><span>Helpful instructions</span></button>
          <button className="tile purple" onClick={() => changeView('beacon')}><Icon name="beacon" size={36}/><strong>BEACON</strong><span>Send a request for help</span></button>
        </div><div className="home-bottom"><span>{settings.zone ? 'Zone ' + settings.zone : 'Location not set · help requests still send'}</span><button className="text-button" onClick={() => changeView('report')}>Send a report →</button></div>{(!native || settings.server) && <a className="dashboard-link" href={(settings.server || '') + '/app/standard'} target={native ? '_blank' : undefined} rel="noreferrer">Standard mode · more options →</a>}<a className="dashboard-link" href={(settings.server || '') + '/console'} target="_blank" rel="noreferrer">Open dispatcher dashboard ↗</a></section>}
        {view === 'call' && <section className="call-view">
          <p className="eyebrow">{call?.status === 'ended' ? 'CALL FINISHED' : call?.demo ? 'CONNECTED DEMO' : 'ECHOHAWK CALL'}</p><div className="call-avatar"><Icon name={call?.dispatcher_connected ? 'phone' : 'beacon'} size={48}/></div><h1>{call?.status === 'ended' ? 'Call ended' : who}</h1><p className="call-caption">{busy && !call ? 'Starting your call…' : call?.status === 'ended' ? 'Your call has finished.' : call?.demo ? 'Demo messages appear in the dispatcher dashboard.' : audioLive ? 'You can keep talking.' : 'Connecting audio…'}</p>
          {connected && callKey?.receipt?.state === "dashboard_received" && <p className="fine-print">Emergency request received by the dashboard.</p>}
          {connected && <p className="elapsed">{duration}</p>}
          {connected && call?.kit && <button className="primary" onClick={() => setHiddenKit(null)}><Icon name="kit"/>Reopen instructions</button>}
          {call?.messages.length ? <div className="call-transcript" aria-live="polite">{call.messages.slice(-3).map(m => <div key={m.id}><small>{m.role === 'user' ? 'You' : m.role === 'dispatcher' ? 'Dispatcher' : 'AI assistant'}</small><p>{m.text}</p></div>)}</div> : null}
          {connected && call?.demo && <form className="demo-composer" onSubmit={e => { e.preventDefault(); void sendMessage(); }}><label htmlFor="demo-message">Type as the caller</label><div><input id="demo-message" value={message} onChange={e => setMessage(e.target.value)} placeholder="Tell the assistant what happened"/><button className="primary" disabled={busy || !message.trim()}>Send</button></div><button type="button" className="text-button" disabled={busy} onClick={() => sendMessage('This is a demo of someone with severe bleeding.')}>Try the bleeding kit →</button></form>}
          {!connected && !busy && <button className="primary" onClick={() => changeView('home')}>Back to home</button>}
        </section>}
        {view === 'kits' && <section><button className="back" onClick={() => changeView('home')}><Icon name="back" size={20}/>Home</button><h1>Kits for info</h1><p className="intro">Instructions you can open again.</p><div className="kit-list">{kits.filter(k => demo || k.medical_review !== 'pending').map(k => <button key={k.kit_id} onClick={() => setLibraryKit(k)}><Icon name="kit"/><span><strong>{k.kit_id === 'EH-BLEED-001' ? 'Severe bleeding' : k.title}</strong><small>{k.medical_review === 'pending' ? 'Demo preview · medical review pending' : 'General information'}</small></span><span>→</span></button>)}</div>{!kits.length && <p>Open while connected once to save the kit catalog.</p>}</section>}
        {view === 'beacon' && <section><button className="back" onClick={() => changeView('home')}><Icon name="back" size={20}/>Home</button><p className="eyebrow purple-text">BEACON</p><h1>Another way<br/>to reach help.</h1><p className="intro">We try the internet first, then a connected Bluetooth node, then sound if enabled.</p><div className="relay-route"><span>Bluetooth / sound</span><b>→</b><span>Node</span><b>→</b><span>Radio</span><b>→</b><span>Dashboard</span></div><button className="primary purple" disabled={!ready || busy} onClick={() => queueReport('beacon')}><Icon name="beacon"/>Send a help request</button><p className="fine-print">A delivery receipt does not mean responders have been dispatched.</p><div className="node-card"><strong>{nodeName ? 'Connected to ' + nodeName : 'Nearby Bluetooth node'}</strong><p>{supportsBluetooth ? 'Connect to a configured EchoHawk node to relay queued messages.' : 'Use the installed iPhone app for Bluetooth. This browser can queue reports.'}</p><button disabled={busy || !supportsBluetooth} onClick={connectNode}>{nodeName ? 'Choose another node' : 'Connect to a node'}</button></div>
          <div className="node-card"><strong>{soundEnabled ? 'Sound fallback is listening' : 'Sound to a nearby node'}</strong><p>Uses your speaker to send a short signal and your microphone to hear a receipt. Keep the app open and sound on. A compatible node must be nearby.</p>{soundEnabled ? <button onClick={() => { sound.current?.disconnect(); setSoundEnabled(false); }}>Stop sound fallback</button> : <button disabled={busy || !demo || settings.wire !== 'frame16' || (!!call && !call.demo && call.status !== 'ended')} onClick={enableSound}>Enable sound fallback</button>}<p className="fine-print">Demo hardware profile. A node receipt confirms pickup; a dashboard receipt confirms delivery. Voice audio is not sent through the radio.</p></div>
          <div className="section-title"><h2>Your requests</h2><button className="text-button" onClick={() => void flush()}>Retry delivery</button></div>{!outbox.length && <p className="muted">No requests yet.</p>}<div className="delivery-list">{[...outbox].reverse().map(row => <article key={row.envelope.message_id}><span className={'delivery-state ' + row.state}>{deliveryLabel[row.state]}</span><p>{row.envelope.text || row.envelope.target}</p><small>{new Date(row.envelope.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {row.envelope.zone_id === 'unknown' ? 'Location not set' : 'Zone ' + row.envelope.zone_id}</small>{row.state === 'node_received' && <p className="fine-print">Waiting for dashboard confirmation. Keep the request saved.</p>}{row.error && <p className="error-text">{row.error}</p>}</article>)}</div></section>}
        {view === 'report' && <section><button className="back" onClick={() => changeView('home')}><Icon name="back" size={20}/>Home</button><h1>Send a report</h1><p className="intro">Your report goes to the same dashboard as calls. If disconnected, it stays queued.</p><form onSubmit={e => { e.preventDefault(); void queueReport('report'); }}><label htmlFor="target">What do you see?</label><select id="target" value={reportTarget} onChange={e => setReportTarget(e.target.value)}><option value="water">Water problem</option><option value="power">Power outage</option><option value="road">Road blocked</option><option value="person">Someone needs help</option><option value="unknown">Something else</option></select><label htmlFor="report-text">A short description</label><textarea id="report-text" required maxLength={120} value={reportText} onChange={e => setReportText(e.target.value)} placeholder="What is happening nearby?"/><button className="primary" disabled={!ready || busy}>Send report</button></form></section>}
        {view === 'settings' && <section><h1>Settings</h1><form onSubmit={saveSettings}><label htmlFor="zone">Your district or zone</label><input id="zone" value={settings.zone} onChange={e => setSettings(s => ({ ...s, zone: e.target.value.trim().toUpperCase() }))} placeholder="For example, Z04"/><label htmlFor="language">Alert language</label><select id="language" value={settings.language} onChange={e => setSettings(s => ({ ...s, language: e.target.value }))}>{LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.native}</option>)}</select><label htmlFor="server">Dashboard address</label><input id="server" disabled={connected} type="url" value={settings.server} onChange={e => setSettings(s => ({ ...s, server: e.target.value }))} placeholder={native ? 'https://your-dashboard.example' : 'Use this server (leave blank)'}/><p className="fine-print">The installed iPhone app needs the HTTPS address of your EchoHawk server.</p><label className="check-row"><input type="checkbox" checked={demo} disabled={connected} onChange={e => setDemo(e.target.checked)}/>Demo calls</label>{!demo && <><p>{liveAvailable ? 'Pilot voice service is configured.' : 'Live calls need server setup. Demo calls work without a voice account.'}</p><label htmlFor="code">Pilot access code</label><input id="code" type="password" autoComplete="off" value={settings.accessCode} onChange={e => setSettings(s => ({ ...s, accessCode: e.target.value }))}/><p className="fine-print">Kept only for this app session.</p></>}<details className="node-settings"><summary>Bluetooth node configuration</summary><p>Match the town receiver firmware. The personal eHawk tag is a sender, not a receiver for this app.</p><label htmlFor="wire">Message format</label><select id="wire" value={settings.wire} onChange={e => setSettings(s => ({ ...s, wire: e.target.value as Settings['wire'] }))}><option value="frame16">EchoHawk demo · signed 16-byte frame</option><option value="json">Custom node · JSON envelope</option></select><p className="fine-print">The demo profile uses the existing development key and short messages. Real radio hardware and background reception still need validation.</p>{(['service', 'tx', 'rx'] as const).map(key => <div key={key}><label htmlFor={key}>{key === 'service' ? 'Service UUID' : key === 'tx' ? 'Write characteristic UUID' : 'Receipt characteristic UUID'}</label><input id={key} value={settings[key]} onChange={e => setSettings(s => ({ ...s, [key]: e.target.value.trim().toLowerCase() }))} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/></div>)}</details><button className="primary">Save settings</button></form></section>}
      </>}
    </main>
    {view === 'call' && connected && <footer className="call-controls"><div className="call-status"><span className={'status-dot ' + (updatesLost ? 'amber' : '')}/>{call.demo ? 'Demo connected' : audioLive ? 'Call connected' : 'Connecting audio'}{updatesLost && ' · dashboard updates unavailable'}</div><div className="call-identity"><strong>{who}</strong><span>{duration}</span></div><p>{call.demo ? 'Type on the call screen to try the conversation.' : 'You can keep talking.'}</p><div className="control-row"><button disabled={call.demo} aria-pressed={muted} onClick={() => { if (muted) voice.current?.unmute(); else voice.current?.mute(); setMuted(!muted); }}><span className={'control-circle ' + (muted ? 'selected' : '')}><Icon name="mic"/></span>{muted ? 'Unmute' : 'Mute'}</button><button onClick={() => { if (call.demo) { setHiddenKit(call.kit?.show_id || null); setLibraryKit(null); } else voice.current?.startAudioPlayback().catch(e => setNotice(errorText(e))); }}><span className="control-circle audio"><Icon name="audio"/></span>{call.demo ? 'Conversation' : 'Resume sound'}</button><button disabled={busy} onClick={() => void endCall()}><span className="control-circle end"><Icon name="end"/></span>End call</button></div></footer>}
  </div>;
}
