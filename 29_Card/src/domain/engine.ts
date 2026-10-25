import { z } from 'zod';
import { auctionActionSchema, applyAuctionAction, applyAuctionTimeout, createAuction, createSecondRoundAuction,
  legalAuctionActions, type AuctionState, type AuctionEvent } from './auction';
import { cardPoints, deckSchema, type CardId } from './cards';
import { doublingActionSchema, applyDoublingAction, applyDoublingTimeout, createDoubling,
  legalDoublingActions, type DoublingState, type DoublingEvent } from './doubling';
import { abandonMatch, closeRedealWindow, createMatchProgress, requestRedeal, scoreMatchHand,
  startMatchDeal, voidMatchDeal, type MatchProgress, type MatchEvent } from './match';
import { applyPairDeclaration, canDeclarePair, closePairWindow, createHandContract, openPairWindow,
  type HandContract, type PairWindow, type PairEvent } from './pair';
import { applyPlayAction, applyPlayTimeout, createPlayState, legalPlayActions, playActionSchema,
  startNextTrick, type PlayState, type PlayEvent } from './play';
import type { RulesetConfig } from './ruleset';
import type { HandSummary } from './scoring';
import { seatSchema, type Seat } from './seats';
import { applyTrumpSelectionTimeout, beginTrumpReselection, createTrumpSelection, dealRemainingCards,
  selectTrump, trumpKnowledge, trumpSelectionSchema, type TrumpState, type TrumpEvent } from './trump';
import { assertEngineInvariants } from './invariants';

export const engineActionSchema = z.union([
  auctionActionSchema, doublingActionSchema, playActionSchema,
  z.strictObject({ type: z.literal('SELECT_TRUMP'), payload: trumpSelectionSchema }),
  z.strictObject({ type: z.literal('DECLARE_PAIR') }),
  z.strictObject({ type: z.literal('REQUEST_REDEAL') }),
  z.strictObject({ type: z.literal('START_DEAL'), deck: deckSchema }),
  z.strictObject({ type: z.literal('TIMEOUT'), decisionVersion: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal('VOID_DEAL') }),
  z.strictObject({ type: z.literal('ABANDON') }),
  z.strictObject({ type: z.literal('SET_BOT'), seat: seatSchema, isBot: z.boolean() }),
]);
export const engineInputSchema = z.strictObject({
  actor: z.union([seatSchema, z.literal('system')]),
  now: z.number().finite().nonnegative(),
  expectedVersion: z.number().int().nonnegative(),
  action: engineActionSchema,
});
export type EngineInput = z.infer<typeof engineInputSchema>;
export type EngineAction = z.infer<typeof engineActionSchema>;
export type Viewer = Seat | 'spectator';
const pairPreferenceSchema = z.strictObject({
  autoDeclarePair: z.boolean().default(true), isBot: z.boolean().default(false),
}).default({ autoDeclarePair: true, isBot: false });
export const engineSettingsSchema = z.strictObject({
  redealWindowMs: z.number().int().positive().default(3000),
  trickHistoryVisibility: z.enum(['all', 'lastTrick']).default('all'),
  showCapturedPoints: z.boolean().default(true),
  preferences: z.tuple([pairPreferenceSchema, pairPreferenceSchema, pairPreferenceSchema, pairPreferenceSchema])
    .default([{ autoDeclarePair: true, isBot: false }, { autoDeclarePair: true, isBot: false },
      { autoDeclarePair: true, isBot: false }, { autoDeclarePair: true, isBot: false }]),
});
export type EngineSettings = z.infer<typeof engineSettingsSchema>;
export interface EngineState {
  readonly version: number;
  readonly lastCommandTime: number;
  readonly progress: MatchProgress;
  readonly settings: EngineSettings;
  readonly phase: 'AWAITING_DEAL' | 'REDEAL_WINDOW' | 'AUCTION' | 'SECOND_ROUND' | 'TRUMP_SELECTION' |
    'TRUMP_RESELECTION' | 'DOUBLING' | 'PLAY' | 'PAIR_WINDOW' | 'FINISHED' | 'ABANDONED';
  readonly auction: AuctionState | null;
  readonly trump: TrumpState | null;
  readonly doubling: DoublingState | null;
  readonly play: PlayState | null;
  readonly pairWindow: PairWindow | null;
  readonly contract: HandContract | null;
  readonly summary: HandSummary | null;
}
type DomainEvent = AuctionEvent | DoublingEvent | PlayEvent | PairEvent | MatchEvent | TrumpEvent |
  { readonly type: 'CARDS_DEALT'; readonly phase: 1; readonly cards: readonly CardId[] } |
  { readonly type: 'TURN'; readonly seat: Seat | null } |
  { readonly type: 'LEGAL_ACTIONS'; readonly actions: readonly EngineAction[] };
