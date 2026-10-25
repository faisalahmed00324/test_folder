const { describe, test, expect } = require('@jest/globals');
const { createDeck, deckSchema, cardPoints } = require('../../src/domain/cards.ts');
const { createDeal, dealNextPacket } = require('../../src/domain/deal.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { rulesetSchema } = require('../../src/domain/ruleset.ts');
const { nextSeat } = require('../../src/domain/seats.ts');
const { createTrumpSelection, selectTrump, dealRemainingCards } = require('../../src/domain/trump.ts');
const {
  playActionSchema, createPlayState, legalPlayActions, resolveTrick,
  applyPlayAction, startNextTrick, applyPlayTimeout,
} = require('../../src/domain/play.ts');

const play = cardId => ({ type: 'PLAY_CARD', cardId });
const call = { type: 'CALL_TRUMP' };
const reveal = { type: 'REVEAL_TRUMP' };
const standard = PRESETS['29-standard'];

function config(name, changes) {
  const { totalPoints, maxBid, ...input } = PRESETS[name];
  return rulesetSchema.parse({ ...input, ...changes });
}

// Small trusted mid-trick states isolate obligations; complete-hand tests below
// use real deck/deal/selection transitions and assert all card locations.
function position(hands, changes = {}) {
  return {
    ruleset: standard, declarer: 0, mode: 'card', trumpSuit: 'S',
    hands: { 0: [], 1: [], 2: [], 3: [], ...hands }, concealed: { owner: 0, card: 'QS' },
    phase: 'PLAY', currentTrick: { index: 1, leader: 3, plays: [{ seat: 3, card: 'AH' }] },
    completedTricks: [], capturedPoints: { A: 0, B: 0 }, reveal: null, pendingRevealPlay: null,
    toAct: 2, ...changes,
  };
}

function act(state, action, seat = state.toAct) {
  const before = structuredClone(state);
  const result = applyPlayAction(state, seat, action);
  expect(state).toEqual(before);
  expect(result.ok).toBe(true);
  return result;
}

function reject(state, action, code, seat = state.toAct) {
  const before = structuredClone(state);
  const result = applyPlayAction(state, seat, action);
  expect(result).toEqual({ ok: false, state, events: [], code });
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}

function prepared(cfg = standard, dealer = 0, declarer = 0, deck = createDeck(), seventh = false) {
  const first = dealNextPacket(createDeal(deck), dealer, cfg.direction);
  const selecting = createTrumpSelection(cfg, dealer, declarer, first);
  const selection = seventh ? { seventhCard: true } : cfg.trumpIndicator === 'external'
    ? { suit: 'S' } : { cardId: first.hands[declarer][0] };
  return dealRemainingCards(selectTrump(selecting, declarer, selection).state).state;
}

describe('play command boundary', () => {
  test.each([play('JS'), call, reveal])('accepts %p', action => {
    expect(playActionSchema.safeParse(action).success).toBe(true);
  });
  test.each([null, {}, play('10S'), { type: 'CALL_TRUMP', cardId: 'JS' }, { type: 'BID', amount: 16 }])('rejects %p', action => {
    expect(playActionSchema.safeParse(action).success).toBe(false);
  });
});

describe('leading and following (T19, T22, T23)', () => {
  test('eldest leads regardless of declarer, in either direction', () => {
    for (const name of Object.keys(PRESETS)) {
      const trump = prepared(PRESETS[name]);
      const state = createPlayState(trump);
      expect(state.currentTrick).toEqual({ index: 1, leader: name === '29-simplified' ? 1 : 3, plays: [] });
      expect(state.toAct).toBe(state.currentTrick.leader);
    }
  });

  test('cannot start play before full trump preparation', () => {
    const deal = dealNextPacket(createDeal(createDeck()), 0, 'counterclockwise');
    const state = createTrumpSelection(standard, 0, 0, deal);
    expect(() => createPlayState(state)).toThrow(RangeError);
    expect(() => createPlayState({ ...prepared(), trumpSuit: null })).toThrow(RangeError);
    expect(() => createPlayState({ ...prepared(), mode: null })).toThrow(RangeError);
  });

  test('must follow accessible led suit; cannot play concealed or another player card', () => {
    const state = position({ 2: ['7H', 'JS', 'AC'] });
    expect(legalPlayActions(state)).toEqual([play('7H')]);
    reject(state, play('JS'), 'MUST_FOLLOW_SUIT');
    reject(state, play('QS'), 'CARD_NOT_IN_HAND');
    reject(state, call, 'REVEAL_NOT_ALLOWED');
    reject(state, play('7H'), 'NOT_YOUR_TURN', 1);
    expect(act(state, play('7H')).state.toAct).toBe(1);
  });

  test('concealed-only led suit counts as void and declarer may discard', () => {
    const state = position({ 0: ['7C'] }, {
      toAct: 0, currentTrick: { index: 1, leader: 1, plays: [{ seat: 1, card: 'AS' }] },
    });
    expect(legalPlayActions(state)).toEqual([play('7C'), reveal]);
    expect(act(state, play('7C')).state.reveal).toBeNull();
    const revealed = act(state, reveal).state;
    expect(legalPlayActions(revealed)).toEqual([play('QS')]);
    reject(revealed, play('7C'), 'MUST_FOLLOW_SUIT');
  });

  test('declarer cannot lead hidden trump with other suits and cannot reveal early', () => {
    const state = position({ 0: ['JS', '7C'] }, { toAct: 0, currentTrick: { index: 2, leader: 0, plays: [] } });
    expect(legalPlayActions(state)).toEqual([play('7C')]);
    reject(state, play('JS'), 'CANNOT_LEAD_HIDDEN_TRUMP');
    reject(state, reveal, 'REVEAL_NOT_ALLOWED');
  });

  test('only-trumps leader reveals, then may lead any trump even in Twenty-Eight', () => {
    const state = position({ 0: ['JS', '7S'] }, {
      ruleset: PRESETS['28-standard'], toAct: 0, currentTrick: { index: 2, leader: 0, plays: [] },
    });
    expect(legalPlayActions(state)).toEqual([reveal]);
    const result = act(state, reveal);
    expect(result.state.pendingRevealPlay).toBeNull();
    expect(result.state.hands[0]).toEqual(['JS', '7S', 'QS']);
    expect(legalPlayActions(result.state)).toEqual([play('JS'), play('7S'), play('QS')]);
    expect(act(result.state, play('7S')).state.toAct).toBe(3);
  });

  test('seventh-card declarer and permissive preset may lead hidden trump', () => {
    for (const changes of [{ mode: 'seventhCard' }, { ruleset: PRESETS['29-simplified'], mode: 'suit', concealed: null }]) {
      const state = position({ 0: ['JS', '7C'] }, { toAct: 0, currentTrick: { index: 1, leader: 0, plays: [] }, ...changes });
      expect(legalPlayActions(state)).toEqual([play('JS'), play('7C')]);
      expect(act(state, play('JS')).state.reveal).toBeNull();
    }
  });
});

describe('reveal and turn-local obligations (T24-T29)', () => {
  test('void caller may discard or call; reveal is atomic and caller must trump', () => {
    const state = position({ 2: ['7C', '7S'], 0: ['AC'] });
    expect(legalPlayActions(state)).toEqual([play('7C'), play('7S'), call]);
    expect(act(state, play('7C')).state.reveal).toBeNull();
    reject(state, reveal, 'REVEAL_NOT_ALLOWED');
    const result = act(state, call);
    expect(result.events).toEqual([
      { type: 'TRUMP_CALLED', seat: 2 },
      { type: 'TRUMP_REVEALED', suit: 'S', card: 'QS', by: 2, trickIndex: 1, position: 1 },
    ]);
    expect(result.state.concealed).toBeNull();
    expect(result.state.hands[0]).toEqual(['AC', 'QS']);
    expect(result.state.toAct).toBe(2);
    expect(legalPlayActions(result.state)).toEqual([play('7S')]);
    reject(result.state, play('7C'), 'MUST_PLAY_TRUMP');
    reject(result.state, call, 'REVEAL_NOT_ALLOWED');
    const played = act(result.state, play('7S')).state;
    expect(played.pendingRevealPlay).toBeNull();
  });

  test('caller without trumps may discard; later void players need not trump or overtrump', () => {
    const state = position({ 2: ['7C'], 1: ['7D', 'JS'] });
    const revealed = act(state, call).state;
    expect(legalPlayActions(revealed)).toEqual([play('7C')]);
    const played = act(revealed, play('7C')).state;
    expect(legalPlayActions(played)).toEqual([play('7D'), play('JS')]);
    expect(act(played, play('7D')).state.toAct).toBe(0);
  });

  test('simplified preset requires reveal but imposes no caller trump duty', () => {
    const state = position({ 2: ['7C', '7S'] }, { ruleset: PRESETS['29-simplified'], mode: 'suit', concealed: null });
    expect(legalPlayActions(state)).toEqual([call]);
    reject(state, play('7C'), 'REVEAL_NOT_ALLOWED');
    const result = act(state, call);
    expect(result.events[1]).toEqual({ type: 'TRUMP_REVEALED', suit: 'S', by: 2, trickIndex: 1, position: 1 });
    expect(legalPlayActions(result.state)).toEqual([play('7C'), play('7S')]);
  });

  test.each([
    ['29-standard', [play('JS'), play('QS')], 'MUST_PLAY_TRUMP'],
    ['28-standard', [play('QS')], 'MUST_PLAY_INDICATOR'],
    ['29-simplified', [play('7C'), play('JS')], null],
  ])('%s declarer reveal obligation persists in serializable state', (name, expected, code) => {
    const state = position({ 0: ['7C', 'JS'] }, {
      ruleset: PRESETS[name], toAct: 0,
      ...(name === '29-simplified' ? { mode: 'suit', concealed: null } : {}),
    });
    const revealed = act(state, reveal).state;
    expect(legalPlayActions(structuredClone(revealed))).toEqual(expected);
    if (code) reject(revealed, play('7C'), code);
    if (name === '28-standard') reject(revealed, play('JS'), 'MUST_PLAY_INDICATOR');
    expect(act(revealed, expected[0]).state.pendingRevealPlay).toBeNull();
  });

  test('non-declarer cannot reveal on lead or when it is not their turn', () => {
    const state = position({ 2: ['7C'] }, { currentTrick: { index: 1, leader: 2, plays: [] } });
    reject(state, call, 'REVEAL_NOT_ALLOWED');
    reject(state, call, 'NOT_YOUR_TURN', 1);
  });
});

describe('trick resolution (T30-T32)', () => {
  test.each([
    [['AH', 'JS', '7S', 'JH'], { by: 2, trickIndex: 1, position: 2 }, '29-standard', 2, 7],
    [['AH', 'JS', '7S', 'JH'], { by: 2, trickIndex: 1, position: 2 }, '29-simplified', 1, 7],
    [['AS', '9D', '7S', 'JS'], { by: 1, trickIndex: 1, position: 1 }, '29-standard', 3, 6],
    [['TH', 'JS', '7H', 'KH'], null, '29-standard', 0, 4],
    [['AC', '7S', '9S', 'JC'], { by: 1, trickIndex: 0, position: 1 }, '29-standard', 2, 6],
    [['7H', 'JC', '9D', 'AS'], null, '29-standard', 0, 6],
    [['JS', '9D', '7S', 'AS'], { by: 1, trickIndex: 1, position: 1 }, '29-standard', 0, 6],
  ])('resolves %p with %p under %s', (cards, reveal, name, winner, points) => {
    const trick = { index: 1, leader: 0, plays: cards.map((card, seat) => ({ seat, card })) };
    const before = structuredClone(trick);
    const result = resolveTrick(trick, 'S', reveal, PRESETS[name]);
    expect(result.winner).toBe(winner);
    expect(result.points).toBe(points);
    expect(trick).toEqual(before);
  });

  test('future reveal cannot change an earlier trick and played-before-reveal trump has no power', () => {
    const trick = { index: 1, leader: 0, plays: ['AH', 'JS', '7S', 'JH'].map((card, seat) => ({ seat, card })) };
    const earlier = resolveTrick(trick, 'S', { by: 1, trickIndex: 2, position: 1 }, standard);
    expect(earlier.winner).toBe(3);
    expect(earlier.plays.every(play => !play.trumpPower)).toBe(true);
    const revealed = resolveTrick(trick, 'S', { by: 2, trickIndex: 1, position: 2 }, standard);
    expect(revealed.plays.map(play => play.trumpPower)).toEqual([false, false, true, false]);
  });

  test('resolution rejects incomplete tricks', () => {
    expect(() => resolveTrick({ index: 1, leader: 0, plays: [] }, 'S', null, standard)).toThrow(RangeError);
  });

  test.each([0, 1])('last-trick bonus %s applies only to trick eight', bonus => {
    const cfg = config('29-simplified', { lastTrickBonus: bonus, scoreBands: [{ from: 16, to: 28 + bonus, win: 1, loss: 1 }] });
    const plays = ['7H', '8H', 'QH', 'KH'].map((card, seat) => ({ seat, card }));
    expect(resolveTrick({ index: 7, leader: 0, plays }, 'S', null, cfg).points).toBe(0);
    expect(resolveTrick({ index: 8, leader: 0, plays }, 'S', null, cfg).points).toBe(bonus);
  });
});

describe('trick boundaries and timeouts', () => {
  test('trick completion pauses, moves cards to history, and winner leads next', () => {
    const state = position({ 0: ['JH'] }, { toAct: 0, currentTrick: {
      index: 1, leader: 3, plays: [{ seat: 3, card: 'AH' }, { seat: 2, card: '7H' }, { seat: 1, card: 'KH' }],
    } });
    const result = act(state, play('JH'));
    expect(result.events).toEqual([
      { type: 'CARD_PLAYED', seat: 0, card: 'JH', trickIndex: 1, position: 3 },
      { type: 'TRICK_WON', winner: 0, points: 4, trickIndex: 1 },
    ]);
    expect(result.state).toMatchObject({ phase: 'TRICK_COMPLETE', toAct: null, capturedPoints: { A: 4, B: 0 } });
    expect(result.state.currentTrick.plays).toEqual([]);
    expect(result.state.completedTricks).toHaveLength(1);
    expect(legalPlayActions(result.state)).toEqual([]);
    reject(result.state, play('QS'), 'WRONG_PHASE', 0);
    expect(applyPlayTimeout(result.state).code).toBe('WRONG_PHASE');
    const next = startNextTrick(result.state);
    expect(next.state).toMatchObject({ phase: 'PLAY', toAct: 0, currentTrick: { index: 2, leader: 0, plays: [] } });
    expect(next.state.completedTricks).toEqual(result.state.completedTricks);
    expect(startNextTrick(next.state).code).toBe('WRONG_PHASE');
  });

  test('timeout selects weakest legal card, ties C/D/H/S, and avoids optional reveal', () => {
    const state = position({ 2: ['JS', '7S', '7D', '7C'] });
    const result = applyPlayTimeout(state);
    expect(result.events[0].card).toBe('7C');
    expect(result.state.reveal).toBeNull();
  });

  test('timeout reveals only when required then obeys obligation on next command', () => {
    const state = position({ 2: ['JS', '7C'] }, { ruleset: PRESETS['29-simplified'], mode: 'suit', concealed: null });
    const revealed = applyPlayTimeout(state);
    expect(revealed.events[0].type).toBe('TRUMP_CALLED');
    expect(revealed.state.toAct).toBe(2);
    expect(applyPlayTimeout(revealed.state).events[0].card).toBe('7C');
  });
});

describe('eight-trick integration and conservation', () => {
  test.each([...Object.keys(PRESETS), 'seventh-card', 'bonus'])('%s completes deterministic full hands with all cards conserved', name => {
    const cfg = name === 'seventh-card' ? config('29-standard', { seventhCardTrump: true })
      : name === 'bonus' ? config('29-simplified', { lastTrickBonus: 1, scoreBands: [{ from: 16, to: 29, win: 1, loss: 1 }] })
      : PRESETS[name];
    let seed = 47;
    const index = length => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % length; };
    for (let run = 0; run < 60; run++) {
      const deck = [...createDeck()];
      for (let i = deck.length - 1; i > 0; i--) {
        const j = index(i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      let state = createPlayState(prepared(cfg, run % 4, (run + 1) % 4, deckSchema.parse(deck), name === 'seventh-card'));
      let count = 0;
      while (state.phase !== 'COMPLETE') {
        const before = structuredClone(state);
        let result;
        if (state.phase === 'TRICK_COMPLETE') result = startNextTrick(state);
        else {
          const legal = legalPlayActions(state);
          expect(legal.length).toBeGreaterThan(0);
          const action = legal[index(legal.length)];
          result = run % 3 === 0 ? applyPlayTimeout(state) : applyPlayAction(state, state.toAct, action);
        }
        expect(result.ok).toBe(true);
        expect(state).toEqual(before);
        expect(result.state.completedTricks.slice(0, state.completedTricks.length)).toEqual(state.completedTricks);
        state = result.state;
        const cards = [...Object.values(state.hands).flat(), ...state.currentTrick.plays.map(play => play.card),
          ...state.completedTricks.flatMap(trick => trick.plays.map(play => play.card)),
          ...(state.concealed ? [state.concealed.card] : [])];
        expect(cards).toHaveLength(32);
        expect(new Set(cards).size).toBe(32);
        const points = state.capturedPoints.A + state.capturedPoints.B;
        const inPlay = [...Object.values(state.hands).flat(), ...state.currentTrick.plays.map(play => play.card),
          ...(state.concealed ? [state.concealed.card] : [])].reduce((sum, card) => sum + cardPoints(card), 0);
        expect(points + inPlay).toBe(28 + (state.phase === 'COMPLETE' ? cfg.lastTrickBonus : 0));
        expect(++count).toBeLessThan(50);
      }
      expect(state.completedTricks).toHaveLength(8);
      expect(state.completedTricks.flatMap(trick => trick.plays)).toHaveLength(32);
      expect(state.capturedPoints.A + state.capturedPoints.B).toBe(cfg.totalPoints);
      expect(state.concealed).toBeNull();
      expect(state.toAct).toBeNull();
      for (const trick of state.completedTricks) {
        expect(new Set(trick.plays.map(play => play.seat)).size).toBe(4);
        let seat = trick.leader;
        for (const play of trick.plays) {
          expect(play.seat).toBe(seat);
          seat = nextSeat(seat, cfg.direction);
        }
      }
    }
  });

  test('hidden face-down indicator reveals automatically before trick eight (T33)', () => {
    // Each seat gets one suit; the strongest initial leader keeps winning.
    // Timeouts discard rather than taking an optional reveal.
    const deck = createDeck();
    const monosuitDeck = deckSchema.parse([
      ...deck.slice(0, 4), ...deck.slice(8, 12), ...deck.slice(16, 20), ...deck.slice(24, 28),
      ...deck.slice(4, 8), ...deck.slice(12, 16), ...deck.slice(20, 24), ...deck.slice(28, 32),
    ]);
    let state = createPlayState(prepared(standard, 0, 0, monosuitDeck));
    while (state.completedTricks.length < 7) {
      state = state.phase === 'TRICK_COMPLETE' ? startNextTrick(state).state : applyPlayTimeout(state).state;
    }
    expect(state.reveal).toBeNull();
    expect(state.hands[0]).toEqual([]);
    const result = startNextTrick(state);
    expect(result.events).toEqual([{ type: 'TRUMP_REVEALED', suit: 'S', card: 'JS', by: 'system', trickIndex: 8, position: 0 }]);
    expect(result.state.hands[0]).toEqual(['JS']);
    expect(result.state.pendingRevealPlay).toBeNull();
    state = result.state;
    while (state.phase === 'PLAY') state = applyPlayTimeout(state).state;
    expect(state.phase).toBe('COMPLETE');
    expect(state.completedTricks[7].plays.some(play => play.card === 'JS')).toBe(true);
    expect(startNextTrick(state).code).toBe('WRONG_PHASE');
    expect(applyPlayTimeout(state).code).toBe('WRONG_PHASE');
  });

  test('external trump can stay hidden through all eight tricks (T34 resolution)', () => {
    const deck = createDeck();
    // Each packet contains one card per suit, so following suit is always possible.
    const ordered = deckSchema.parse(Array.from({ length: 8 }, (_, rank) =>
      [deck[rank], deck[8 + rank], deck[16 + rank], deck[24 + rank]]).flat());
    let state = createPlayState(prepared(PRESETS['29-simplified'], 0, 0, ordered));
    while (state.phase !== 'COMPLETE') {
      state = state.phase === 'TRICK_COMPLETE' ? startNextTrick(state).state : applyPlayTimeout(state).state;
    }
    expect(state.reveal).toBeNull();
    expect(state.completedTricks.every(trick => trick.plays.every(play => !play.trumpPower))).toBe(true);
  });
});
