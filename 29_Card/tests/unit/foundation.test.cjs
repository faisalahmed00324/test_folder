const { describe, test, expect } = require('@jest/globals');
const { createDeck, deckSchema, cardIdSchema, cardSuit, cardStrength, cardPoints } = require('../../src/domain/cards.ts');
const { nextSeat, partnerSeat, teamForSeat, dealOrder } = require('../../src/domain/seats.ts');
const { createDeal, dealNextPacket } = require('../../src/domain/deal.ts');

describe('cards (T01, T02 foundation)', () => {
  test('creates every unique card with 28 points and correct ranks in each suit', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(32);
    expect(new Set(deck).size).toBe(32);
    expect(deck.reduce((sum, card) => sum + cardPoints(card), 0)).toBe(28);
    for (const suit of ['C', 'D', 'H', 'S']) {
      const cards = deck.filter(card => cardSuit(card) === suit);
      expect(cards).toHaveLength(8);
      expect(cards.map(cardStrength)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
      expect(cards.map(cardPoints)).toEqual([3, 2, 1, 1, 0, 0, 0, 0]);
    }
  });

  test.each(['10H', '1S', 'jS', 'JC ', '', null, 42])('rejects invalid card %p', card => {
    expect(cardIdSchema.safeParse(card).success).toBe(false);
  });

  test('validates complete decks and creates independent immutable arrays', () => {
    const deck = createDeck();
    for (const cards of [deck.slice(1), [...deck, 'JS'], Array(32).fill('JS'), [...deck.slice(1), 'bad']]) {
      expect(deckSchema.safeParse(cards).success).toBe(false);
    }
    expect(Object.isFrozen(deck)).toBe(true);
    expect(createDeck()).not.toBe(deck);
  });
});

describe('seats (T03)', () => {
  test.each([
    ['clockwise', [1, 2, 3, 0]],
    ['counterclockwise', [3, 2, 1, 0]],
  ])('%s cycles and starts dealing with eldest', (direction, expected) => {
    expect(dealOrder(0, direction)).toEqual(expected);
    let seat = 0;
    for (const next of expected) {
      seat = nextSeat(seat, direction);
      expect(seat).toBe(next);
    }
  });

  test.each([0, 1, 2, 3])('partners sit opposite seat %s and share a team', seat => {
    expect(partnerSeat(partnerSeat(seat))).toBe(seat);
    expect(partnerSeat(seat)).not.toBe(seat);
    expect(teamForSeat(partnerSeat(seat))).toBe(teamForSeat(seat));
    expect(teamForSeat(seat)).toBe(seat % 2 === 0 ? 'A' : 'B');
  });
});

describe('deterministic two-packet dealing', () => {
  test.each(['clockwise', 'counterclockwise'])('%s preserves deck order and card ownership', direction => {
    for (const dealer of [0, 1, 2, 3]) {
      const deck = createDeck();
      const initial = createDeal(deck);
      const first = dealNextPacket(initial, dealer, direction);
      const second = dealNextPacket(first, dealer, direction);
      expect(initial.dealtCount).toBe(0);
      expect(Object.values(initial.hands).flat()).toEqual([]);
      expect(first.dealtCount).toBe(16);
      expect(second.dealtCount).toBe(32);
      for (const [index, seat] of dealOrder(dealer, direction).entries()) {
        expect(first.hands[seat]).toEqual(deck.slice(index * 4, index * 4 + 4));
        expect(second.hands[seat]).toEqual([
          ...deck.slice(index * 4, index * 4 + 4),
          ...deck.slice(16 + index * 4, 20 + index * 4),
        ]);
        expect(second.hands[seat][6]).toBe(deck[18 + index * 4]);
      }
      expect(new Set(Object.values(second.hands).flat()).size).toBe(32);
      expect(new Set([...Object.values(first.hands).flat(), ...deck.slice(first.dealtCount)]).size).toBe(32);
      expect(deck).toEqual(createDeck());
      expect(dealNextPacket(initial, dealer, direction)).toEqual(first);
      expect(() => dealNextPacket(second, dealer, direction)).toThrow(RangeError);
    }
  });

  test('uses an injected deck without shuffling', () => {
    const deck = deckSchema.parse([...createDeck()].reverse());
    const first = dealNextPacket(createDeal(deck), 0, 'counterclockwise');
    expect(first.hands[3]).toEqual(deck.slice(0, 4));
    expect(first.deck).toBe(deck);
  });
});
