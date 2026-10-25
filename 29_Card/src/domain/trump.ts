import { z } from 'zod';
import { cardIdSchema, cardSuit, suitSchema, type CardId, type Suit } from './cards';
import { defaultTrumpSelection } from './decision-policy';
import { dealNextPacket, type DealState } from './deal';
import type { RulesetConfig } from './ruleset';
import { dealOrder, type Seat } from './seats';

export const trumpSelectionSchema = z.union([
  z.strictObject({ cardId: cardIdSchema }),
  z.strictObject({ suit: suitSchema }),
  z.strictObject({ seventhCard: z.literal(true) }),
]);
export type TrumpSelection = z.infer<typeof trumpSelectionSchema>;

export interface TrumpState {
  readonly ruleset: RulesetConfig;
  readonly dealer: Seat;
  readonly declarer: Seat;
  readonly deal: DealState;
  readonly phase: 'TRUMP_SELECTION' | 'DEAL_2' | 'TRUMP_RESELECTION' | 'READY';
  readonly mode: 'card' | 'suit' | 'seventhCard' | null;
  readonly trumpSuit: Suit | null;
  readonly concealed: { readonly owner: Seat; readonly card: CardId | null } | null;
}

export type TrumpEvent =
  | { readonly type: 'TRUMP_SELECTED'; readonly audience: 'all'; readonly declarer: Seat }
  | { readonly type: 'TRUMP_DETAILS'; readonly audience: Seat; readonly suit: Suit; readonly card?: CardId }
  | { readonly type: 'CARDS_DEALT'; readonly audience: Seat; readonly phase: 2; readonly cards: readonly CardId[] }
  | { readonly type: 'CARD_RETURNED'; readonly audience: Seat; readonly card: CardId };
export type TrumpTransition = { readonly state: TrumpState; readonly events: readonly TrumpEvent[] };
export type TrumpResult =
  | (TrumpTransition & { readonly ok: true })
  | { readonly ok: false; readonly state: TrumpState; readonly events: readonly [];
      readonly code: 'WRONG_PHASE' | 'NOT_YOUR_TURN' | 'TRUMP_SELECTION_INVALID' };

export function createTrumpSelection(
  ruleset: RulesetConfig, dealer: Seat, declarer: Seat, deal: DealState,
): TrumpState {
  if (deal.dealtCount !== 16) throw new RangeError('Trump selection requires the first packet only');
  return { ruleset, dealer, declarer, deal, phase: 'TRUMP_SELECTION', mode: null, trumpSuit: null, concealed: null };
}

export function selectTrump(state: TrumpState, seat: Seat, selection: TrumpSelection): TrumpResult {
  const reject = (code: 'WRONG_PHASE' | 'NOT_YOUR_TURN' | 'TRUMP_SELECTION_INVALID'): TrumpResult =>
    ({ ok: false, state, events: [], code });
  if (state.phase !== 'TRUMP_SELECTION' && state.phase !== 'TRUMP_RESELECTION') return reject('WRONG_PHASE');
  if (seat !== state.declarer) return reject('NOT_YOUR_TURN');

  let mode: TrumpState['mode'];
  let suit: Suit | null;
  let concealed: TrumpState['concealed'] = null;
  let deal = state.deal;
  if ('seventhCard' in selection) {
    if (!state.ruleset.seventhCardTrump || state.phase === 'TRUMP_RESELECTION') return reject('TRUMP_SELECTION_INVALID');
    mode = 'seventhCard';
    suit = null;
    concealed = { owner: seat, card: null };
  } else if ('cardId' in selection) {
    if (state.ruleset.trumpIndicator !== 'faceDownCard' || !deal.hands[seat].includes(selection.cardId)) {
      return reject('TRUMP_SELECTION_INVALID');
    }
    mode = 'card';
    suit = cardSuit(selection.cardId);
    concealed = { owner: seat, card: selection.cardId };
    deal = { ...deal, hands: { ...deal.hands, [seat]: deal.hands[seat].filter(card => card !== selection.cardId) } };
  } else {
    if (state.ruleset.trumpIndicator !== 'external') return reject('TRUMP_SELECTION_INVALID');
    mode = 'suit';
    suit = selection.suit;
  }
  const events: TrumpEvent[] = [{ type: 'TRUMP_SELECTED', audience: 'all', declarer: seat }];
  if (suit !== null) events.push({
    type: 'TRUMP_DETAILS', audience: seat, suit,
    ...(concealed?.card ? { card: concealed.card } : {}),
  });
  return {
    ok: true, events,
    state: { ...state, deal, mode, trumpSuit: suit, concealed,
      phase: state.phase === 'TRUMP_RESELECTION' ? 'READY' : 'DEAL_2' },
  };
}

export function dealRemainingCards(state: TrumpState): TrumpResult {
  if (state.phase !== 'DEAL_2') return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  let deal = dealNextPacket(state.deal, state.dealer, state.ruleset.direction);
  let concealed = state.concealed;
  let trumpSuit = state.trumpSuit;
  if (state.mode === 'seventhCard') {
    const card = deal.hands[state.declarer][6];
    concealed = { owner: state.declarer, card };
    trumpSuit = cardSuit(card);
    deal = { ...deal, hands: { ...deal.hands,
      [state.declarer]: deal.hands[state.declarer].filter(held => held !== card) } };
  }
  const events: TrumpEvent[] = dealOrder(state.dealer, state.ruleset.direction).map((seat, index) => ({
    type: 'CARDS_DEALT', audience: seat, phase: 2,
    cards: deal.deck.slice(16 + index * 4, 20 + index * 4).filter(card => card !== concealed?.card),
  }));
  return { ok: true, state: { ...state, deal, concealed, trumpSuit, phase: 'READY' }, events };
}

export function beginTrumpReselection(state: TrumpState, declarer: Seat): TrumpResult {
  if (state.phase !== 'READY' || !state.ruleset.secondRound.enabled) {
    return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  }
  if (declarer === state.declarer) return { ok: false, state, events: [], code: 'TRUMP_SELECTION_INVALID' };
  const concealed = state.concealed!;
  const card = concealed.card!;
  const deal = { ...state.deal, hands: { ...state.deal.hands,
    [concealed.owner]: [...state.deal.hands[concealed.owner], card] } };
  return {
    ok: true,
    state: { ...state, declarer, deal, mode: null, trumpSuit: null, concealed: null, phase: 'TRUMP_RESELECTION' },
    events: [{ type: 'CARD_RETURNED', audience: concealed.owner, card }],
  };
}

export function trumpKnowledge(state: TrumpState, viewer: Seat | 'spectator'): { trumpSuit?: Suit; myConcealedCard?: CardId } {
  if (viewer !== state.declarer || state.mode === 'seventhCard' || state.trumpSuit === null) return {};
  return { trumpSuit: state.trumpSuit, ...(state.concealed?.card ? { myConcealedCard: state.concealed.card } : {}) };
}

export function applyTrumpSelectionTimeout(state: TrumpState): TrumpResult {
  if (state.phase !== 'TRUMP_SELECTION' && state.phase !== 'TRUMP_RESELECTION') {
    return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  }
  return selectTrump(state, state.declarer,
    defaultTrumpSelection(state.deal.hands[state.declarer], state.ruleset.trumpIndicator));
}