export interface EngineEvent {
  readonly audience: 'all' | Seat;
  readonly event: DomainEvent;
}
export type EngineResult =
  | { readonly ok: true; readonly state: EngineState; readonly events: readonly EngineEvent[] }
  | { readonly ok: false; readonly state: EngineState; readonly events: readonly []; readonly code: string };
type Draft = { -readonly [Key in keyof EngineState]: EngineState[Key] };

export function createEngine(ruleset: RulesetConfig, dealer: Seat, settings: unknown = {}): EngineState {
  const parsed = engineSettingsSchema.parse(settings);
  const state: EngineState = { version: 0, lastCommandTime: 0, progress: createMatchProgress(ruleset, dealer),
    settings: Object.freeze({ ...parsed, preferences: Object.freeze(parsed.preferences.map(pref => Object.freeze(pref))) as EngineSettings['preferences'] }),
    phase: 'AWAITING_DEAL', auction: null, trump: null, doubling: null, play: null,
    pairWindow: null, contract: null, summary: null };
  assertEngineInvariants(state);
  return state;
}

export function engineToAct(state: EngineState): Seat | null {
  switch (state.phase) {
    case 'AUCTION': case 'SECOND_ROUND': return state.auction!.toAct;
    case 'TRUMP_SELECTION': case 'TRUMP_RESELECTION': return state.trump!.declarer;
    case 'DOUBLING': return state.doubling!.toAct;
    case 'PLAY': return state.play!.toAct;
    default: return null;
  }
}

export function engineLegalActions(state: EngineState, viewer: Viewer): readonly EngineAction[] {
  if (viewer === 'spectator') return [];
  if (state.phase === 'REDEAL_WINDOW') {
    return state.progress.firstPacket!.hands[viewer].every(card => cardPoints(card) === 0) ? [{ type: 'REQUEST_REDEAL' }] : [];
  }
  if (state.phase === 'PAIR_WINDOW') {
    return canDeclarePair(state.play!, state.contract!, viewer) ? [{ type: 'DECLARE_PAIR' }] : [];
  }
  if (viewer !== engineToAct(state)) return [];
  switch (state.phase) {
    case 'AUCTION': case 'SECOND_ROUND': return legalAuctionActions(state.auction!);
    case 'DOUBLING': return legalDoublingActions(state.doubling!);
    case 'PLAY': return legalPlayActions(state.play!);
    case 'TRUMP_SELECTION': case 'TRUMP_RESELECTION': {
      const trump = state.trump!;
      const actions: EngineAction[] = trump.ruleset.trumpIndicator === 'external'
        ? (['C', 'D', 'H', 'S'] as const).map(suit => ({ type: 'SELECT_TRUMP', payload: { suit } }))
        : trump.deal.hands[viewer].map(cardId => ({ type: 'SELECT_TRUMP', payload: { cardId } }));
      if (trump.ruleset.seventhCardTrump && state.phase === 'TRUMP_SELECTION') actions.push({ type: 'SELECT_TRUMP', payload: { seventhCard: true } });
      return actions;
    }
    default: return [];
  }
}

// This boundary receives server-derived actors; it is not an authentication API.
export function applyEngineInput(state: EngineState, input: unknown): EngineResult {
  const parsed = engineInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, state, events: [], code: 'INVALID_COMMAND' };
  return applyEngineCommand(state, parsed.data);
}

