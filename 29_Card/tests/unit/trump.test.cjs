const { describe, test, expect } = require('@jest/globals');
const { createDeck, deckSchema } = require('../../src/domain/cards.ts');
const { createDeal, dealNextPacket } = require('../../src/domain/deal.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { rulesetSchema } = require('../../src/domain/ruleset.ts');
const { dealOrder } = require('../../src/domain/seats.ts');
const {
  trumpSelectionSchema, createTrumpSelection, selectTrump, dealRemainingCards,
  beginTrumpReselection, trumpKnowledge, applyTrumpSelectionTimeout,
} = require('../../src/domain/trump.ts');

function initial(name = '29-standard', declarer = 3, cfg = PRESETS[name], firstFour) {
  const deck = firstFour ? deckSchema.parse([...firstFour, ...createDeck().filter(card => !firstFour.includes(card))]) : createDeck();
  const deal = dealNextPacket(createDeal(deck), 0, cfg.direction);
  return createTrumpSelection(cfg, 0, declarer, deal);
}

function transition(state, run) {
  const before = structuredClone(state);
  const result = run();
  expect(state).toEqual(before);
  expect(result.ok).toBe(true);
  return result;
}

function reject(state, run, code) {
  const before = structuredClone(state);
  const result = run();
  expect(result).toEqual({ ok: false, state, events: [], code });
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}

function expectConserved(state) {
  const cards = [...Object.values(state.deal.hands).flat(),
    ...state.deal.deck.slice(state.deal.dealtCount), ...(state.concealed?.card ? [state.concealed.card] : [])];
  expect(cards).toHaveLength(32);
  expect(new Set(cards).size).toBe(32);
}

describe('trump selection boundary', () => {
  test.each([{ cardId: 'JS' }, { suit: 'H' }, { seventhCard: true }])('accepts %p', payload => {
    expect(trumpSelectionSchema.safeParse(payload).success).toBe(true);
  });
  test.each([{}, null, { suit: 'X' }, { cardId: '10S' }, { seventhCard: false },
    { suit: 'H', cardId: 'JH' }, { seventhCard: true, suit: 'H' }])('rejects %p', payload => {
    expect(trumpSelectionSchema.safeParse(payload).success).toBe(false);
  });
});

describe('face-down trump (T17 card transitions)', () => {
  test.each(['29-standard', '28-standard'])('%s removes indicator and deals seven accessible cards', name => {
    const state = initial(name);
    const card = state.deal.hands[3][0];
    const selected = transition(state, () => selectTrump(state, 3, { cardId: card }));
    expect(selected.state.deal.hands[3]).toHaveLength(3);
    expect(selected.state.concealed).toEqual({ owner: 3, card });
    expect(selected.events).toEqual([
      { type: 'TRUMP_SELECTED', audience: 'all', declarer: 3 },
      { type: 'TRUMP_DETAILS', audience: 3, suit: 'C', card },
    ]);
    expect(trumpKnowledge(selected.state, 3)).toEqual({ trumpSuit: 'C', myConcealedCard: card });
    for (const viewer of [0, 1, 2, 'spectator']) expect(trumpKnowledge(selected.state, viewer)).toEqual({});
    expectConserved(selected.state);
    const dealt = transition(selected.state, () => dealRemainingCards(selected.state));
    expect(dealt.state.deal.hands[3]).toHaveLength(7);
    for (const seat of [0, 1, 2]) expect(dealt.state.deal.hands[seat]).toHaveLength(8);
    expectConserved(dealt.state);
    expect(dealt.events).toHaveLength(4);
    for (const event of dealt.events) {
      expect(event.cards).toHaveLength(4);
      expect(event.cards.every(card => dealt.state.deal.hands[event.audience].includes(card))).toBe(true);
    }
  });

  test('rejects invalid decisions without changing state', () => {
    const state = initial();
    reject(state, () => selectTrump(state, 0, { cardId: 'JC' }), 'NOT_YOUR_TURN');
    reject(state, () => selectTrump(state, 3, { cardId: 'JS' }), 'TRUMP_SELECTION_INVALID');
    reject(state, () => selectTrump(state, 3, { suit: 'C' }), 'TRUMP_SELECTION_INVALID');
    reject(state, () => selectTrump(state, 3, { seventhCard: true }), 'TRUMP_SELECTION_INVALID');
    reject(state, () => dealRemainingCards(state), 'WRONG_PHASE');
    const selected = selectTrump(state, 3, { cardId: 'JC' }).state;
    reject(selected, () => selectTrump(selected, 3, { cardId: '9C' }), 'WRONG_PHASE');
    reject(selected, () => applyTrumpSelectionTimeout(selected), 'WRONG_PHASE');
    const full = dealRemainingCards(selected).state;
    reject(full, () => dealRemainingCards(full), 'WRONG_PHASE');
    reject(full, () => beginTrumpReselection(full, 0), 'WRONG_PHASE');
  });

  test('initial selection cannot start before or after the first packet', () => {
    const empty = createDeal(createDeck());
    expect(() => createTrumpSelection(PRESETS['29-standard'], 0, 3, empty)).toThrow(RangeError);
    const full = dealNextPacket(dealNextPacket(empty, 0, 'counterclockwise'), 0, 'counterclockwise');
    expect(() => createTrumpSelection(PRESETS['29-standard'], 0, 3, full)).toThrow(RangeError);
  });
});

describe('external indicator (T18)', () => {
  test('allows an absent suit and moves no cards', () => {
    const state = initial('29-simplified', 1);
    const selected = transition(state, () => selectTrump(state, 1, { suit: 'S' }));
    expect(selected.state.deal).toBe(state.deal);
    expect(selected.state.concealed).toBeNull();
    expect(selected.events[1]).toEqual({ type: 'TRUMP_DETAILS', audience: 1, suit: 'S' });
    expect(trumpKnowledge(selected.state, 1)).toEqual({ trumpSuit: 'S' });
    const full = dealRemainingCards(selected.state);
    expect(Object.values(full.state.deal.hands).map(hand => hand.length)).toEqual([8, 8, 8, 8]);
    expectConserved(full.state);
    reject(state, () => selectTrump(state, 1, { cardId: 'JC' }), 'TRUMP_SELECTION_INVALID');
  });
});

describe('seventh-card option', () => {
  test.each(['clockwise', 'counterclockwise'])('%s never sends concealed seventh card to any seat', direction => {
    const { maxBid, totalPoints, ...input } = PRESETS['29-standard'];
    const cfg = rulesetSchema.parse({ ...input, direction, seventhCardTrump: true });
    for (const declarer of [0, 1, 2, 3]) {
      const state = initial('29-standard', declarer, cfg);
      const selected = selectTrump(state, declarer, { seventhCard: true });
      expect(selected.state.concealed).toEqual({ owner: declarer, card: null });
      expect(selected.state.trumpSuit).toBeNull();
      expect(selected.events).toEqual([{ type: 'TRUMP_SELECTED', audience: 'all', declarer }]);
      const result = transition(selected.state, () => dealRemainingCards(selected.state));
      const card = result.state.concealed.card;
      expect(result.state.deal.hands[declarer]).toHaveLength(7);
      expect(result.events.flatMap(event => event.cards)).not.toContain(card);
      expect(result.events.find(event => event.audience === declarer).cards).toHaveLength(3);
      for (const viewer of [0, 1, 2, 3, 'spectator']) expect(trumpKnowledge(result.state, viewer)).toEqual({});
      const originalFirst = state.deal.hands[declarer];
      const received = result.state.deal.hands[declarer];
      expect(received.slice(0, 4)).toEqual(originalFirst);
      const packetIndex = dealOrder(0, direction).indexOf(declarer);
      expect(card).toBe(result.state.deal.deck[18 + packetIndex * 4]);
      expectConserved(result.state);
    }
  });
});

describe('Twenty-Eight reselection (T15 card transitions)', () => {
  test.each([0, 1, 2])('returns old indicator privately and seat %s conceals from eight cards', declarer => {
    const state = initial('28-standard');
    const full = dealRemainingCards(selectTrump(state, 3, { cardId: 'JC' }).state).state;
    const returning = transition(full, () => beginTrumpReselection(full, declarer));
    expect(returning.events).toEqual([{ type: 'CARD_RETURNED', audience: 3, card: 'JC' }]);
    expect(returning.state.deal.hands[3]).toHaveLength(8);
    expect(returning.state.trumpSuit).toBeNull();
    expect(returning.state.concealed).toBeNull();
    expectConserved(returning.state);
    const card = returning.state.deal.hands[declarer][7];
    const selected = transition(returning.state, () => selectTrump(returning.state, declarer, { cardId: card }));
    expect(selected.state.phase).toBe('READY');
    expect(selected.state.deal.hands[declarer]).toHaveLength(7);
    expect(selected.state.concealed).toEqual({ owner: declarer, card });
    expect(trumpKnowledge(selected.state, 3)).toEqual({});
    expectConserved(selected.state);
    reject(returning.state, () => selectTrump(returning.state, declarer, { seventhCard: true }), 'TRUMP_SELECTION_INVALID');
    reject(full, () => beginTrumpReselection(full, 3), 'TRUMP_SELECTION_INVALID');
    reject(state, () => beginTrumpReselection(state, declarer), 'WRONG_PHASE');
  });
});

describe('trump-selection timeouts', () => {
  test.each([
    [['JC', '7C', '9D', 'AD'], '7C'],
    [['JC', '9D', 'AD', '7D'], '7D'],
    [['KC', '7C', 'QD', '8D'], '7C'],
    [['KC', 'KD', '7H', '7S'], 'KC'],
    [['7C', '7D', '7H', '7S'], '7C'],
  ])('uses points, count, highest rank, then suit order for %p', (cards, expected) => {
    const state = initial('29-standard', 3, PRESETS['29-standard'], cards);
    const result = transition(state, () => applyTrumpSelectionTimeout(state));
    expect(result.state.concealed.card).toBe(expected);
  });

  test('external timeout chooses a suit without removing a card', () => {
    const state = initial('29-simplified', 1);
    const result = applyTrumpSelectionTimeout(state);
    expect(result.state.trumpSuit).toBe('C');
    expect(result.state.concealed).toBeNull();
  });

  test('reselection timeout considers all eight cards', () => {
    const first = ['7C', '8C', 'QC', 'KC'];
    const second = ['JS', '9S', 'AS', 'TS'];
    const remaining = createDeck().filter(card => !first.includes(card) && !second.includes(card));
    const deck = deckSchema.parse([...remaining.slice(0, 12), ...first, ...remaining.slice(12), ...second]);
    const cfg = PRESETS['28-standard'];
    const state = createTrumpSelection(cfg, 0, 3, dealNextPacket(createDeal(deck), 0, cfg.direction));
    const full = dealRemainingCards(selectTrump(state, 3, { cardId: state.deal.hands[3][0] }).state).state;
    const reselect = beginTrumpReselection(full, 0).state;
    expect(reselect.deal.hands[0]).toEqual([...first, ...second]);
    const result = transition(reselect, () => applyTrumpSelectionTimeout(reselect));
    expect(result.state.phase).toBe('READY');
    expect(result.state.concealed.card).toBe('TS');
    expectConserved(result.state);
  });
});
