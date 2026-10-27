import { useEffect, useRef, useState } from 'react';
import { tablePinSchema, tableCredentialsSchema } from '../protocol/private-tables';
import { validEndpoint } from './protocol';

export function defaultTableEndpoint() {
  return location.protocol === 'https:' ? `wss://${location.host}/29-card/ws` : `ws://${location.hostname}:8766/29-card/ws`;
}

export function PrivateTables({ onJoin }: { onJoin(access: { endpoint: string; pin: string; token: string }): void }) {
  const [screen, setScreen] = useState<'home' | 'private' | 'join'>('home');
  const [endpoint, setEndpoint] = useState(defaultTableEndpoint);
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const joinAttempts = useRef(new Map<string, string>());
  useEffect(() => () => request.current?.abort(), []);

  function newJoinAttemptId() {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function enter(create: boolean) {
    if (request.current) return;
    const address = endpoint.trim();
    if (!validEndpoint(address)) { setError('Use a valid table server address. Remote tables require WSS.'); return; }
    if (!create && !tablePinSchema.safeParse(pin).success) { setError('Enter exactly six digits.'); return; }
    const controller = new AbortController();
    request.current = controller;
    setPending(true); setError('');
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const url = new URL(address);
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      url.pathname = create ? '/29-card/tables' : '/29-card/tables/join';
      url.search = ''; url.hash = '';
      let attemptId: string | undefined;
      const attemptKey = JSON.stringify([address, pin]);
      if (!create) {
        attemptId = joinAttempts.current.get(attemptKey);
        if (!attemptId) {
          attemptId = newJoinAttemptId();
          if (joinAttempts.current.size >= 16) {
            const oldest = joinAttempts.current.keys().next().value;
            if (oldest) joinAttempts.current.delete(oldest);
          }
          joinAttempts.current.set(attemptKey, attemptId);
        }
      }
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(create ? {} : { pin, attemptId }), signal: controller.signal, credentials: 'omit', cache: 'no-store' });
      if (!response.ok) {
        const messages: Record<number, string> = { 400: 'Enter exactly six digits.', 404: 'Table not found or expired. Check the PIN.',
          409: 'This table is full or the join attempt is no longer valid.', 429: 'Too many attempts. Please try again shortly.',
          503: 'Tables are temporarily unavailable. Please try again later.' };
        setError(messages[response.status] ?? 'Unable to enter the table. Please try again.'); return;
      }
      const parsed = tableCredentialsSchema.safeParse(await response.json());
      if (!parsed.success || (!create && (parsed.data.pin !== pin || parsed.data.token !== attemptId))) {
        setError('The table server returned an invalid response.'); return;
      }
      if (controller.signal.aborted) return;
      if (!create) joinAttempts.current.delete(attemptKey);
      onJoin({ endpoint: address, ...parsed.data });
    } catch {
      if (request.current === controller) setError('Cannot reach the table server. Check your connection and try again.');
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setPending(false); }
    }
  }

  return <section className="panel join-panel">
    <p className="eyebrow">FOUR SEATS · TWO TEAMS · ONE TABLE</p>
    <h1>Twenty-Nine</h1>
    {screen === 'home' ? <>
      <p>Play a private game with three friends. No login required.</p>
      <button onClick={() => setScreen('private')}>Private table</button>
    </> : <>
      <h2>{screen === 'join' ? 'Join a private table' : 'Private table'}</h2>
      <p>Create a table and share its six-digit PIN, or join with a friend's PIN.</p>
      {screen === 'private' ? <div className="actions">
        <button disabled={pending} onClick={() => void enter(true)}>{pending ? 'Creating…' : 'Create table'}</button>
        <button disabled={pending} onClick={() => { setError(''); setScreen('join'); }}>Join table</button>
      </div> : <form onSubmit={event => { event.preventDefault(); void enter(false); }}>
        <label>Six-digit PIN<input value={pin} inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6}
          autoComplete="off" required disabled={pending} onChange={event => setPin(event.target.value)} /></label>
        <button type="submit" disabled={pending}>{pending ? 'Joining…' : 'Join table'}</button>
      </form>}
      <details><summary>Server settings</summary>
        <label>Table WebSocket address<input type="url" value={endpoint} disabled={pending}
          onChange={event => setEndpoint(event.target.value)} /></label>
      </details>
      <p className="hint">All four players confirm readiness before dealing. Tables are temporary; no login or saved game history.</p>
      <button className="secondary" disabled={pending} onClick={() => { setError(''); setScreen(screen === 'join' ? 'private' : 'home'); }}>Back</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
