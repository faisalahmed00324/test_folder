import { z } from 'zod';
import { cardIdSchema, cardPoints, cardStrength, cardSuit, type CardId, type Suit } from './cards';
import { weakestPlayAction } from './decision-policy';
import type { RulesetConfig } from './ruleset';
import { nextSeat, teamForSeat, type Seat, type Team } from './seats';
import type { TrumpState } from './trump';

export const playActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('PLAY_CARD'), cardId: cardIdSchema }),
  z.strictObject({ type: z.literal('CALL_TRUMP') }),
  z.strictObject({ type: z.literal('REVEAL_TRUMP') }),
]);
export type PlayAction = z.infer<typeof playActionSchema>;

export interface CardPlay {
  readonly seat: Seat;
  readonly card: CardId;
}
export interface Trick {
  readonly index: number;
  readonly leader: Seat;
  readonly plays: readonly CardPlay[];
}
export interface TrumpReveal {
  readonly by: Seat | 'system';
  readonly trickIndex: number;
  readonly position: number;
}
export interface CompletedTrick extends Trick {
  readonly plays: readonly (CardPlay & { readonly trumpPower: boolean })[];
  readonly winner: Seat;
  readonly points: number;
}
export interface PlayState {
  readonly ruleset: RulesetConfig;
  readonly declarer: Seat;
  readonly mode: NonNullable<TrumpState['mode']>;
  readonly trumpSuit: Suit;
  readonly initialIndicatorCard: CardId | null;
  readonly hands: Readonly<Record<Seat, readonly CardId[]>>;
  readonly concealed: { readonly owner: Seat; readonly card: CardId } | null;
  readonly phase: 'PLAY' | 'TRICK_COMPLETE' | 'COMPLETE';
  readonly currentTrick: Trick;
  readonly completedTricks: readonly CompletedTrick[];
  readonly capturedPoints: Readonly<Record<Team, number>>;
  readonly reveal: TrumpReveal | null;
  readonly pendingRevealPlay: { readonly seat: Seat; readonly indicatorCard: CardId | null } | null;
  readonly toAct: Seat | null;
}
export type PlayEvent =
  | { readonly type: 'CARD_PLAYED'; readonly seat: Seat; readonly card: CardId;
      readonly trickIndex: number; readonly position: number }
  | { readonly type: 'TRUMP_CALLED'; readonly seat: Seat }
  | { readonly type: 'TRUMP_REVEALED'; readonly suit: Suit; readonly card?: CardId;
      readonly by: Seat | 'system'; readonly trickIndex: number; readonly position: number }
  | { readonly type: 'TRICK_WON'; readonly winner: Seat; readonly points: number; readonly trickIndex: number };
export type PlayError = 'WRONG_PHASE' | 'NOT_YOUR_TURN' | 'CARD_NOT_IN_HAND' | 'MUST_FOLLOW_SUIT' |
  'MUST_PLAY_TRUMP' | 'MUST_PLAY_INDICATOR' | 'CANNOT_LEAD_HIDDEN_TRUMP' | 'REVEAL_NOT_ALLOWED';
export type PlayResult =
  | { readonly ok: true; readonly state: PlayState; readonly events: readonly PlayEvent[] }
  | { readonly ok: false; readonly state: PlayState; readonly events: readonly []; readonly code: PlayError };

export function createPlayState(trump: TrumpState): PlayState {
  if (trump.phase !== 'READY' || trump.deal.dealtCount !== 32 || trump.trumpSuit === null || trump.mode === null) {
    throw new RangeError('Play requires completed trump selection and a full deal');
  }
  const leader = nextSeat(trump.dealer, trump.ruleset.direction);
  return {
    ruleset: trump.ruleset, declarer: trump.declarer, mode: trump.mode, trumpSuit: trump.trumpSuit,
    initialIndicatorCard: trump.concealed?.card ?? null,
    hands: trump.deal.hands, concealed: trump.concealed as PlayState['concealed'],
    phase: 'PLAY', currentTrick: { index: 1, leader, plays: [] }, completedTricks: [],
    capturedPoints: { A: 0, B: 0 }, reveal: null, pendingRevealPlay: null, toAct: leader,
  };
}