export function applyEngineCommand(state: EngineState, input: EngineInput): EngineResult {
  const reject = (code: string): EngineResult => ({ ok: false, state, events: [], code });
  if (input.expectedVersion !== state.version) return reject('STALE_STATE');
  if (state.progress.status !== 'IN_PROGRESS') return reject('MATCH_OVER');
  if (!Number.isFinite(input.now) || input.now < state.lastCommandTime) return reject('INVALID_TIME');
  const { actor, action, now } = input;
  const internal = ['START_DEAL', 'TIMEOUT', 'VOID_DEAL', 'ABANDON', 'SET_BOT'].includes(action.type);
  if (internal !== (actor === 'system')) return reject('UNAUTHORIZED');
  if (action.type === 'TIMEOUT' && action.decisionVersion !== state.version) return reject('STALE_STATE');
  const next: Draft = { ...state };
  const events: EngineEvent[] = [];
  const emit = (entries: readonly DomainEvent[]) => events.push(...entries.map(event => ({ audience: 'all' as const, event })));
  const emitTrump = (entries: readonly TrumpEvent[]) => {
    for (const { audience, ...event } of entries) events.push({ audience, event: event as TrumpEvent });
  };
  const clearHand = () => {
    next.auction = null; next.trump = null; next.doubling = null; next.play = null;
    next.pairWindow = null; next.contract = null;
    next.phase = next.progress.status === 'IN_PROGRESS' ? 'AWAITING_DEAL' : next.progress.status;
  };
  let error: string | null = null;
  if (action.type === 'SET_BOT') {
    const preferences = [...state.settings.preferences] as EngineSettings['preferences'];
    preferences[action.seat] = Object.freeze({ ...preferences[action.seat], isBot: action.isBot });
    Object.freeze(preferences);
    next.settings = Object.freeze({ ...state.settings, preferences });
  } else if (action.type === 'START_DEAL') {
    const result = startMatchDeal(state.progress, action.deck, now, state.settings.redealWindowMs);
    if (!result.ok) return reject(result.code);
    next.progress = result.state; next.summary = null; emit(result.events);
    for (const seat of [0, 1, 2, 3] as const) events.push({ audience: seat,
      event: { type: 'CARDS_DEALT', phase: 1, cards: result.state.firstPacket!.hands[seat] } });
    if (next.progress.phase === 'REDEAL_WINDOW') next.phase = 'REDEAL_WINDOW';
    else { next.auction = createAuction(next.progress.ruleset, next.progress.dealer).state; next.phase = 'AUCTION'; }
  } else if (action.type === 'VOID_DEAL' || action.type === 'ABANDON' || action.type === 'REQUEST_REDEAL') {
    const result = action.type === 'VOID_DEAL' ? voidMatchDeal(state.progress, 'serverFault')
      : action.type === 'ABANDON' ? abandonMatch(state.progress) : requestRedeal(state.progress, actor as Seat, now);
    if (!result.ok) return reject(result.code);
    next.progress = result.state; emit(result.events); clearHand();
  } else if (state.phase === 'REDEAL_WINDOW' && action.type === 'TIMEOUT') {
    const result = closeRedealWindow(state.progress, now);
    if (!result.ok) return reject(result.code);
    next.progress = result.state;
    next.auction = createAuction(next.progress.ruleset, next.progress.dealer).state; next.phase = 'AUCTION';
  } else if ((state.phase === 'AUCTION' || state.phase === 'SECOND_ROUND') &&
      (action.type === 'BID' || action.type === 'HOLD' || action.type === 'PASS' || action.type === 'TIMEOUT')) {
    const result = action.type === 'TIMEOUT' ? applyAuctionTimeout(state.auction!) : applyAuctionAction(state.auction!, actor as Seat, action);
    if (!result.ok) return reject(result.code);
    next.auction = result.state; emit(result.events);
  } else if ((state.phase === 'TRUMP_SELECTION' || state.phase === 'TRUMP_RESELECTION') &&
      (action.type === 'SELECT_TRUMP' || action.type === 'TIMEOUT')) {
    const result = action.type === 'TIMEOUT' ? applyTrumpSelectionTimeout(state.trump!) : selectTrump(state.trump!, actor as Seat, action.payload);
    if (!result.ok) return reject(result.code);
    next.trump = result.state; emitTrump(result.events);
  } else if (state.phase === 'DOUBLING' &&
      (action.type === 'DOUBLE' || action.type === 'REDOUBLE' || action.type === 'PASS_DOUBLE' || action.type === 'TIMEOUT')) {
    const result = action.type === 'TIMEOUT' ? applyDoublingTimeout(state.doubling!) : applyDoublingAction(state.doubling!, actor as Seat, action);
    if (!result.ok) return reject(result.code);
    next.doubling = result.state; emit(result.events);
  } else if (state.phase === 'PLAY' &&
      (action.type === 'PLAY_CARD' || action.type === 'CALL_TRUMP' || action.type === 'REVEAL_TRUMP' || action.type === 'TIMEOUT')) {
    let result = action.type === 'TIMEOUT' ? applyPlayTimeout(state.play!) : applyPlayAction(state.play!, actor as Seat, action);
    if (!result.ok) return reject(result.code);
    emit(result.events); next.play = result.state;
    // An expired revealer gets the required play, not another timed decision.
    if (action.type === 'TIMEOUT' && result.state.phase === 'PLAY' && result.state.toAct === state.play!.toAct) {
      result = applyPlayTimeout(result.state);
      if (!result.ok) throw new Error('Timeout reveal has no legal follow-up');
      emit(result.events); next.play = result.state;
    }
  } else if (state.phase === 'PAIR_WINDOW' && (action.type === 'DECLARE_PAIR' || action.type === 'TIMEOUT')) {
    const result = action.type === 'TIMEOUT' ? closePairWindow(state.pairWindow!, now) : applyPairDeclaration(state.pairWindow!, actor as Seat, now);
    if (!result.ok) return reject(result.code);
    next.pairWindow = result.state; next.contract = result.state.contract; emit(result.events);
  } else error = 'WRONG_PHASE';
  if (error !== null) return reject(error);

  // Drain automatic phases until the next player decision or fixed window.
  for (;;) {
    if ((next.phase === 'AUCTION' || next.phase === 'SECOND_ROUND') && next.auction!.status !== 'BIDDING') {
      const auction = next.auction!;
      if (auction.status === 'ALL_PASSED') {
        const result = voidMatchDeal(next.progress, 'allPass');
        if (!result.ok) throw new Error('All-pass redeal failed');
        next.progress = result.state; emit(result.events); clearHand(); break;
      }
      next.contract = createHandContract(next.progress.ruleset, auction.current!);
      if (next.phase === 'AUCTION') {
        next.trump = createTrumpSelection(next.progress.ruleset, next.progress.dealer, auction.highBidder!, next.progress.firstPacket!);
        next.phase = 'TRUMP_SELECTION'; break;
      }
      if (auction.highBidder !== next.trump!.declarer) {
        const result = beginTrumpReselection(next.trump!, auction.highBidder!);
        if (!result.ok) throw new Error('Trump reselection failed');
        next.trump = result.state; emitTrump(result.events); next.phase = 'TRUMP_RESELECTION'; break;
      }
      next.phase = 'TRUMP_RESELECTION'; // READY skips directly to post-auction setup.
    }
    if ((next.phase === 'TRUMP_SELECTION' || next.phase === 'TRUMP_RESELECTION') &&
        (next.trump!.phase === 'DEAL_2' || next.trump!.phase === 'READY')) {
      const cfg = next.progress.ruleset;
      if (next.trump!.phase === 'DEAL_2') {
        if (cfg.doubling.enabled && cfg.doubling.timing === 'beforeSecondDeal' && next.doubling === null) {
          next.doubling = createDoubling(cfg, next.trump!.declarer); next.phase = 'DOUBLING'; break;
        }
        const result = dealRemainingCards(next.trump!);
        if (!result.ok) throw new Error('Second deal failed');
        next.trump = result.state; emitTrump(result.events);
        if (cfg.secondRound.enabled) {
          const result = createSecondRoundAuction(cfg, next.progress.dealer,
            { declarer: next.trump.declarer, contract: next.contract!.originalContract });
          next.auction = result.state; emit(result.events); next.phase = 'SECOND_ROUND'; continue;
        }
      }
      if (cfg.doubling.enabled && next.doubling === null) {
        next.doubling = createDoubling(cfg, next.trump!.declarer); next.phase = 'DOUBLING'; break;
      }
      next.play = createPlayState(next.trump!); next.phase = 'PLAY'; break;
    }
    if (next.phase === 'DOUBLING' && next.doubling!.stage === 'DONE') {
      next.phase = 'TRUMP_SELECTION'; continue;
    }
    if (next.phase === 'PLAY' && next.play!.phase === 'TRICK_COMPLETE') {
      const result = openPairWindow(next.play!, next.contract!, next.settings.preferences, now);
      next.pairWindow = result.state; next.contract = result.state.contract; emit(result.events);
      if (result.state.status === 'OPEN') { next.phase = 'PAIR_WINDOW'; break; }
      const resumed = startNextTrick(next.play!);
      if (!resumed.ok) throw new Error('Next trick failed');
      next.play = resumed.state; next.pairWindow = null; emit(resumed.events); break;
    }
    if (next.phase === 'PAIR_WINDOW' && next.pairWindow!.status === 'CLOSED') {
      const result = startNextTrick(next.play!);
      if (!result.ok) throw new Error('Pair continuation failed');
      next.play = result.state; next.pairWindow = null; next.phase = 'PLAY'; emit(result.events); break;
    }
    if (next.phase === 'PLAY' && next.play!.phase === 'COMPLETE') {
      const result = scoreMatchHand(next.progress, next.progress.dealNumber, next.play!, next.contract!, next.doubling?.stakeMultiplier ?? 1);
      if (!result.ok) throw new Error('Hand scoring failed');
      next.progress = result.state; emit(result.events);
      next.summary = (result.events[0] as Extract<MatchEvent, { type: 'HAND_SCORED' }>).summary;
      clearHand(); break;
    }
    break;
  }
  next.version++; next.lastCommandTime = now;
  assertEngineInvariants(next);
  const toAct = engineToAct(next);
  if (toAct !== null && engineLegalActions(next, toAct).length === 0) throw new Error('Actor has no legal action');
  events.push({ audience: 'all', event: { type: 'TURN', seat: engineToAct(next) } });
  for (const seat of [0, 1, 2, 3] as const) {
    const actions = engineLegalActions(next, seat);
    if (actions.length > 0) events.push({ audience: seat, event: { type: 'LEGAL_ACTIONS', actions } });
  }
  return { ok: true, state: next, events };
}

