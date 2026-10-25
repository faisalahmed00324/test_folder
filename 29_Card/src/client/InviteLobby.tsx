import { useState } from 'react';
import type { LobbyView } from '../protocol/invitations';
import type { Seat } from '../domain/seats';
import { teamForSeat } from '../domain/seats';
import { seatLabel } from './presentation';

export function InviteLobby({ lobby, token, selected, pending, error, onChoose, onConfirm }: {
  lobby: LobbyView; token: string | null; selected: Seat | null; pending: boolean; error: string | null;
  onChoose(seat: Seat): void; onConfirm(): void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');
  return <section className="panel" aria-label="Invitation seating"><h1>Choose your seat</h1>
    <p>Invitation access shows availability only. Your hand and table controls remain private until a seat is claimed.</p>
    {!lobby.canClaim && <p role="status">Seating is closed. All seats are reserved, play has begun, or the invitation has expired.</p>}
    <div className="actions">{lobby.seats.map(slot => <button key={slot.seat} disabled={pending || !lobby.canClaim || slot.occupied}
      onClick={() => { setRevealed(false); setCopyNotice(''); onChoose(slot.seat); }}>
      {slot.occupied ? `${seatLabel(slot.seat)} occupied` : `Choose ${seatLabel(slot.seat)}`} · Team {teamForSeat(slot.seat)}
    </button>)}</div>
    {error && <p role="alert">{error.replaceAll('_', ' ')}. Choose an available seat or ask the host.</p>}
    {token && selected !== null && <div className="notice" aria-label="Save reconnect token">
      <h2>Save your reconnect token first</h2>
      <p>This private token will reclaim {seatLabel(selected)}. The shared invitation cannot recover an occupied seat.
        Save the token somewhere secure before confirming. This page does not store it after disconnect.</p>
      <label>Your reconnect token<input type={revealed ? 'text' : 'password'} readOnly value={token} autoComplete="off" /></label>
      <label className="check-label"><input type="checkbox" checked={revealed} onChange={event => setRevealed(event.target.checked)} />Reveal reconnect token</label>
      <div className="actions"><button type="button" disabled={pending} onClick={() => {
        void (async () => {
          try { await navigator.clipboard.writeText(token); setCopyNotice('Copied. Keep this token private.'); }
          catch { setCopyNotice('Copy unavailable. Reveal the token and copy it manually.'); }
        })();
      }}>Copy reconnect token</button>
      <button disabled={pending || !lobby.canClaim || lobby.seats[selected].occupied} onClick={onConfirm}>
        {pending ? 'Claiming seat…' : `I saved this token — claim ${seatLabel(selected)}`}
      </button></div>
      {copyNotice && <p role="status">{copyNotice}</p>}
    </div>}
  </section>;
}
