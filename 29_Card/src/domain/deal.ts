import type { CardId, Deck } from './cards';
import { dealOrder, type Direction, type Seat } from './seats';

export interface DealState {
  readonly deck: Deck;
  readonly dealtCount: 0 | 16 | 32;
  readonly hands: Readonly<Record<Seat, readonly CardId[]>>;
}

export function createDeal(deck: Deck): DealState {
  return { deck, dealtCount: 0, hands: { 0: [], 1: [], 2: [], 3: [] } };
}

export function dealNextPacket(state: DealState, dealer: Seat, direction: Direction): DealState {
  if (state.dealtCount === 32) throw new RangeError('Both packets have already been dealt');

  const hands = { ...state.hands };
  for (const [index, seat] of dealOrder(dealer, direction).entries()) {
    const offset = state.dealtCount + index * 4;
    hands[seat] = [...state.hands[seat], ...state.deck.slice(offset, offset + 4)];
  }
  return { deck: state.deck, dealtCount: state.dealtCount === 0 ? 16 : 32, hands };
}
