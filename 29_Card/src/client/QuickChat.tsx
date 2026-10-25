import { useEffect, useState } from 'react';
import { QUICK_CHAT_PHRASES, type ChatView, type PhraseId } from '../protocol/quick-chat';
import { seatLabel } from './presentation';

export function QuickChat({ chat, disabled, onSend }: { chat: ChatView; disabled: boolean; onSend(phrase: PhraseId): void }) {
  const [muted, setMuted] = useState<number[]>([]);
  const [remaining, setRemaining] = useState(chat.remainingMs);
  useEffect(() => {
    const started = performance.now();
    setRemaining(chat.remainingMs);
    if (chat.remainingMs === 0) return;
    const timer = setInterval(() => {
      const left = Math.max(0, chat.remainingMs - (performance.now() - started));
      setRemaining(left);
      if (left === 0) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [chat.remainingMs, chat.cooldownStartedAt]);
  return <section className="panel" aria-label="Quick chat"><h2>Quick chat</h2>
    <p className="hint">Fixed phrases only · one message every two seconds. No free text or card details.</p>
    {chat.canSend && <div className="actions">{(Object.keys(QUICK_CHAT_PHRASES) as PhraseId[]).map(phrase =>
      <button key={phrase} disabled={disabled || remaining > 0} onClick={() => onSend(phrase)}
        aria-label={`Say ${QUICK_CHAT_PHRASES[phrase]}`}>{QUICK_CHAT_PHRASES[phrase]}</button>)}</div>}
    {chat.canSend && remaining > 0 && <p role="status">Chat cooldown: {Math.ceil(remaining / 1000)}s</p>}
    <details><summary>Mute messages from seats</summary><div className="mute-controls">
      {[0, 1, 2, 3].map(seat => <label key={seat}><input type="checkbox" checked={muted.includes(seat)}
        onChange={event => setMuted(event.target.checked ? [...muted, seat] : muted.filter(value => value !== seat))} />Mute {seatLabel(seat)}</label>)}
    </div></details>
    <ol role="log" aria-label="Table messages" aria-live="polite" aria-relevant="additions">
      {chat.messages.filter(message => !muted.includes(message.seat)).map(message => <li key={message.id}>
        <b>{seatLabel(message.seat)}:</b> {QUICK_CHAT_PHRASES[message.phraseId]}</li>)}
    </ol>
    {chat.messages.length === 0 && <p>No messages yet.</p>}
  </section>;
}
