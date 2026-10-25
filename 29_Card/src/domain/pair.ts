import type { CardId } from './cards';
import type { PlayState } from './play';
import { teamForSeat, type Seat, type Team } from './seats';
import type { RulesetConfig } from './ruleset';

export interface HandContract {
  readonly originalContract: number;
  readonly effectiveContract: number;
  readonly pair: { readonly seat: Seat; readonly team: Team } | null;
}
export interface PairPreference {
  readonly autoDeclarePair: boolean;
  readonly isBot: boolean;
}
export interface PairWindow {
  readonly play: PlayState;
  readonly contract: HandContract;
  readonly status: 'OPEN' | 'CLOSED';
  readonly deadline: number | null;
}
export type PairEvent =
  | { readonly type: 'PAIR_WINDOW_OPENED'; readonly deadline: number }
  | { readonly type: 'PAIR_DECLARED'; readonly seat: Seat; readonly cards: readonly CardId[];
      readonly effectiveContract: number };
export type PairResult =
  | { readonly ok: true; readonly state: PairWindow; readonly events: readonly PairEvent[] }
  | { readonly ok: false; readonly state: PairWindow; readonly events: readonly [];
      readonly code: 'WRONG_PHASE' | 'TURN_EXPIRED' | 'PAIR_NOT_ELIGIBLE' };

export function createHandContract(ruleset: RulesetConfig, bid: number): HandContract {
  if (!Number.isInteger(bid) || bid < ruleset.minBid || bid > ruleset.maxBid) {
    throw new RangeError('Contract must be a legal bid');
  }
  return { originalContract: bid, effectiveContract: bid, pair: null };
}

export function canDeclarePair(play: PlayState, contract: HandContract, seat: Seat): boolean {
  if (!play.ruleset.pair.enabled || play.phase !== 'TRICK_COMPLETE' || play.reveal === null || contract.pair !== null) return false;
  const completed = play.completedTricks[play.completedTricks.length - 1];
  return completed.index >= play.reveal.trickIndex && completed.index < 8 &&
    teamForSeat(completed.winner) === teamForSeat(seat) &&
    play.hands[seat].includes(`K${play.trumpSuit}`) && play.hands[seat].includes(`Q${play.trumpSuit}`);
}

export function openPairWindow(
  play: PlayState, contract: HandContract, preferences: Readonly<Record<Seat, PairPreference>>, now: number,
): { readonly state: PairWindow; readonly events: readonly PairEvent[] } {
  if (play.phase !== 'TRICK_COMPLETE' && play.phase !== 'COMPLETE') throw new RangeError('Pair handling requires a completed trick');
  if (!Number.isFinite(now)) throw new RangeError('Pair timing must be finite');
  const state: PairWindow = { play, contract, status: 'CLOSED', deadline: null };
  const cfg = play.ruleset.pair;
  if (!cfg.enabled || play.phase === 'COMPLETE' || play.reveal === null || contract.pair !== null) return { state, events: [] };
  const winner = play.completedTricks[play.completedTricks.length - 1].winner;
  const teamSeats = ([0, 1, 2, 3] as const).filter(seat => teamForSeat(seat) === teamForSeat(winner));
  for (const seat of teamSeats) {
    if ((preferences[seat].autoDeclarePair || preferences[seat].isBot) && canDeclarePair(play, contract, seat)) {
      return declarePair({ ...state, status: 'OPEN' }, seat, cfg);
    }
  }
  if (teamSeats.some(seat => !preferences[seat].autoDeclarePair && !preferences[seat].isBot)) {
    const deadline = now + cfg.windowMs;
    return { state: { ...state, status: 'OPEN', deadline }, events: [{ type: 'PAIR_WINDOW_OPENED', deadline }] };
  }
  return { state, events: [] };
}

function declarePair(
  state: PairWindow, seat: Seat, cfg: Extract<RulesetConfig['pair'], { enabled: true }>,
): { state: PairWindow; events: PairEvent[] } {
  const team = teamForSeat(seat);
  const target = team === teamForSeat(state.play.declarer)
    ? Math.max(cfg.floor, state.contract.effectiveContract - cfg.adjustment)
    : Math.min(cfg.ceiling, state.contract.effectiveContract + cfg.adjustment);
  return { state: { ...state, status: 'CLOSED', deadline: null,
    contract: { ...state.contract, pair: { seat, team }, effectiveContract: target } },
  events: [{ type: 'PAIR_DECLARED', seat, cards: [`K${state.play.trumpSuit}`, `Q${state.play.trumpSuit}`], effectiveContract: target }] };
}

export function applyPairDeclaration(state: PairWindow, seat: Seat, now: number): PairResult {
  if (!Number.isFinite(now)) throw new RangeError('Pair timing must be finite');
  const reject = (code: 'WRONG_PHASE' | 'TURN_EXPIRED' | 'PAIR_NOT_ELIGIBLE'): PairResult => ({ ok: false, state, events: [], code });
  if (state.status !== 'OPEN') return reject('WRONG_PHASE');
  if (state.deadline !== null && now >= state.deadline) return reject('TURN_EXPIRED');
  if (!state.play.ruleset.pair.enabled || !canDeclarePair(state.play, state.contract, seat)) return reject('PAIR_NOT_ELIGIBLE');
  return { ok: true, ...declarePair(state, seat, state.play.ruleset.pair) };
}

export function closePairWindow(state: PairWindow, now: number): PairResult {
  if (!Number.isFinite(now)) throw new RangeError('Pair timing must be finite');
  if (state.status !== 'OPEN' || state.deadline === null || now < state.deadline) {
    return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  }
  return { ok: true, state: { ...state, status: 'CLOSED', deadline: null }, events: [] };
}
