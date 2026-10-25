import { z } from 'zod';
import type { RulesetConfig } from './ruleset';
import { dealOrder, partnerSeat, type Seat } from './seats';

export const auctionActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('BID'), amount: z.number().int() }),
  z.strictObject({ type: z.literal('HOLD') }),
  z.strictObject({ type: z.literal('PASS') }),
]);
export type AuctionAction = z.infer<typeof auctionActionSchema>;

export interface AuctionEntry {
  readonly seat: Seat;
  readonly action: 'BID' | 'HOLD' | 'PASS';
  readonly amount?: number;
  readonly auto: boolean;
}

export interface AuctionContract {
  readonly declarer: Seat;
  readonly contract: number;
}

export interface AuctionState {
  readonly ruleset: RulesetConfig;
  readonly order: readonly Seat[];
  readonly round: 1 | 2;
  readonly previous: AuctionContract | null;
  readonly status: 'BIDDING' | 'WON' | 'ALL_PASSED';
  readonly current: number | null;
  readonly highBidder: Seat | null;
  readonly lastBidder: Seat | null;
  readonly holder: Seat | null;
  readonly nextChallengerIndex: number;
  readonly active: readonly Seat[];
  readonly toAct: Seat | null;
  readonly history: readonly AuctionEntry[];
}

export type AuctionEvent =
  | { readonly type: 'BID_MADE' | 'BID_HELD'; readonly seat: Seat; readonly amount: number; readonly auto: boolean }
  | { readonly type: 'PASSED'; readonly seat: Seat; readonly auto: boolean }
  | { readonly type: 'AUCTION_WON'; readonly round: 1 | 2; readonly declarer: Seat;
      readonly contract: number; readonly trumpSelection: 'initial' | 'unchanged' | 'reselect' }
  | { readonly type: 'AUCTION_ALL_PASSED'; readonly policy: 'redealSameDealer' };

export type AuctionError = 'WRONG_PHASE' | 'NOT_YOUR_TURN' | 'BID_INVALID' |
  'BID_TOO_LOW' | 'HOLD_NOT_ALLOWED' | 'PARTNER_OVERBID_TOO_LOW';
export type AuctionTransition = { readonly state: AuctionState; readonly events: readonly AuctionEvent[] };
export type AuctionResult =
  | (AuctionTransition & { readonly ok: true })
  | { readonly ok: false; readonly state: AuctionState; readonly events: readonly []; readonly code: AuctionError };

type AuctionDraft = { -readonly [Key in keyof AuctionState]: AuctionState[Key] };

export function createAuction(ruleset: RulesetConfig, dealer: Seat): AuctionTransition {
  return startAuction(ruleset, dealer, null);
}

export function createSecondRoundAuction(
  ruleset: RulesetConfig, dealer: Seat, previous: AuctionContract,
): AuctionTransition {
  if (!ruleset.secondRound.enabled) throw new RangeError('Second-round bidding is disabled');
  if (!Number.isInteger(previous.contract) || previous.contract < ruleset.minBid || previous.contract > ruleset.maxBid) {
    throw new RangeError('Previous contract is outside the legal bid range');
  }
  return startAuction(ruleset, dealer, previous);
}

function startAuction(ruleset: RulesetConfig, dealer: Seat, previous: AuctionContract | null): AuctionTransition {
  const order = dealOrder(dealer, ruleset.direction);
  const state: AuctionDraft = {
    ruleset, order, previous: previous ? { ...previous } : null,
    round: previous ? 2 : 1, status: 'BIDDING',
    current: previous ? previous.contract : null,
    highBidder: previous ? previous.declarer : null,
    lastBidder: null, holder: null, nextChallengerIndex: 0,
    active: [...order], toAct: order[0], history: [],
  };
  const events: AuctionEvent[] = [];
  autoPassUnavailableBids(state, events);
  return { state, events };
}

function forcedOpening(state: AuctionState): boolean {
  return state.round === 1 && state.current === null && state.ruleset.openingBidForced;
}

function canHold(state: AuctionState): boolean {
  return state.round === 1 && state.ruleset.auctionStyle === 'priorityDuel' &&
    state.holder !== null && state.toAct === state.holder;
}

export function legalAuctionActions(state: AuctionState): readonly AuctionAction[] {
  if (state.status !== 'BIDDING' || state.toAct === null) return [];
  const cfg = state.ruleset;
  let minimum = Math.max(cfg.minBid, state.current === null ? cfg.minBid : state.current + 1);
  if (state.round === 2 && cfg.secondRound.enabled) minimum = Math.max(minimum, cfg.secondRound.minBid);
  if (cfg.partnerOverbidMin !== null && state.highBidder === partnerSeat(state.toAct)) {
    minimum = Math.max(minimum, cfg.partnerOverbidMin);
  }
  const actions: AuctionAction[] = [];
  for (let amount = minimum; amount <= cfg.maxBid; amount++) actions.push({ type: 'BID', amount });
  if (canHold(state)) actions.push({ type: 'HOLD' });
  if (!forcedOpening(state)) actions.push({ type: 'PASS' });
  return actions;
}

