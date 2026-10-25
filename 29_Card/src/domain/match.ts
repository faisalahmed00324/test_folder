import { cardPoints, type Deck } from './cards';
import { createDeal, dealNextPacket, type DealState } from './deal';
import type { HandContract } from './pair';
import type { PlayState } from './play';
import type { RulesetConfig } from './ruleset';
import { scoreHand, type HandSummary } from './scoring';
import { nextSeat, type Seat, type Team } from './seats';

export interface MatchProgress {
  readonly ruleset: RulesetConfig;
  readonly dealer: Seat;
  readonly gameScores: Readonly<Record<Team, number>>;
  readonly handNumber: number;
  readonly dealNumber: number;
  readonly status: 'IN_PROGRESS' | 'FINISHED' | 'ABANDONED';
  readonly winner: Team | null;
  readonly phase: 'AWAITING_DEAL' | 'REDEAL_WINDOW' | 'IN_HAND';
  readonly firstPacket: DealState | null;
  readonly redealDeadline: number | null;
}
export type MatchEvent =
  | { readonly type: 'HAND_STARTED'; readonly handNumber: number; readonly dealNumber: number; readonly dealer: Seat }
  | { readonly type: 'HAND_SCORED'; readonly handNumber: number; readonly dealNumber: number; readonly summary: HandSummary }
  | { readonly type: 'DEAL_VOIDED'; readonly reason: 'allPass' | 'pointlessFour' | 'serverFault' }
  | { readonly type: 'MATCH_ENDED'; readonly winner: Team | null; readonly gameScores: Readonly<Record<Team, number>>; readonly abandoned: boolean };
export type MatchResult =
  | { readonly ok: true; readonly state: MatchProgress; readonly events: readonly MatchEvent[] }
  | { readonly ok: false; readonly state: MatchProgress; readonly events: readonly [];
      readonly code: 'MATCH_OVER' | 'WRONG_PHASE' | 'STALE_STATE' | 'TURN_EXPIRED' | 'REDEAL_NOT_ELIGIBLE' };

export function createMatchProgress(ruleset: RulesetConfig, firstDealer: Seat): MatchProgress {
  return { ruleset, dealer: firstDealer, gameScores: { A: 0, B: 0 }, handNumber: 1, dealNumber: 1,
    status: 'IN_PROGRESS', winner: null, phase: 'AWAITING_DEAL', firstPacket: null, redealDeadline: null };
}

export function startMatchDeal(state: MatchProgress, deck: Deck, now: number, redealWindowMs = 3000): MatchResult {
  if (state.status !== 'IN_PROGRESS') return { ok: false, state, events: [], code: 'MATCH_OVER' };
  if (state.phase !== 'AWAITING_DEAL') return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  if (!Number.isFinite(now) || !Number.isFinite(redealWindowMs) || redealWindowMs <= 0) throw new RangeError('Invalid redeal timing');
  const firstPacket = dealNextPacket(createDeal(deck), state.dealer, state.ruleset.direction);
  return { ok: true, state: { ...state, firstPacket,
    phase: state.ruleset.redealOnPointlessFour ? 'REDEAL_WINDOW' : 'IN_HAND',
    redealDeadline: state.ruleset.redealOnPointlessFour ? now + redealWindowMs : null },
  events: [{ type: 'HAND_STARTED', handNumber: state.handNumber, dealNumber: state.dealNumber, dealer: state.dealer }] };
}

export function closeRedealWindow(state: MatchProgress, now: number): MatchResult {
  if (!Number.isFinite(now)) throw new RangeError('Redeal timing must be finite');
  if (state.status !== 'IN_PROGRESS') return { ok: false, state, events: [], code: 'MATCH_OVER' };
  if (state.phase !== 'REDEAL_WINDOW' || state.redealDeadline === null || now < state.redealDeadline) {
    return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  }
  return { ok: true, state: { ...state, phase: 'IN_HAND', redealDeadline: null }, events: [] };
}

