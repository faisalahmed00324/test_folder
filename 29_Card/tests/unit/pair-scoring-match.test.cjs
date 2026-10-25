const { describe, test, expect } = require('@jest/globals');
const { createDeck, cardPoints } = require('../../src/domain/cards.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { rulesetSchema } = require('../../src/domain/ruleset.ts');
const { createHandContract, canDeclarePair, openPairWindow, applyPairDeclaration, closePairWindow } = require('../../src/domain/pair.ts');
const { scoreHand } = require('../../src/domain/scoring.ts');
const { createMatchProgress, startMatchDeal, requestRedeal, closeRedealWindow, voidMatchDeal, scoreMatchHand, abandonMatch } = require('../../src/domain/match.ts');
const { createTrumpSelection, selectTrump, dealRemainingCards } = require('../../src/domain/trump.ts');
const { createPlayState, applyPlayTimeout, startNextTrick } = require('../../src/domain/play.ts');

const cfg = PRESETS['29-standard'];
const prefs = manual => Object.fromEntries([0, 1, 2, 3].map(seat => [seat, { autoDeclarePair: !manual.includes(seat), isBot: false }]));
const custom = changes => {
  const { totalPoints, maxBid, ...input } = cfg;
  return rulesetSchema.parse({ ...input, ...changes });
};

function pairPlay(changes = {}) {
  return { ruleset: cfg, declarer: 0, trumpSuit: 'S', phase: 'TRICK_COMPLETE',
    hands: { 0: ['KS', 'QS', '7C'], 1: ['7D'], 2: ['7H'], 3: ['7S'] },
    reveal: { by: 1, trickIndex: 1, position: 1 },
    completedTricks: [{ index: 1, winner: 2 }], ...changes };
}

function completed(points, ruleset = cfg, declarer = 0) {
  // Build complete card-location/point fixtures, not a second rules implementation.
  const deck = [...createDeck()];
  let seed = 123;
  for (let i = 31; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const tricks = Array.from({ length: 8 }, (_, i) => ({ index: i + 1, leader: 0,
    plays: deck.slice(i * 4, i * 4 + 4).map((card, seat) => ({ seat, card, trumpPower: false })),
    points: deck.slice(i * 4, i * 4 + 4).reduce((sum, card) => sum + cardPoints(card), 0) + (i === 7 ? ruleset.lastTrickBonus : 0) }));
  const mask = Array.from({ length: 256 }, (_, mask) => mask).find(mask =>
    tricks.reduce((sum, trick, i) => sum + ((mask >> i) & 1 ? trick.points : 0), 0) === points);
  expect(mask).toBeDefined();
  const team = declarer % 2 === 0 ? 'A' : 'B';
  return { ruleset, declarer, mode: 'card', trumpSuit: 'S', initialIndicatorCard: 'QS',
    hands: { 0: [], 1: [], 2: [], 3: [] }, concealed: null, phase: 'COMPLETE',
    currentTrick: { index: 8, leader: 0, plays: [] },
    completedTricks: tricks.map((trick, i) => ({ ...trick, winner: (mask >> i) & 1 ? declarer : (declarer + 1) % 4 })),
    capturedPoints: team === 'A' ? { A: points, B: ruleset.totalPoints - points } : { B: points, A: ruleset.totalPoints - points },
    reveal: { by: 1, trickIndex: 1, position: 1 }, pendingRevealPlay: null, toAct: null };
}

function assertRejected(result, state, code) {
  expect(result).toEqual({ ok: false, state, events: [], code });
  expect(result.state).toBe(state);
}

describe('pair declarations and fixed windows (T35-T38, T55, T56)', () => {
  test.each([[20, 16], [16, 16]])('auto pair changes %s to %s without pause or card movement', (bid, target) => {
    const play = pairPlay();
    const before = structuredClone(play);
    const result = openPairWindow(play, createHandContract(cfg, bid), prefs([]), 100);
    expect(result.state.status).toBe('CLOSED');
    expect(result.state.contract).toEqual({ originalContract: bid, effectiveContract: target, pair: { seat: 0, team: 'A' } });
    expect(result.events).toEqual([{ type: 'PAIR_DECLARED', seat: 0, cards: ['KS', 'QS'], effectiveContract: target }]);
    expect(play).toEqual(before);
  });

  test('defender pair caps target at 28', () => {
    const play = pairPlay({ declarer: 1 });
    expect(openPairWindow(play, createHandContract(cfg, 26), prefs([]), 100).state.contract.effectiveContract).toBe(28);
  });

  test('windows are identical with or without eligible cards and close only at deadline', () => {
    const contract = createHandContract(cfg, 20);
    const play = pairPlay();
    const withPair = openPairWindow(play, contract, prefs([0]), 100);
    const withoutPair = openPairWindow(pairPlay({ hands: { ...play.hands, 0: ['7C'] } }), contract, prefs([0]), 100);
    expect(withPair.events).toEqual(withoutPair.events);
    expect(withPair.events).toEqual([{ type: 'PAIR_WINDOW_OPENED', deadline: 4100 }]);
    expect(withPair.state.deadline).toBe(withoutPair.state.deadline);
    assertRejected(closePairWindow(withPair.state, 4099), withPair.state, 'WRONG_PHASE');
    const closed = closePairWindow(withPair.state, 4100);
    expect(closed.state.status).toBe('CLOSED');
    expect(closed.state.contract.pair).toBeNull();
    expect(closed.events).toEqual([]);
    assertRejected(closePairWindow(closed.state, 4200), closed.state, 'WRONG_PHASE');
    assertRejected(applyPairDeclaration(withPair.state, 0, 4100), withPair.state, 'TURN_EXPIRED');
  });

  test('manual declaration ends window and only eligible seats can declare', () => {
    const { state } = openPairWindow(pairPlay(), createHandContract(cfg, 20), prefs([0]), 0);
    const before = structuredClone(state);
    assertRejected(applyPairDeclaration(state, 1, 1), state, 'PAIR_NOT_ELIGIBLE');
    const declared = applyPairDeclaration(state, 0, 3999);
    expect(declared.ok).toBe(true);
    expect(declared.state.contract.effectiveContract).toBe(16);
    expect(state).toEqual(before);
    assertRejected(applyPairDeclaration(declared.state, 0, 3999), declared.state, 'WRONG_PHASE');
    expect(canDeclarePair(state.play, declared.state.contract, 0)).toBe(false);
    const disabled = { ...state, play: { ...state.play, ruleset: PRESETS['29-simplified'] } };
    assertRejected(applyPairDeclaration(disabled, 0, 1), disabled, 'PAIR_NOT_ELIGIBLE');
  });

  test('rejects nonfinite pair times rather than opening or closing a broken timer', () => {
    const play = pairPlay();
    const contract = createHandContract(cfg, 20);
    expect(() => openPairWindow(play, contract, prefs([0]), NaN)).toThrow(RangeError);
    const { state } = openPairWindow(play, contract, prefs([0]), 0);
    expect(() => applyPairDeclaration(state, 0, NaN)).toThrow(RangeError);
    expect(() => closePairWindow(state, Infinity)).toThrow(RangeError);
  });

  test('missed window can be used later while K and Q remain', () => {
    const first = openPairWindow(pairPlay(), createHandContract(cfg, 20), prefs([0]), 0);
    const closed = closePairWindow(first.state, 4000).state;
    const play = pairPlay({ completedTricks: [{ index: 2, winner: 0 }] });
    const later = openPairWindow(play, closed.contract, prefs([0]), 5000);
    expect(applyPairDeclaration(later.state, 0, 6000).ok).toBe(true);
  });

  test('bot declares automatically even with manual preference', () => {
    const settings = prefs([0]);
    settings[0].isBot = true;
    const result = openPairWindow(pairPlay(), createHandContract(cfg, 20), settings, 0);
    expect(result.events[0].type).toBe('PAIR_DECLARED');
  });

  test('losing-team preferences never open a window', () => {
    const play = pairPlay({ hands: { 0: [], 1: [], 2: [], 3: [] } });
    expect(openPairWindow(play, createHandContract(cfg, 20), prefs([1, 3]), 0).state.status).toBe('CLOSED');
  });

  test('manual preferences still open neutral windows when no pair remains in hand', () => {
    const play = pairPlay({ hands: { 0: [], 1: [], 2: [], 3: [] } });
    expect(openPairWindow(play, createHandContract(cfg, 20), prefs([2]), 100).events)
      .toEqual([{ type: 'PAIR_WINDOW_OPENED', deadline: 4100 }]);
  });

  test.each([
    { reveal: null }, { phase: 'COMPLETE' }, { ruleset: PRESETS['29-simplified'] },
  ])('skips pair handling for %p', changes => {
    const play = pairPlay(changes);
    const contract = createHandContract(cfg, 20);
    expect(canDeclarePair(play, contract, 0)).toBe(false);
    expect(openPairWindow(play, contract, prefs([0]), 0).events).toEqual([]);
  });

  test('cannot declare after losing trick, before reveal trick, or with king played', () => {
    const contract = createHandContract(cfg, 20);
    for (const play of [pairPlay({ completedTricks: [{ index: 1, winner: 1 }] }),
      pairPlay({ reveal: { by: 1, trickIndex: 2, position: 1 } }),
      pairPlay({ hands: { 0: ['QS'], 1: [], 2: [], 3: [] } })]) {
      expect(canDeclarePair(play, contract, 0)).toBe(false);
    }
    expect(() => openPairWindow(pairPlay({ phase: 'PLAY' }), contract, prefs([]), 0)).toThrow(RangeError);
    expect(openPairWindow(pairPlay(), { ...contract, pair: { seat: 0, team: 'A' } }, prefs([0]), 0).events).toEqual([]);
    for (const bid of [15, 29, 16.5, NaN]) expect(() => createHandContract(cfg, bid)).toThrow(RangeError);
  });
});

describe('contract scoring (T21, T39-T42)', () => {
  test.each([
    ['29-standard', 18, 18, 1, 17, -1], ['29-standard', 18, 18, 1, 18, 1],
    ['29-standard', 20, 20, 2, 22, 2], ['29-standard', 20, 20, 4, 19, -4],
    ['29-standard', 20, 16, 1, 17, 1], ['29-standard', 26, 28, 1, 27, -1],
    ['28-standard', 21, 21, 1, 21, 2], ['28-standard', 17, 17, 1, 15, -2],
    ['28-standard', 21, 21, 1, 19, -3], ['28-standard', 17, 17, 1, 18, 1],
  ])('%s bid %s target %s stake %s points %s gives %s', (name, originalContract, effectiveContract, stake, points, delta) => {
    const play = completed(points, PRESETS[name]);
    const before = structuredClone(play);
    const result = scoreHand(play, { originalContract, effectiveContract, pair: null }, stake);
    expect(result.delta).toBe(delta);
    expect(result.made).toBe(delta > 0);
    expect(result.declaringPoints + result.defendingPoints).toBe(28);
    expect(result.indicatorCard).toBe('QS');
    expect(result.tricks).toHaveLength(8);
    expect(play).toEqual(before);
  });

  test('score band comes from original bid, not adjusted target', () => {
    const ruleset = custom({ scoreBands: [{ from: 16, to: 19, win: 1, loss: 1 }, { from: 20, to: 28, win: 2, loss: 3 }] });
    expect(scoreHand(completed(17, ruleset), { originalContract: 20, effectiveContract: 16, pair: null }, 1).delta).toBe(2);
  });

  test('rejects incomplete, corrupt, and unsupported scoring inputs', () => {
    const play = completed(18);
    const contract = createHandContract(cfg, 18);
    for (const changes of [
      { phase: 'PLAY' }, { completedTricks: [] }, { concealed: { owner: 0, card: 'QS' } },
      { currentTrick: { ...play.currentTrick, plays: [{ seat: 0, card: 'QS' }] } },
      { hands: { ...play.hands, 0: ['QS'] } }, { capturedPoints: { A: 18, B: 11 } },
      { capturedPoints: { A: 17, B: 11 } },
      { completedTricks: play.completedTricks.map((t, i) => i === 0 ? { ...t, points: 99 } : t) },
      { completedTricks: play.completedTricks.map((t, i) => i === 0 ? { ...t, index: 2 } : t) },
      { completedTricks: play.completedTricks.map((t, i) => i === 0 ? { ...t, plays: t.plays.slice(1) } : t) },
      { completedTricks: play.completedTricks.map((t, i) => i === 0 ? { ...t, plays: t.plays.map(p => ({ ...p, seat: 0 })) } : t) },
      { completedTricks: play.completedTricks.map((t, i) => i === 0 ? { ...t, plays: t.plays.map(p => ({ ...p, card: 'JS' })) } : t) },
    ]) expect(() => scoreHand({ ...play, ...changes }, contract, 1)).toThrow(RangeError);
    for (const changes of [{ originalContract: 29 }, { originalContract: 18.5 }, { effectiveContract: 15 }, { effectiveContract: 29 }, { effectiveContract: 16.5 }]) {
      expect(() => scoreHand(play, { ...contract, ...changes }, 1)).toThrow(RangeError);
    }
    expect(() => scoreHand(play, contract, 3)).toThrow(RangeError);
    const simple = completed(18, PRESETS['29-simplified']);
    expect(() => scoreHand(simple, contract, 2)).toThrow(RangeError);
    expect(() => scoreHand(simple, { ...contract, effectiveContract: 17 }, 1)).toThrow(RangeError);
  });
});

describe('match scores, endings, dealer rotation, and redeals (T40, T43, T44)', () => {
  const started = (ruleset = cfg) => startMatchDeal(createMatchProgress(ruleset, 0), createDeck(), 100).state;

  test.each([0, 1])('changes only declaring team score for declarer %s', declarer => {
    for (const points of [17, 18]) {
      const state = started();
      const before = structuredClone(state);
      const result = scoreMatchHand(state, 1, completed(points, cfg, declarer), createHandContract(cfg, 18), 1);
      expect(result.ok).toBe(true);
      const team = declarer === 0 ? 'A' : 'B';
      expect(result.state.gameScores[team]).toBe(points === 18 ? 1 : -1);
      expect(result.state.gameScores[team === 'A' ? 'B' : 'A']).toBe(0);
      expect(result.state).toMatchObject({ dealer: 3, handNumber: 2, dealNumber: 2, phase: 'AWAITING_DEAL' });
      expect(result.events.filter(event => event.type === 'HAND_SCORED')).toHaveLength(1);
      expect(state).toEqual(before);
      assertRejected(scoreMatchHand(result.state, 1, completed(points), createHandContract(cfg, 18), 1), result.state, 'STALE_STATE');
      assertRejected(scoreMatchHand(result.state, 2, completed(points), createHandContract(cfg, 18), 1), result.state, 'WRONG_PHASE');
    }
  });

  test.each([[3, 20, 'A', 7], [-3, 17, 'B', -7]])('threshold crossing from %s ends match', (score, points, winner, expected) => {
    const state = { ...started(), gameScores: { A: score, B: 0 } };
    const result = scoreMatchHand(state, 1, completed(points), createHandContract(cfg, 18), 4);
    expect(result.state).toMatchObject({ status: 'FINISHED', winner, gameScores: { A: expected, B: 0 }, dealer: 0 });
    expect(result.events.map(event => event.type)).toEqual(['HAND_SCORED', 'MATCH_ENDED']);
    for (const run of [s => scoreMatchHand(s, 1, completed(18), createHandContract(cfg, 18), 1),
      s => startMatchDeal(s, createDeck(), 0), s => requestRedeal(s, 0, 0), s => closeRedealWindow(s, 0),
      s => voidMatchDeal(s, 'serverFault'), s => abandonMatch(s)]) {
      assertRejected(run(result.state), result.state, 'MATCH_OVER');
    }
  });

  test('same-dealer server-fault redeal increments only deal count and needs a fresh deck input', () => {
    const state = started();
    const result = voidMatchDeal(state, 'serverFault');
    expect(result.state).toMatchObject({ dealer: 0, handNumber: 1, dealNumber: 2, firstPacket: null, phase: 'AWAITING_DEAL' });
    expect(result.state.gameScores).toEqual({ A: 0, B: 0 });
    assertRejected(voidMatchDeal(result.state, 'serverFault'), result.state, 'WRONG_PHASE');
    expect(startMatchDeal(result.state, createDeck(), 0).ok).toBe(true);
  });

  test('rotate redeal follows direction but all-pass explicitly keeps dealer', () => {
    const ruleset = custom({ redealDealer: 'rotate', openingBidForced: false });
    expect(voidMatchDeal(started(ruleset), 'serverFault').state.dealer).toBe(3);
    expect(voidMatchDeal(started(ruleset), 'allPass').state.dealer).toBe(0);
    const state = started();
    assertRejected(voidMatchDeal(state, 'allPass'), state, 'REDEAL_NOT_ELIGIBLE');
    assertRejected(voidMatchDeal(state, 'pointlessFour'), state, 'REDEAL_NOT_ELIGIBLE');
    const window = started(custom({ redealOnPointlessFour: true }));
    const closed = closeRedealWindow(window, 3100).state;
    assertRejected(voidMatchDeal(closed, 'pointlessFour'), closed, 'REDEAL_NOT_ELIGIBLE');
  });

  test('pointless-four window always opens, validates eligibility and never shortens on rejection', () => {
    const ruleset = custom({ redealOnPointlessFour: true });
    const state = started(ruleset);
    expect(state).toMatchObject({ phase: 'REDEAL_WINDOW', redealDeadline: 3100 });
    const before = structuredClone(state);
    assertRejected(requestRedeal(state, 3, 101), state, 'REDEAL_NOT_ELIGIBLE');
    expect(state).toEqual(before);
    assertRejected(requestRedeal(state, 2, 3100), state, 'TURN_EXPIRED');
    const redealt = requestRedeal(state, 2, 3099);
    expect(redealt.events).toEqual([{ type: 'DEAL_VOIDED', reason: 'pointlessFour' }]);
    expect(redealt.state.dealNumber).toBe(2);
    assertRejected(closeRedealWindow(state, 3099), state, 'WRONG_PHASE');
    const closed = closeRedealWindow(state, 3100);
    expect(closed.state).toMatchObject({ phase: 'IN_HAND', redealDeadline: null });
    assertRejected(requestRedeal(closed.state, 2, 3101), closed.state, 'WRONG_PHASE');
    assertRejected(closeRedealWindow(closed.state, 3101), closed.state, 'WRONG_PHASE');
    assertRejected(startMatchDeal(state, createDeck(), 0), state, 'WRONG_PHASE');
    assertRejected(scoreMatchHand(state, 1, completed(18), createHandContract(cfg, 18), 1), state, 'WRONG_PHASE');
    const playing = started();
    assertRejected(scoreMatchHand(playing, 1, { ...completed(18), phase: 'PLAY' }, createHandContract(cfg, 18), 1), playing, 'WRONG_PHASE');
  });

  test('invalid redeal timing is rejected and abandonment ends without a winner', () => {
    const state = createMatchProgress(cfg, 0);
    for (const [now, window] of [[NaN, 3000], [0, 0], [0, Infinity]]) {
      expect(() => startMatchDeal(state, createDeck(), now, window)).toThrow(RangeError);
    }
    const result = abandonMatch(started());
    expect(result.state).toMatchObject({ status: 'ABANDONED', winner: null });
    expect(result.events[0]).toEqual({ type: 'MATCH_ENDED', winner: null, gameScores: { A: 0, B: 0 }, abandoned: true });
    expect(() => requestRedeal(state, 0, NaN)).toThrow(RangeError);
    expect(() => closeRedealWindow(state, Infinity)).toThrow(RangeError);
  });
});

describe('real completed-play scoring integration', () => {
  test.each([...Object.keys(PRESETS), 'bonus'])('%s scores real eight-trick hands until match end', name => {
    const ruleset = name === 'bonus' ? custom({ lastTrickBonus: 1,
      scoreBands: [{ from: 16, to: 29, win: 1, loss: 1 }] }) : PRESETS[name];
    let match = createMatchProgress(ruleset, 0);
    let hands = 0;
    while (match.status === 'IN_PROGRESS') {
      match = startMatchDeal(match, createDeck(), 0).state;
      const dealNumber = match.dealNumber;
      // Always choose the eldest as declarer to keep this fixture's outcomes
      // consistent while exercising rotation through all four physical seats.
      const declarer = ruleset.direction === 'clockwise' ? (match.dealer + 1) % 4 : (match.dealer + 3) % 4;
      const selection = createTrumpSelection(ruleset, match.dealer, declarer, match.firstPacket);
      const selected = selectTrump(selection, declarer, ruleset.trumpIndicator === 'external'
        ? { suit: 'S' } : { cardId: selection.deal.hands[declarer][0] });
      let play = createPlayState(dealRemainingCards(selected.state).state);
      let contract = createHandContract(ruleset, ruleset.minBid);
      while (play.phase !== 'COMPLETE') {
        if (play.phase === 'TRICK_COMPLETE') {
          const pair = openPairWindow(play, contract, prefs([]), 0);
          expect(pair.state.status).toBe('CLOSED');
          contract = pair.state.contract;
          play = startNextTrick(play).state;
        } else play = applyPlayTimeout(play).state;
      }
      const result = scoreMatchHand(match, dealNumber, play, contract, 1);
      expect(result.ok).toBe(true);
      expect(result.events[0].summary.tricks).toHaveLength(8);
      expect(result.events[0].summary.declaringPoints + result.events[0].summary.defendingPoints).toBe(ruleset.totalPoints);
      expect(result.events[0].summary.indicatorCard).toBe(ruleset.trumpIndicator === 'external'
        ? null : selection.deal.hands[declarer][0]);
      match = result.state;
      expect(++hands).toBeLessThanOrEqual(12);
    }
    expect(match.status).toBe('FINISHED');
    expect(match.winner).not.toBeNull();
  });
});
