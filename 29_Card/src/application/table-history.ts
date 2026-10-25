import type { HandSummary } from '../domain/scoring';
import type { HistoryEntry, HistoryPage, HistoryQuery, PublicHandSummary } from '../protocol/history';
import type { RuntimeEvent } from './match-actor';

export const HISTORY_CAPACITY = 100;
export type HistoryState = { entries: readonly HistoryEntry[]; nextIndex: number; matchNumber: number; handsPlayed: number };
export function createHistoryState(): HistoryState { return { entries: [], nextIndex: 1, matchNumber: 1, handsPlayed: 0 }; }
export function publicHandSummary(summary: HandSummary): PublicHandSummary {
  return { declarer: summary.declarer, declaringTeam: summary.declaringTeam,
    declaringPoints: summary.declaringPoints, defendingPoints: summary.defendingPoints,
    originalContract: summary.originalContract, effectiveContract: summary.effectiveContract,
    made: summary.made, delta: summary.delta, stakeMultiplier: summary.stakeMultiplier,
    pair: summary.pair ? { ...summary.pair } : null, trumpSuit: summary.trumpSuit, indicatorCard: summary.indicatorCard,
    tricks: summary.tricks.map(trick => ({ index: trick.index, leader: trick.leader, winner: trick.winner, points: trick.points,
      plays: trick.plays.map(({ seat, card }) => ({ seat, card })) })) };
}

// Rebuild from committed public outcomes, never from live hands or hidden state.
// The bounded index is a projection of the existing journal, not another store.
export function recordHistory(previous: HistoryState, matchNumber: number, timestamp: number,
  gameScores: { readonly A: number; readonly B: number }, events: readonly RuntimeEvent['event'][]): HistoryState {
  const next = { ...previous, entries: [...previous.entries], matchNumber,
    handsPlayed: previous.matchNumber === matchNumber ? previous.handsPlayed : 0 };
  for (const event of events) {
    const base = { index: next.nextIndex, matchNumber, timestamp, gameScores: { ...gameScores } };
    if (event.type === 'HAND_SCORED') {
      next.entries.push({ ...base, kind: 'HAND', handNumber: event.handNumber, dealNumber: event.dealNumber,
        summary: publicHandSummary(event.summary) });
      next.handsPlayed++; next.nextIndex++;
    } else if (event.type === 'MATCH_ENDED') {
      next.entries.push({ ...base, kind: 'MATCH', winner: event.winner, abandoned: event.abandoned, handsPlayed: next.handsPlayed });
      next.nextIndex++;
    }
  }
  next.entries = next.entries.slice(-HISTORY_CAPACITY);
  return next;
}
export function historyPage(state: HistoryState, query: HistoryQuery): HistoryPage {
  const available = state.entries.filter(entry => entry.index < (query.before ?? state.nextIndex)).slice().reverse();
  const entries = available.slice(0, query.limit);
  return structuredClone({ entries, nextBefore: available.length > query.limit ? entries.at(-1)!.index : null,
    earliestAvailable: state.entries[0]?.index ?? null, total: state.nextIndex - 1,
    truncated: state.entries.length > 0 && state.entries[0].index > 1 });
}