export function legalPlayActions(state: PlayState): readonly PlayAction[] {
  if (state.phase !== 'PLAY' || state.toAct === null) return [];
  const seat = state.toAct;
  const hand = state.hands[seat];
  const play = (cards: readonly CardId[]): PlayAction[] => cards.map(cardId => ({ type: 'PLAY_CARD', cardId }));
  const cfg = state.ruleset;
  if (state.currentTrick.plays.length === 0) {
    if (seat === state.declarer && state.reveal === null && state.mode !== 'seventhCard' && !cfg.declarerMayLeadHiddenTrump) {
      const others = hand.filter(card => cardSuit(card) !== state.trumpSuit);
      return others.length > 0 ? play(others) : [{ type: 'REVEAL_TRUMP' }];
    }
    return play(hand);
  }
  const ledSuit = cardSuit(state.currentTrick.plays[0].card);
  const follow = hand.filter(card => cardSuit(card) === ledSuit);
  if (follow.length > 0) return play(follow);
  if (state.reveal !== null) {
    if (state.pendingRevealPlay?.seat === seat) {
      if (seat === state.declarer && cfg.declarerRevealPlay === 'indicatorCard') {
        return play([state.pendingRevealPlay.indicatorCard!]);
      }
      const trumps = hand.filter(card => cardSuit(card) === state.trumpSuit);
      if ((seat === state.declarer && cfg.declarerRevealPlay === 'anyTrump') ||
          (seat !== state.declarer && cfg.callerMustTrump && trumps.length > 0)) return play(trumps);
    }
    return play(hand);
  }
  const reveal: PlayAction = { type: seat === state.declarer ? 'REVEAL_TRUMP' : 'CALL_TRUMP' };
  return cfg.revealPolicy === 'mandatoryOnFirstVoid' ? [reveal] : [...play(hand), reveal];
}

export function resolveTrick(
  trick: Trick, trumpSuit: Suit, reveal: TrumpReveal | null, ruleset: RulesetConfig,
): CompletedTrick {
  if (trick.plays.length !== 4) throw new RangeError('A completed trick requires four plays');
  const ledSuit = cardSuit(trick.plays[0].card);
  const plays = trick.plays.map((play, position) => ({
    ...play,
    trumpPower: cardSuit(play.card) === trumpSuit && reveal !== null &&
      (reveal.trickIndex < trick.index || (reveal.trickIndex === trick.index &&
        (ruleset.revealTrickSemantics === 'wholeTrick' || position >= reveal.position))),
  }));
  const powered = plays.filter(play => play.trumpPower && cardSuit(play.card) !== ledSuit);
  const candidates = powered.length > 0 ? powered : plays.filter(play => cardSuit(play.card) === ledSuit);
  const winner = candidates.reduce((best, play) => cardStrength(play.card) > cardStrength(best.card) ? play : best);
  return { ...trick, plays, winner: winner.seat,
    points: plays.reduce((sum, play) => sum + cardPoints(play.card), 0) + (trick.index === 8 ? ruleset.lastTrickBonus : 0) };
}

