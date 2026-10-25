import { useEffect, useState } from 'react';
import { createTableClient, initialClientState } from './table-client';
import { Table } from './Table';
import { QuickChat } from './QuickChat';
import { History } from './History';
import { InviteLobby } from './InviteLobby';
import { browserSeatToken, initialJoinForm } from './invitation-form';

export function App() {
  const [state, setState] = useState(initialClientState);
  const [client] = useState(() => createTableClient({
    socket: url => new WebSocket(url), commandId: () => crypto.randomUUID(), changed: setState,
    seatToken: browserSeatToken,
    schedule: (delay, callback) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
  }));
  const [join, setJoin] = useState(initialJoinForm);
  const { endpoint, token } = join;
  useEffect(() => () => client.disconnect(), [client]);
  const active = ['connecting', 'seating', 'syncing', 'connected', 'reconnecting'].includes(state.status);
  return <main>
    {!active && <section className="panel join-panel"><p className="eyebrow">FOUR SEATS · TWO TEAMS · ONE TABLE</p>
      <h1>Twenty-Nine</h1><p>A private table for Twenty-Nine and Twenty-Eight.</p>
      {join.inviteError && <p role="alert">Invalid invitation link. Ask the host for a new link.</p>}
      <form onSubmit={event => { event.preventDefault(); client.connect(endpoint.trim(), token.trim()); setJoin({ ...join, token: '', inviteError: false }); }}>
        <label>Table WebSocket address<input type="url" value={endpoint} required onChange={event => setJoin({ ...join, endpoint: event.target.value })} /></label>
        <label>Seat access token<input type="password" value={token} required autoComplete="off" spellCheck={false}
          onChange={event => setJoin({ ...join, token: event.target.value })} /></label>
        <button type="submit">Join private table</button>
      </form><p className="hint">Use a seat token or the host's invitation. Invitation fragments are removed from the address bar before connecting.
        Reconnect tokens stay in memory, never browser storage. Remote tables require WSS.</p>
      <p>Private-table preview. All human players confirm readiness before the first deal and vote together for a rematch.</p>
    </section>}
    <div className="connection" role="status">Connection: {state.status}{state.pending ? ' · Sending move…' : ''}</div>
    {state.error && <p className="notice" role="alert">{state.error.replaceAll('_', ' ')}. Check your connection or ask the table host.</p>}
    {active && !state.snapshot && !state.lobby && <section className="panel"><h1>Joining your table</h1><p>Waiting for a fresh, private server view…</p></section>}
    {state.lobby && <InviteLobby lobby={state.lobby} token={state.seatToken} selected={state.selectedSeat}
      pending={state.seatingPending} error={state.seatError} onChoose={client.prepareSeat} onConfirm={client.confirmSeat} />}
    {state.snapshot && <Table view={state.snapshot} lastSummary={state.lastSummary} disabled={state.status !== 'connected' || state.pending} onAction={client.play} />}
    {state.snapshot?.chat && <QuickChat chat={state.snapshot.chat} disabled={state.status !== 'connected' || state.pending}
      onSend={phraseId => client.play({ type: 'QUICK_CHAT', phraseId })} />}
    {state.snapshot && <History page={state.history} loading={state.historyPending} error={state.historyError}
      disabled={!['connected', 'syncing'].includes(state.status)} onLoad={client.loadHistory} />}
    {active && <footer><button className="secondary" onClick={() => client.disconnect()}>Disconnect</button>
      {state.snapshot && state.snapshot.viewer !== 'spectator' && <button className="secondary" disabled={state.status !== 'connected'}
        onClick={() => { if (window.confirm('Leave this table and hand your seat to a bot?')) client.leave(); }}>Leave table</button>}
      <p>{state.lobby ? 'Guests have no game access. A claimed seat needs its saved reconnect token to return.'
        : 'Disconnect keeps your seat during grace. Leave hands control to a bot immediately.'}</p></footer>}
  </main>;
}
