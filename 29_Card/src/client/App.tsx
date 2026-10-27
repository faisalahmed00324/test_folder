import { useEffect, useState } from 'react';
import { createTableClient, initialClientState } from './table-client';
import { Table } from './Table';
import { QuickChat } from './QuickChat';
import { PrivateTables } from './PrivateTables';

export function App() {
  const [state, setState] = useState(initialClientState);
  const [client] = useState(() => createTableClient({
    socket: url => new WebSocket(url), commandId: () => crypto.randomUUID(), changed: setState,
    schedule: (delay, callback) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
  }));
  const [access, setAccess] = useState<{ endpoint: string; pin: string; token: string } | null>(null);
  useEffect(() => {
    if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  }, []);
  useEffect(() => () => client.disconnect(), [client]);
  const active = ['connecting', 'seating', 'syncing', 'connected', 'reconnecting'].includes(state.status);
  return <main>
    {!active && <PrivateTables onJoin={next => { setAccess(next); client.connect(next.endpoint, next.token); }} />}
    {access && <section className="panel" aria-label="Private table PIN"><h2>Table PIN: <span>{access.pin}</span></h2>
      <p>Share this six-digit PIN with your other three players. Keep this page open to keep your seat.</p>
      {!active && <button onClick={() => client.connect(access.endpoint, access.token)}>Reconnect table</button>}
    </section>}
    <div className="connection" role="status">Connection: {state.status}{state.pending ? ' · Sending move…' : ''}</div>
    {state.error && <p className="notice" role="alert">{state.error.replaceAll('_', ' ')}. Check your connection or ask the table host.</p>}
    {active && !state.snapshot && !state.lobby && <section className="panel"><h1>Joining your table</h1><p>Waiting for a fresh, private server view…</p></section>}
    {state.snapshot && <Table view={state.snapshot} lastSummary={state.lastSummary} disabled={state.status !== 'connected' || state.pending} onAction={client.play} />}
    {state.snapshot?.chat && <QuickChat chat={state.snapshot.chat} disabled={state.status !== 'connected' || state.pending}
      onSend={phraseId => client.play({ type: 'QUICK_CHAT', phraseId })} />}
    {active && <footer><button className="secondary" onClick={() => client.disconnect()}>Disconnect</button>
      {state.snapshot && state.snapshot.viewer !== 'spectator' && <button className="secondary" disabled={state.status !== 'connected'}
        onClick={() => { if (window.confirm('Leave this table and hand your seat to a bot?')) { client.leave(); setAccess(null); } }}>Leave table</button>}
      <p>Disconnect keeps your seat during grace. Leave hands control to a bot immediately.</p></footer>}
  </main>;
}