export function applyAuctionAction(state: AuctionState, seat: Seat, action: AuctionAction): AuctionResult {
  return applyAction(state, seat, action, false);
}

export function applyAuctionTimeout(state: AuctionState): AuctionResult {
  if (state.toAct === null) return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  const action: AuctionAction = forcedOpening(state)
    ? { type: 'BID', amount: state.ruleset.minBid } : { type: 'PASS' };
  return applyAction(state, state.toAct, action, true);
}

function applyAction(state: AuctionState, seat: Seat, action: AuctionAction, auto: boolean): AuctionResult {
  const reject = (code: AuctionError): AuctionResult => ({ ok: false, state, events: [], code });
  if (state.status !== 'BIDDING') return reject('WRONG_PHASE');
  if (seat !== state.toAct) return reject('NOT_YOUR_TURN');
  if (action.type === 'BID') {
    if (!Number.isInteger(action.amount) || action.amount < state.ruleset.minBid || action.amount > state.ruleset.maxBid) {
      return reject('BID_INVALID');
    }
    if (canHold(state) && action.amount === state.current) {
      action = { type: 'HOLD' };
    } else {
      const roundMinimum = state.round === 2 && state.ruleset.secondRound.enabled
        ? state.ruleset.secondRound.minBid : state.ruleset.minBid;
      if (action.amount < roundMinimum || (state.current !== null && action.amount <= state.current)) {
        return reject('BID_TOO_LOW');
      }
      if (state.ruleset.partnerOverbidMin !== null && state.highBidder === partnerSeat(seat) &&
          action.amount < state.ruleset.partnerOverbidMin) return reject('PARTNER_OVERBID_TOO_LOW');
    }
  }
  if (action.type === 'HOLD' && !canHold(state)) return reject('HOLD_NOT_ALLOWED');
  if (action.type === 'PASS' && forcedOpening(state)) return reject('WRONG_PHASE');

  const next = { ...state };
  const events: AuctionEvent[] = [];
  recordAction(next, seat, action, auto, events);
  autoPassUnavailableBids(next, events);
  return { ok: true, state: next, events };
}

function recordAction(state: AuctionDraft, seat: Seat, action: AuctionAction, auto: boolean, events: AuctionEvent[]): void {
  const amount = action.type === 'BID' ? action.amount : state.current;
  state.history = [...state.history, {
    seat, action: action.type, auto,
    ...(action.type === 'PASS' ? {} : { amount: amount! }),
  }];
  if (action.type === 'PASS') {
    state.active = state.active.filter(activeSeat => activeSeat !== seat);
    events.push({ type: 'PASSED', seat, auto });
  } else {
    state.current = amount;
    state.highBidder = seat;
    state.lastBidder = seat;
    events.push({ type: action.type === 'HOLD' ? 'BID_HELD' : 'BID_MADE', seat, amount: amount!, auto });
  }

  if (state.round === 1 && state.ruleset.auctionStyle === 'priorityDuel') {
    if (state.holder === null) {
      if (action.type === 'BID') state.holder = seat;
      state.nextChallengerIndex++;
    } else if (action.type === 'PASS') {
      if (seat === state.holder) state.holder = state.order[state.nextChallengerIndex];
      state.nextChallengerIndex++;
    } else {
      state.toAct = seat === state.holder ? state.order[state.nextChallengerIndex] : state.holder;
      return;
    }
    if (state.nextChallengerIndex < state.order.length) {
      state.toAct = state.order[state.nextChallengerIndex];
      return;
    }
  } else if (state.active.length > 0) {
    // Passing alone eliminates a bidder; circling past the high bidder does not.
    if (state.lastBidder === null || state.active.length > 1) {
      for (let offset = 1; offset <= state.order.length; offset++) {
        const next = state.order[(state.order.indexOf(seat) + offset) % state.order.length];
        if (state.active.includes(next) && next !== state.lastBidder) {
          state.toAct = next;
          return;
        }
      }
    }
  }
  finishAuction(state, events);
}

function autoPassUnavailableBids(state: AuctionDraft, events: AuctionEvent[]): void {
  while (state.toAct !== null && !legalAuctionActions(state).some(action => action.type !== 'PASS')) {
    recordAction(state, state.toAct, { type: 'PASS' }, true, events);
  }
}

function finishAuction(state: AuctionDraft, events: AuctionEvent[]): void {
  state.toAct = null;
  if (state.highBidder === null) {
    state.status = 'ALL_PASSED';
    events.push({ type: 'AUCTION_ALL_PASSED', policy: state.ruleset.allPassPolicy });
  } else {
    state.status = 'WON';
    events.push({
      type: 'AUCTION_WON', round: state.round, declarer: state.highBidder, contract: state.current!,
      trumpSelection: state.previous === null ? 'initial'
        : state.previous.declarer === state.highBidder ? 'unchanged' : 'reselect',
    });
  }
}
