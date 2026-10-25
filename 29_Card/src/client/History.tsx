import type { HistoryPage } from '../protocol/history';
import { cardLabel, seatLabel, suitLabel } from './presentation';

export function History({ page, loading, error, disabled, onLoad }: {
  page: HistoryPage | null; loading: boolean; error: string | null; disabled: boolean; onLoad(before?: number): void;
}) {
  return <section className="panel" aria-label="Completed table history"><h2>Completed table history</h2>
    <p className="hint">Completed hands and match results only. Current hands never appear here.</p>
    <div className="actions"><button disabled={disabled || loading} onClick={() => onLoad()}>Latest results</button>
      {page?.nextBefore && <button disabled={disabled || loading} onClick={() => onLoad(page.nextBefore!)}>Older results</button>}</div>
    {loading && <p role="status">Loading history…</p>}
    {error && <p role="alert">History unavailable. Try Latest results again.</p>}
    {page && page.entries.length === 0 && <p>No completed results on this page.</p>}
    {page?.truncated && <p className="notice">Only the most recent 100 completed entries are available from this table. Older results are outside this browsing window.</p>}
    {page?.entries.map(entry => <article className="history-entry" key={entry.index}
      aria-label={entry.kind === 'HAND' ? `Match ${entry.matchNumber} hand ${entry.handNumber}` : `Match ${entry.matchNumber} result`}>
      <h3>{entry.kind === 'HAND' ? `Match ${entry.matchNumber} · Hand ${entry.handNumber} · Deal ${entry.dealNumber}` : `Match ${entry.matchNumber} result`}</h3>
      <p>Team A: {entry.gameScores.A} · Team B: {entry.gameScores.B}</p>
      {entry.kind === 'MATCH' ? <p>{entry.abandoned ? 'Abandoned — no winner' : `Winner: Team ${entry.winner}`} · {entry.handsPlayed} completed hands</p>
        : <><p>Team {entry.summary.declaringTeam} {entry.summary.made ? 'made' : 'missed'} the contract.
          {' '}Bid {entry.summary.originalContract} · Target {entry.summary.effectiveContract} · Stakes ×{entry.summary.stakeMultiplier} · Score change {entry.summary.delta}</p>
          <p>Declarer: {seatLabel(entry.summary.declarer)} · Points {entry.summary.declaringPoints} to {entry.summary.defendingPoints}
            {' · '}Trump: {suitLabel(entry.summary.trumpSuit)}{entry.summary.indicatorCard ? ` · Indicator: ${cardLabel(entry.summary.indicatorCard)}` : ''}</p>
          {entry.summary.pair && <p>Pair declared by {seatLabel(entry.summary.pair.seat)} · Team {entry.summary.pair.team}</p>}
          <details><summary>Show eight tricks for match {entry.matchNumber} hand {entry.handNumber}</summary>
            <ol>{entry.summary.tricks.map(trick => <li key={trick.index}>Trick {trick.index}: {trick.plays.map(play => `${seatLabel(play.seat)} ${cardLabel(play.card)}`).join(', ')}
              {' · '}{seatLabel(trick.winner)} wins · {trick.points} points</li>)}</ol>
          </details></>}
    </article>)}
  </section>;
}