export function engineView(state: EngineState, viewer: Viewer) {
  const play = state.play;
  const trump = state.trump;
  const hands = play?.hands ?? trump?.deal.hands ?? state.progress.firstPacket?.hands;
  const concealed = play ? play.concealed : trump?.concealed;
  const history = play?.completedTricks ?? [];
  const visible = state.settings.trickHistoryVisibility === 'all' ? history : history.slice(-1);
  return structuredClone({
    viewer, version: state.version, phase: state.phase, status: state.progress.status,
    ruleset: state.progress.ruleset, dealer: state.progress.dealer, handNumber: state.progress.handNumber,
    dealNumber: state.progress.dealNumber, gameScores: state.progress.gameScores, winner: state.progress.winner,
    myHand: viewer === 'spectator' ? [] : hands?.[viewer] ?? [],
    handCounts: Object.fromEntries(([0, 1, 2, 3] as const).map(seat => [seat, hands?.[seat].length ?? 0])),
    concealedOwner: concealed?.owner ?? null,
    ...(play?.reveal ? { trumpSuit: play.trumpSuit } : trump ? trumpKnowledge(trump, viewer) : {}),
    declarer: play?.declarer ?? trump?.declarer ?? null,
    contract: state.contract, stakeMultiplier: state.doubling?.stakeMultiplier ?? 1,
    auction: state.auction ? { round: state.auction.round, current: state.auction.current,
      holder: state.auction.holder, highBidder: state.auction.highBidder, history: state.auction.history } : null,
    toAct: engineToAct(state), legalActions: engineLegalActions(state, viewer),
    deadline: state.pairWindow?.deadline ?? state.progress.redealDeadline,
    currentTrick: play?.currentTrick ?? null,
    completedTricks: visible.map(trick => ({ index: trick.index, leader: trick.leader,
      plays: trick.plays.map(({ seat, card }) => ({ seat, card })), winner: trick.winner,
      ...(state.settings.showCapturedPoints ? { points: trick.points } : {}) })),
    ...(state.settings.showCapturedPoints && play ? { capturedPoints: play.capturedPoints } : {}),
    reveal: play?.reveal ?? null, summary: state.summary,
  });
}

export function recipientEvents(
  events: readonly EngineEvent[], viewer: Viewer, version: number, lastSeq = 0,
  showCapturedPoints = true,
) {
  let seq = lastSeq;
  return events.filter(entry => entry.audience === 'all' || entry.audience === viewer)
    .map(({ event }) => {
      if (!showCapturedPoints && event.type === 'TRICK_WON') {
        const { points: _points, ...publicEvent } = event;
        return structuredClone({ version, seq: ++seq, event: publicEvent });
      }
      return structuredClone({ version, seq: ++seq, event });
    });
}

export function replayEngine(initial: EngineState, inputs: readonly unknown[]) {
  let state = initial;
  const events: EngineEvent[] = [];
  for (const input of inputs) {
    const result = applyEngineInput(state, input);
    if (!result.ok) throw new Error(`Replay rejected: ${result.code}`);
    state = result.state; events.push(...result.events);
  }
  return { state, events };
}