export function requestRedeal(state: MatchProgress, seat: Seat, now: number): MatchResult {
  if (!Number.isFinite(now)) throw new RangeError('Redeal timing must be finite');
  if (state.status !== 'IN_PROGRESS') return { ok: false, state, events: [], code: 'MATCH_OVER' };
  if (state.phase !== 'REDEAL_WINDOW') return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  if (now >= state.redealDeadline!) return { ok: false, state, events: [], code: 'TURN_EXPIRED' };
  if (!state.ruleset.redealOnPointlessFour || state.firstPacket!.hands[seat].some(card => cardPoints(card) > 0)) {
    return { ok: false, state, events: [], code: 'REDEAL_NOT_ELIGIBLE' };
  }
  return voidMatchDeal(state, 'pointlessFour');
}

export function voidMatchDeal(state: MatchProgress, reason: 'allPass' | 'pointlessFour' | 'serverFault'): MatchResult {
  if (state.status !== 'IN_PROGRESS') return { ok: false, state, events: [], code: 'MATCH_OVER' };
  if (state.phase === 'AWAITING_DEAL') return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  if ((reason === 'allPass' && state.ruleset.openingBidForced) ||
      (reason === 'pointlessFour' && (state.phase !== 'REDEAL_WINDOW' || !state.ruleset.redealOnPointlessFour))) {
    return { ok: false, state, events: [], code: 'REDEAL_NOT_ELIGIBLE' };
  }
  return { ok: true, state: { ...state, phase: 'AWAITING_DEAL', firstPacket: null, redealDeadline: null,
    dealNumber: state.dealNumber + 1,
    dealer: reason === 'allPass' || state.ruleset.redealDealer === 'sameDealer'
      ? state.dealer : nextSeat(state.dealer, state.ruleset.direction) }, events: [{ type: 'DEAL_VOIDED', reason }] };
}

export function scoreMatchHand(
  state: MatchProgress, dealNumber: number, play: PlayState, contract: HandContract, stakeMultiplier: 1 | 2 | 4,
): MatchResult {
  if (state.status !== 'IN_PROGRESS') return { ok: false, state, events: [], code: 'MATCH_OVER' };
  if (dealNumber !== state.dealNumber) return { ok: false, state, events: [], code: 'STALE_STATE' };
  if (state.phase !== 'IN_HAND' || play.phase !== 'COMPLETE') return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  // The coordinator supplies this match's play state, never a client-authored result.
  const summary = scoreHand(play, contract, stakeMultiplier);
  const team = summary.declaringTeam;
  const gameScores = { ...state.gameScores, [team]: state.gameScores[team] + summary.delta };
  const score = gameScores[team];
  const winner = score >= state.ruleset.matchEnd.winAt ? team
    : score <= state.ruleset.matchEnd.loseAt ? (team === 'A' ? 'B' : 'A') : null;
  const events: MatchEvent[] = [{ type: 'HAND_SCORED', handNumber: state.handNumber, dealNumber, summary }];
  if (winner !== null) events.push({ type: 'MATCH_ENDED', winner, gameScores, abandoned: false });
  return { ok: true, events, state: { ...state, gameScores, winner,
    status: winner !== null ? 'FINISHED' : 'IN_PROGRESS', phase: 'AWAITING_DEAL', firstPacket: null, redealDeadline: null,
    dealer: winner !== null ? state.dealer : nextSeat(state.dealer, state.ruleset.direction),
    handNumber: winner !== null ? state.handNumber : state.handNumber + 1,
    dealNumber: winner !== null ? state.dealNumber : state.dealNumber + 1 } };
}

export function abandonMatch(state: MatchProgress): MatchResult {
  if (state.status !== 'IN_PROGRESS') return { ok: false, state, events: [], code: 'MATCH_OVER' };
  return { ok: true, state: { ...state, status: 'ABANDONED', winner: null, phase: 'AWAITING_DEAL', firstPacket: null, redealDeadline: null },
    events: [{ type: 'MATCH_ENDED', winner: null, gameScores: state.gameScores, abandoned: true }] };
}