export function applyPlayAction(state: PlayState, seat: Seat, action: PlayAction): PlayResult {
  const reject = (code: PlayError): PlayResult => ({ ok: false, state, events: [], code });
  if (state.phase !== 'PLAY') return reject('WRONG_PHASE');
  if (seat !== state.toAct) return reject('NOT_YOUR_TURN');
  const legal = legalPlayActions(state);
  if (action.type !== 'PLAY_CARD') {
    if (!legal.some(allowed => allowed.type === action.type)) return reject('REVEAL_NOT_ALLOWED');
    const result = revealTrump(state, seat);
    return { ok: true, state: result.state,
      events: action.type === 'CALL_TRUMP' ? [{ type: 'TRUMP_CALLED', seat }, ...result.events] : result.events };
  }
  if (!state.hands[seat].includes(action.cardId)) return reject('CARD_NOT_IN_HAND');
  if (!legal.some(allowed => allowed.type === 'PLAY_CARD' && allowed.cardId === action.cardId)) {
    const led = state.currentTrick.plays[0];
    if (led && state.hands[seat].some(card => cardSuit(card) === cardSuit(led.card))) return reject('MUST_FOLLOW_SUIT');
    if (!led && state.reveal === null) return reject('CANNOT_LEAD_HIDDEN_TRUMP');
    if (state.pendingRevealPlay !== null) {
      return reject(seat === state.declarer && state.ruleset.declarerRevealPlay === 'indicatorCard'
        ? 'MUST_PLAY_INDICATOR' : 'MUST_PLAY_TRUMP');
    }
    return reject('REVEAL_NOT_ALLOWED');
  }
  const currentTrick = { ...state.currentTrick, plays: [...state.currentTrick.plays, { seat, card: action.cardId }] };
  const next: PlayState = { ...state, currentTrick, pendingRevealPlay: null,
    hands: { ...state.hands, [seat]: state.hands[seat].filter(card => card !== action.cardId) },
    toAct: nextSeat(seat, state.ruleset.direction) };
  const events: PlayEvent[] = [{ type: 'CARD_PLAYED', seat, card: action.cardId,
    trickIndex: currentTrick.index, position: currentTrick.plays.length - 1 }];
  if (currentTrick.plays.length !== 4) return { ok: true, state: next, events };

  const completed = resolveTrick(currentTrick, state.trumpSuit, state.reveal, state.ruleset);
  const team = teamForSeat(completed.winner);
  events.push({ type: 'TRICK_WON', winner: completed.winner, points: completed.points, trickIndex: completed.index });
  return { ok: true, events, state: { ...next,
    // Completed cards live only in history, never in both history and current trick.
    currentTrick: { ...currentTrick, plays: [] },
    completedTricks: [...state.completedTricks, completed],
    capturedPoints: { ...state.capturedPoints, [team]: state.capturedPoints[team] + completed.points },
    toAct: null, phase: currentTrick.index === 8 ? 'COMPLETE' : 'TRICK_COMPLETE' } };
}

function revealTrump(state: PlayState, by: Seat | 'system'): { state: PlayState; events: PlayEvent[] } {
  const card = state.concealed?.card;
  const reveal: TrumpReveal = { by, trickIndex: state.currentTrick.index, position: state.currentTrick.plays.length };
  const hands = card ? { ...state.hands, [state.declarer]: [...state.hands[state.declarer], card] } : state.hands;
  return { state: { ...state, hands, concealed: null, reveal,
    pendingRevealPlay: by === 'system' || reveal.position === 0 ? null : { seat: by, indicatorCard: card ?? null } },
  events: [{ type: 'TRUMP_REVEALED', suit: state.trumpSuit, ...(card ? { card } : {}), ...reveal }] };
}

export function startNextTrick(state: PlayState): PlayResult {
  if (state.phase !== 'TRICK_COMPLETE') return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  const completed = state.completedTricks[state.completedTricks.length - 1];
  const next: PlayState = { ...state, phase: 'PLAY', toAct: completed.winner,
    currentTrick: { index: completed.index + 1, leader: completed.winner, plays: [] } };
  if (next.currentTrick.index === 8 && next.concealed !== null && next.reveal === null) {
    return { ok: true, ...revealTrump(next, 'system') };
  }
  return { ok: true, state: next, events: [] };
}

export function applyPlayTimeout(state: PlayState): PlayResult {
  if (state.phase !== 'PLAY' || state.toAct === null) return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  return applyPlayAction(state, state.toAct, weakestPlayAction(legalPlayActions(state)));
}
