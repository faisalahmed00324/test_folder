import { useEffect, useState } from 'react';
import type { TableSnapshot } from './protocol';
import type { PlayerAction } from '../protocol/player-command';
import { actionLabel, cardLabel, seatLabel, suitLabel } from './presentation';
import { teamForSeat } from '../domain/seats';

function Countdown({ remainingMs }: { remainingMs: number }) {
  const [remaining, setRemaining] = useState(remainingMs);
  useEffect(() => {
    const started = performance.now();
    setRemaining(remainingMs);
    const timer = setInterval(() => setRemaining(Math.max(0, remainingMs - (performance.now() - started))), 250);
    return () => clearInterval(timer);
  }, [remainingMs]);
  return <span aria-label="Time remaining">{Math.ceil(remaining / 1000)}s</span>;
}

export function Table({ view, disabled, onAction, lastSummary }: {
  view: TableSnapshot; disabled: boolean; onAction(action: PlayerAction): void; lastSummary?: TableSnapshot['summary'];
}) {
  const summary = view.summary ?? lastSummary;
  const mine = view.viewer !== 'spectator';
  const controller = view.viewer === 'spectator' ? undefined : view.seats?.[view.viewer];
  const coordinating = view.table !== undefined && view.table.phase !== 'PLAYING';
  const locked = disabled || !mine || (!coordinating && (controller?.controller === 'bot' || view.status !== 'IN_PROGRESS'));
  const playedCards = view.legalActions.filter(action => action.type === 'PLAY_CARD');
  const otherActions = view.legalActions.filter(action => action.type !== 'PLAY_CARD');
  return <>
    <header className="table-heading">
      <div><p className="eyebrow">PRIVATE TABLE · {view.ruleset.rulesetId}</p><h1>{view.ruleset.rulesetId.startsWith('28-') ? 'Twenty-Eight' : 'Twenty-Nine'}</h1>
        <p>{view.viewer !== 'spectator' ? `${seatLabel(view.viewer)} · Team ${teamForSeat(view.viewer)}` : 'Spectator · read only'}
          {' · '}Hand {view.handNumber} · Deal {view.dealNumber}</p></div>
      <div className="score" aria-label="Match scores"><span>Team A <b>{view.gameScores.A}</b></span><span>Team B <b>{view.gameScores.B}</b></span></div>
    </header>
    <section className="panel" aria-label="Table status">
      {view.table && <p>Match {view.table.matchNumber} · {view.table.phase.replaceAll('_', ' ')}</p>}
      <p role="status" className="turn">{view.table?.phase === 'WAITING' ? 'Waiting for all four seats'
        : view.table?.phase === 'READY_CHECK' ? 'Ready check — confirm before the deadline'
        : view.table?.phase === 'REMATCH' ? 'Rematch vote — every human must accept'
        : view.table?.phase === 'CLOSED' ? 'Rematch closed — ask the host for a new table'
        : view.status === 'ABANDONED' ? 'Match abandoned — no winner'
        : view.status === 'FINISHED' ? `Match finished — Team ${view.winner} wins`
        : view.toAct === view.viewer ? 'Your turn' : view.toAct === null ? 'Decision window' : `${seatLabel(view.toAct)} to act`}
        {view.deadline !== null && <> · <Countdown key={`${view.version}:${view.deadline}`} remainingMs={view.remainingMs} /></>}</p>
      <p>{view.phase.replaceAll('_', ' ')} · Dealer {seatLabel(view.dealer)} · {view.ruleset.direction}</p>
      <p>Trump: {view.trumpSuit ? `${suitLabel(view.trumpSuit)}${view.reveal ? ' (revealed)' : ' (private)'}` : 'Hidden'}
        {view.myConcealedCard && <> · Your concealed card: {cardLabel(view.myConcealedCard)}</>}</p>
      {view.contract && <p>Contract {view.contract.originalContract} · Target {view.contract.effectiveContract} · Stakes ×{view.stakeMultiplier}</p>}
      {view.timeBankMs !== null && <p>Time bank: {Math.ceil(view.timeBankMs / 1000)}s</p>}
      {view.status !== 'IN_PROGRESS' && view.table && <p>{view.status === 'ABANDONED' ? 'Previous match abandoned — no winner' : `Previous match winner: Team ${view.winner}`}</p>}
      {!coordinating && controller?.reclaimPending && <p className="notice">Bot is finishing the current decision. Your control returns at the next turn boundary.</p>}
      <ul className="seats" aria-label="Players">{([0, 1, 2, 3] as const).map(seat => <li key={seat} className={view.toAct === seat ? 'active-seat' : ''}>
        <b>{seatLabel(seat)}{view.viewer === seat ? ' (you)' : ''}</b><span>Team {teamForSeat(seat)} · {view.handCounts[seat]} cards</span>
        <span>{view.seats?.[seat].controller === 'bot' ? 'Bot' : 'Human'} · {view.seats?.[seat].connected ? 'Online' : 'Offline'}</span>
        {view.table?.phase === 'READY_CHECK' && <span>{view.table.ready[seat] ? 'Ready confirmed' : 'Not ready'}</span>}
        {view.table?.phase === 'REMATCH' && <span>{view.table.votes[seat] === true ? 'Rematch accepted' : view.table.votes[seat] === false ? 'Rematch declined' : 'Vote pending'}</span>}
      </li>)}</ul>
    </section>
    <section className="panel trick" aria-label="Current trick"><h2>Trick {view.currentTrick?.index ?? '—'}</h2>
      <div className="trick-cards">{view.currentTrick?.plays.map(play => <div className="played-card" key={play.seat}>
        <small>{seatLabel(play.seat)}</small><strong>{cardLabel(play.card)}</strong></div>)}</div>
      {!view.currentTrick?.plays.length && <p>No cards on the table.</p>}
    </section>
    {mine && !coordinating && <section className="panel" aria-label="Your hand"><h2>Your hand</h2>
      <div className="hand">{view.myHand.map(card => {
        const action = playedCards.find(action => action.cardId === card);
        return <button key={card} className={`card ${['H', 'D'].includes(card[1]) ? 'red-card' : ''}`}
          disabled={locked || !action} onClick={() => action && onAction(action)} aria-label={`Play ${cardLabel(card)}`}>
          <span aria-hidden="true">{card[0] === 'T' ? '10' : card[0]} {({ C: '♣', D: '♦', H: '♥', S: '♠' } as Record<string, string>)[card[1]]}</span>
          <small>{cardLabel(card)}</small></button>;
      })}</div>
      <p className="hint">Only server-approved moves are enabled. Cards stay in received order.</p>
    </section>}
    {otherActions.length > 0 && <section className="panel" aria-label="Legal actions"><h2>Choose your action</h2>
      <div className="actions">{otherActions.map(action => <button key={JSON.stringify(action)} disabled={locked}
        onClick={() => onAction(action)}>{actionLabel(action)}</button>)}</div></section>}
    {view.auction && <details className="panel" open={['AUCTION', 'SECOND_ROUND'].includes(view.phase)}>
      <summary>Auction · Round {view.auction.round} · Bid {view.auction.current ?? 'not opened'}</summary>
      <ol>{view.auction.history.map((entry, index) => <li key={index}>{seatLabel(entry.seat)}: {entry.action.toLowerCase()} {entry.amount ?? ''}{entry.auto ? ' (automatic)' : ''}</li>)}</ol>
    </details>}
    {view.completedTricks.length > 0 && <details className="panel"><summary>Trick history</summary>
      <ol>{view.completedTricks.map(trick => <li key={trick.index}>Trick {trick.index}: {trick.plays.map(play => `${seatLabel(play.seat)} ${cardLabel(play.card)}`).join(', ')}.
        {' '}{seatLabel(trick.winner)} wins{trick.points !== undefined ? ` · ${trick.points} points` : ''}.</li>)}</ol>
    </details>}
    {summary && <section className="panel" aria-label="Hand summary"><h2>Last hand result</h2>
      <p>Team {summary.declaringTeam} {summary.made ? 'made' : 'missed'} the contract: {summary.declaringPoints} points against target {summary.effectiveContract}.</p>
      <p>Score change: {summary.delta} · Trump: {suitLabel(summary.trumpSuit)}</p>
      <details><summary>All eight tricks</summary><ol>{summary.tricks.map(trick => <li key={trick.index}>Trick {trick.index}: {trick.plays.map(play => cardLabel(play.card)).join(', ')} · {seatLabel(trick.winner)} wins.</li>)}</ol></details>
    </section>}
  </>;
}
