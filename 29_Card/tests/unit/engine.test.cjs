const { describe, test, expect } = require('@jest/globals');
const { createDeck, deckSchema } = require('../../src/domain/cards.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { rulesetSchema } = require('../../src/domain/ruleset.ts');
const { createEngine, engineToAct, engineLegalActions, applyEngineInput, applyEngineCommand,
  engineView, recipientEvents, replayEngine } = require('../../src/domain/engine.ts');
const { assertEngineInvariants } = require('../../src/domain/invariants.ts');

const custom = (name, changes) => {
  const { maxBid, totalPoints, ...input } = PRESETS[name];
  return rulesetSchema.parse({ ...input, ...changes });
};
function input(state, action, actor = 'system', now = state.lastCommandTime + 1) {
  return { expectedVersion: state.version, now, actor, action };
}
function step(state, action, actor = 'system', now) {
  const before = structuredClone(state);
  const command = input(state, action, actor, now);
  const result = applyEngineInput(state, command);
  expect(result.ok).toBe(true);
  expect(state).toEqual(before);
  expect(result.state.version).toBe(state.version + 1);
  assertEngineInvariants(result.state);
  return { ...result, command };
}
function timeout(state, now) {
  return step(state, { type: 'TIMEOUT', decisionVersion: state.version }, 'system', now);
}
function start(cfg = PRESETS['29-standard'], settings = {}, deck = createDeck()) {
  return step(createEngine(cfg, 0, settings), { type: 'START_DEAL', deck });
}
function toSelection(cfg = PRESETS['29-standard'], settings = {}) {
  let { state } = start(cfg, settings);
  state = step(state, { type: 'BID', amount: cfg.minBid }, engineToAct(state)).state;
  while (state.phase === 'AUCTION') state = step(state, { type: 'PASS' }, engineToAct(state)).state;
  expect(state.phase).toBe('TRUMP_SELECTION');
  return state;
}
function rejected(state, command, code) {
  const before = structuredClone(state);
  const result = applyEngineInput(state, command);
  expect(result).toEqual({ ok: false, state, events: [], code });
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}

describe('engine boundary and authority', () => {
  test('rejects malformed, stale, unauthorized, wrong-phase, and out-of-order commands unchanged', () => {
    const state = start().state;
    rejected(state, {}, 'INVALID_COMMAND');
    rejected(state, { ...input(state, { type: 'BID', amount: 16 }, 3), actor: 5 }, 'INVALID_COMMAND');
    rejected(state, { ...input(state, { type: 'BID', amount: 16 }, 3), expectedVersion: 0 }, 'STALE_STATE');
    rejected(state, input(state, { type: 'TIMEOUT', decisionVersion: 0 }), 'STALE_STATE');
    rejected(state, input(state, { type: 'TIMEOUT', decisionVersion: state.version }, 3), 'UNAUTHORIZED');
    rejected(state, input(state, { type: 'BID', amount: 16 }), 'UNAUTHORIZED');
    rejected(state, input(state, { type: 'PLAY_CARD', cardId: 'JS' }, 3), 'WRONG_PHASE');
    rejected(state, input(state, { type: 'BID', amount: 16 }, 0), 'NOT_YOUR_TURN');
    rejected(state, input(state, { type: 'PASS' }, 3), 'WRONG_PHASE');
    rejected(state, input(state, { type: 'BID', amount: 16 }, 3, 0), 'INVALID_TIME');
    rejected(state, input(state, { type: 'START_DEAL', deck: createDeck() }), 'WRONG_PHASE');
    rejected(state, input(state, { type: 'REQUEST_REDEAL' }, 3), 'WRONG_PHASE');
    expect(applyEngineCommand(state, input(state, { type: 'BID', amount: 16 }, 3, Infinity)).code).toBe('INVALID_TIME');
    expect(() => createEngine(PRESETS['29-standard'], 0, { unknown: true })).toThrow();
  });

  test('system abandonment and server fault clear the internal hand', () => {
    const state = start().state;
    const voided = step(state, { type: 'VOID_DEAL' });
    expect(voided.state).toMatchObject({ phase: 'AWAITING_DEAL', progress: { dealNumber: 2, handNumber: 1 } });
    expect(voided.events[0].event.type).toBe('DEAL_VOIDED');
    const abandoned = step(state, { type: 'ABANDON' }).state;
    expect(abandoned.phase).toBe('ABANDONED');
    rejected(abandoned, input(abandoned, { type: 'START_DEAL', deck: createDeck() }), 'MATCH_OVER');
    const initial = createEngine(PRESETS['29-standard'], 0);
    rejected(initial, input(initial, { type: 'VOID_DEAL' }), 'WRONG_PHASE');
  });

  test('controller changes are system-only, immutable, and preserve the hand and human pair preference', () => {
    const state = start(PRESETS['29-standard'], {
      preferences: Array.from({ length: 4 }, () => ({ autoDeclarePair: false, isBot: false })),
    }).state;
    rejected(state, input(state, { type: 'SET_BOT', seat: 3, isBot: true }, 3), 'UNAUTHORIZED');
    rejected(state, input(state, { type: 'SET_BOT', seat: 4, isBot: true }), 'INVALID_COMMAND');
    const takeover = step(state, { type: 'SET_BOT', seat: 3, isBot: true }).state;
    expect(takeover.settings.preferences[3]).toEqual({ autoDeclarePair: false, isBot: true });
    expect(takeover.auction).toEqual(state.auction);
    expect(takeover.progress).toEqual(state.progress);
    const reclaimed = step(takeover, { type: 'SET_BOT', seat: 3, isBot: false }).state;
    expect(reclaimed.settings.preferences).toEqual(state.settings.preferences);
    expect(Object.isFrozen(takeover.settings.preferences)).toBe(true);
  });

  test('all-pass discards the hand and waits for a fresh deck', () => {
    const cfg = custom('29-standard', { openingBidForced: false });
    let { state } = start(cfg);
    while (state.phase === 'AUCTION') state = timeout(state).state;
    expect(state).toMatchObject({ phase: 'AWAITING_DEAL', progress: { dealNumber: 2, dealer: 0 }, trump: null });
    expect(engineLegalActions(state, 'spectator')).toEqual([]);
    expect(engineLegalActions(state, 0)).toEqual([]);
  });

  test('redeal windows advertise only eligible seats and ignore premature timeout', () => {
    const cfg = custom('29-standard', { redealOnPointlessFour: true });
    const { state } = start(cfg);
    expect(state.phase).toBe('REDEAL_WINDOW');
    expect(engineLegalActions(state, 2)).toEqual([{ type: 'REQUEST_REDEAL' }]);
    expect(engineLegalActions(state, 3)).toEqual([]);
    rejected(state, input(state, { type: 'REQUEST_REDEAL' }, 3), 'REDEAL_NOT_ELIGIBLE');
    rejected(state, input(state, { type: 'TIMEOUT', decisionVersion: state.version }), 'WRONG_PHASE');
    expect(timeout(state, state.progress.redealDeadline).state.phase).toBe('AUCTION');
    const redealt = step(state, { type: 'REQUEST_REDEAL' }, 2);
    expect(redealt.state.phase).toBe('AWAITING_DEAL');
  });
});

describe('coordinated selection, second bidding, and double timing', () => {
  test.each(['afterFullDeal', 'beforeSecondDeal'])('doubling %s gates packet two correctly', timing => {
    const cfg = custom('29-standard', { doubling: { ...PRESETS['29-standard'].doubling, timing } });
    let state = toSelection(cfg);
    const declarer = engineToAct(state);
    const selected = step(state, engineLegalActions(state, declarer)[0], declarer);
    state = selected.state;
    expect(state.phase).toBe('DOUBLING');
    expect(state.trump.deal.dealtCount).toBe(timing === 'beforeSecondDeal' ? 16 : 32);
    const secondCards = selected.events.filter(entry => entry.event.type === 'CARDS_DEALT');
    expect(secondCards).toHaveLength(timing === 'beforeSecondDeal' ? 0 : 4);
    rejected(state, input(state, { type: 'REDOUBLE' }, engineToAct(state)), 'DOUBLE_NOT_ALLOWED');
    state = step(state, { type: 'DOUBLE' }, engineToAct(state)).state;
    expect(state.doubling.stakeMultiplier).toBe(2);
    state = step(state, { type: 'REDOUBLE' }, engineToAct(state)).state;
    expect(state.phase).toBe('PLAY');
    expect(state.trump.deal.dealtCount).toBe(32);
    expect(state.doubling.stakeMultiplier).toBe(4);
  });

  test('Twenty-Eight new declarer gets reselection after first-round passes reset', () => {
    let state = toSelection(PRESETS['28-standard']);
    const oldDeclarer = state.trump.declarer;
    state = timeout(state).state;
    expect(state.phase).toBe('SECOND_ROUND');
    expect(state.auction.active).toHaveLength(4);
    state = step(state, { type: 'PASS' }, engineToAct(state)).state;
    const winner = engineToAct(state);
    rejected(state, input(state, { type: 'BID', amount: 23 }, winner), 'BID_TOO_LOW');
    state = step(state, { type: 'BID', amount: 24 }, winner).state;
    while (state.phase === 'SECOND_ROUND') state = timeout(state).state;
    expect(state.phase).toBe('TRUMP_RESELECTION');
    expect(state.trump.declarer).toBe(winner);
    expect(state.trump.deal.hands[oldDeclarer]).toHaveLength(8);
    expect(state.contract.originalContract).toBe(24);
    state = step(state, engineLegalActions(state, winner)[0], winner).state;
    expect(state.phase).toBe('PLAY');
    expect(state.trump.deal.hands[winner]).toHaveLength(7);
  });

  test.each([false, true])('Twenty-Eight same-declarer trump unchanged, raises=%s', raise => {
    let state = toSelection(PRESETS['28-standard']);
    state = timeout(state).state;
    const card = state.trump.concealed.card;
    if (raise) state = step(state, { type: 'BID', amount: 24 }, engineToAct(state)).state;
    while (state.phase === 'SECOND_ROUND') state = timeout(state).state;
    expect(state.phase).toBe('PLAY');
    expect(state.trump.concealed.card).toBe(card);
    expect(state.contract.originalContract).toBe(raise ? 24 : 14);
  });

  test('maximum first-round bid auto-passes the second round without prompting', () => {
    let { state } = start(PRESETS['28-standard']);
    state = step(state, { type: 'BID', amount: 28 }, engineToAct(state)).state;
    state = timeout(state).state;
    expect(state.phase).toBe('PLAY');
    expect(state.auction.round).toBe(2);
    expect(state.auction.history.every(entry => entry.auto)).toBe(true);
  });
});

describe('seat projections, events, and hidden-information regressions', () => {
  test('phase one and concealed-trump traffic never include future cards or other hands', () => {
    const first = start();
    const state = first.state;
    for (const viewer of [0, 1, 2, 3, 'spectator']) {
      const view = engineView(state, viewer);
      const traffic = recipientEvents(first.events, viewer, state.version);
      expect(view.myHand).toEqual(viewer === 'spectator' ? [] : state.progress.firstPacket.hands[viewer]);
      expect(traffic.filter(entry => entry.event.type === 'CARDS_DEALT')).toHaveLength(viewer === 'spectator' ? 0 : 1);
      expect(traffic.map(entry => entry.seq)).toEqual(traffic.map((_, i) => i + 1));
      for (const card of createDeck().slice(16)) {
        expect(JSON.stringify({ view, traffic })).not.toContain(`"${card}"`);
      }
      expect(view).not.toHaveProperty('deck');
    }
    let selected = toSelection();
    const declarer = engineToAct(selected);
    const result = step(selected, engineLegalActions(selected, declarer)[0], declarer);
    selected = result.state;
    const partner = (declarer + 2) % 4;
    expect(engineView(selected, partner)).not.toHaveProperty('trumpSuit');
    expect(engineView(selected, partner)).not.toHaveProperty('myConcealedCard');
    expect(engineView(selected, declarer)).toHaveProperty('myConcealedCard');
    expect(recipientEvents(result.events, partner, selected.version).some(entry => entry.event.type === 'TRUMP_DETAILS')).toBe(false);
    const traffic = recipientEvents(result.events, declarer, selected.version, 100);
    expect(traffic[0].seq).toBe(101);
    const view = engineView(selected, declarer);
    view.myHand.pop();
    expect(engineView(selected, declarer).myHand).not.toEqual(view.myHand);
  });

  test('seventh-card identity and trump remain absent even in declarer view/events', () => {
    const cfg = custom('29-standard', { seventhCardTrump: true });
    let state = toSelection(cfg);
    const declarer = engineToAct(state);
    expect(engineLegalActions(state, declarer)).toContainEqual({ type: 'SELECT_TRUMP', payload: { seventhCard: true } });
    const result = step(state, { type: 'SELECT_TRUMP', payload: { seventhCard: true } }, declarer);
    state = result.state;
    for (const viewer of [0, 1, 2, 3, 'spectator']) {
      const view = engineView(state, viewer);
      expect(view).not.toHaveProperty('trumpSuit');
      expect(view).not.toHaveProperty('myConcealedCard');
      expect(JSON.stringify(recipientEvents(result.events, viewer, state.version))).not.toContain(state.trump.concealed.card);
    }
  });

  test('history respects settings and never contains hidden trump power flags', () => {
    const initial = createEngine(PRESETS['29-simplified'], 0, { trickHistoryVisibility: 'lastTrick', showCapturedPoints: false });
    let state = step(initial, { type: 'START_DEAL', deck: createDeck() }).state;
    while (state.phase !== 'PLAY' || state.play.completedTricks.length < 2) state = timeout(state).state;
    const view = engineView(state, 'spectator');
    expect(view.completedTricks).toHaveLength(1);
    expect(view.completedTricks[0]).not.toHaveProperty('points');
    expect(view).not.toHaveProperty('capturedPoints');
    expect(JSON.stringify(view.completedTricks)).not.toContain('trumpPower');
    if (state.play.reveal !== null) expect(view.trumpSuit).toBe(state.play.trumpSuit);
    expect(recipientEvents([{ audience: 'all', event: { type: 'TRICK_WON', winner: 0, points: 7, trickIndex: 1 } }],
      'spectator', state.version, 0, false)[0].event).not.toHaveProperty('points');
  });

  test('opponent view is unchanged when hidden trump changes but card counts do not', () => {
    const selected = toSelection();
    const declarer = engineToAct(selected);
    const cards = selected.trump.deal.hands[declarer];
    const first = step(selected, { type: 'SELECT_TRUMP', payload: { cardId: cards[0] } }, declarer);
    const second = step(selected, { type: 'SELECT_TRUMP', payload: { cardId: cards[1] } }, declarer);
    const viewer = (declarer + 1) % 4;
    expect(engineView(first.state, viewer)).toEqual(engineView(second.state, viewer));
    expect(recipientEvents(first.events, viewer, first.state.version)).toEqual(recipientEvents(second.events, viewer, second.state.version));
    expect(engineView(first.state, declarer)).not.toEqual(engineView(second.state, declarer));
  });
});

describe('coordinated complete matches, windows, replay, and invariants', () => {
  test.each(Object.keys(PRESETS))('%s random legal decisions complete hands without leaking private actions', name => {
    let seed = 99;
    const index = length => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % length; };
    for (let run = 0; run < 30; run++) {
      const deck = [...createDeck()];
      for (let i = 31; i > 0; i--) { const j = index(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
      const settings = { preferences: Array.from({ length: 4 }, () => ({ autoDeclarePair: false, isBot: false })) };
      let state = start(PRESETS[name], settings, deckSchema.parse(deck)).state;
      let count = 0;
      while (state.summary === null) {
        let result;
        if (state.phase === 'PAIR_WINDOW') {
          const seat = [0, 1, 2, 3].find(seat => engineLegalActions(state, seat).length > 0);
          result = seat === undefined ? timeout(state, state.pairWindow.deadline)
            : step(state, { type: 'DECLARE_PAIR' }, seat);
        } else {
          const actor = engineToAct(state);
          const legal = engineLegalActions(state, actor);
          result = run % 3 === 0 ? timeout(state) : step(state, legal[index(legal.length)], actor);
        }
        state = result.state;
        for (const viewer of [0, 1, 2, 3, 'spectator']) {
          const view = engineView(state, viewer);
          const traffic = recipientEvents(result.events, viewer, state.version);
          const actions = traffic.filter(entry => entry.event.type === 'LEGAL_ACTIONS');
          for (const event of actions) expect(event.event.actions).toEqual(engineLegalActions(state, viewer));
          expect(view).not.toHaveProperty('hands');
          expect(view).not.toHaveProperty('deck');
          expect(view).not.toHaveProperty('pendingRevealPlay');
          expect(JSON.stringify(view.completedTricks)).not.toContain('trumpPower');
          if (viewer === 'spectator') expect(view.legalActions).toEqual([]);
        }
        expect(++count).toBeLessThan(160);
      }
      expect(state.summary.tricks).toHaveLength(8);
    }
  });

  test.each([...Object.keys(PRESETS), 'manual-pairs', 'bonus'])('%s replays complete matches with invariant checks after every command', name => {
    const cfg = name === 'manual-pairs' ? PRESETS['29-standard'] : name === 'bonus'
      ? custom('29-standard', { lastTrickBonus: 1, scoreBands: [{ from: 16, to: 29, win: 1, loss: 1 }] }) : PRESETS[name];
    const initial = createEngine(cfg, 0, name === 'manual-pairs'
      ? { preferences: Array.from({ length: 4 }, () => ({ autoDeclarePair: false, isBot: false })) } : {});
    let state = initial;
    const commands = [];
    const events = [];
    let count = 0;
    let windows = 0;
    while (state.progress.status === 'IN_PROGRESS') {
      let result;
      if (state.phase === 'AWAITING_DEAL') result = step(state, { type: 'START_DEAL', deck: createDeck() });
      else if (state.phase === 'PAIR_WINDOW') {
        windows++;
        const restored = JSON.parse(JSON.stringify(state));
        assertEngineInvariants(restored);
        const resumeCommand = input(state, { type: 'TIMEOUT', decisionVersion: state.version }, 'system', state.pairWindow.deadline);
        expect(applyEngineInput(restored, resumeCommand)).toEqual(applyEngineInput(state, resumeCommand));
        rejected(state, input(state, { type: 'PLAY_CARD', cardId: 'JS' }, 0), 'WRONG_PHASE');
        const eligible = [0, 1, 2, 3].find(seat => engineLegalActions(state, seat).length > 0);
        result = eligible === undefined ? timeout(state, state.pairWindow.deadline)
          : step(state, { type: 'DECLARE_PAIR' }, eligible);
      } else result = timeout(state);
      commands.push(result.command); events.push(...result.events); state = result.state;
      const viewer = count % 4;
      const view = engineView(state, viewer);
      expect(view.version).toBe(state.version);
      if (engineToAct(state) !== null) expect(engineLegalActions(state, engineToAct(state)).length).toBeGreaterThan(0);
      expect(++count).toBeLessThan(4000);
    }
    expect(state.phase).toBe('FINISHED');
    expect(state.summary.tricks).toHaveLength(8);
    expect(state.summary.declaringPoints + state.summary.defendingPoints).toBe(cfg.totalPoints);
    expect(engineView(state, 'spectator').summary).toEqual(state.summary);
    if (name === 'manual-pairs') expect(windows).toBeGreaterThan(0);
    const replay = replayEngine(initial, JSON.parse(JSON.stringify(commands)));
    expect(replay.state).toEqual(state);
    expect(replay.events).toEqual(events);
    const scored = events.filter(entry => entry.event.type === 'HAND_SCORED');
    expect(new Set(scored.map(entry => entry.event.dealNumber)).size).toBe(scored.length);
    expect(() => replayEngine(initial, [{}])).toThrow('Replay rejected');
    rejected(state, input(state, { type: 'TIMEOUT', decisionVersion: state.version }), 'MATCH_OVER');
  });

  test('invariants detect corrupted card locations, scores, and lifecycle', () => {
    let state = toSelection();
    state = timeout(state).state;
    while (state.phase !== 'PLAY') state = timeout(state).state;
    expect(() => assertEngineInvariants({ ...state, version: -1 })).toThrow('version');
    expect(() => assertEngineInvariants({ ...state, play: { ...state.play, hands: { ...state.play.hands, 0: [] } } })).toThrow('card locations');
    expect(() => assertEngineInvariants({ ...state, play: { ...state.play, capturedPoints: { A: 99, B: 0 } } })).toThrow('captured points');
    expect(() => assertEngineInvariants({ ...state, contract: { ...state.contract, effectiveContract: 15 } })).toThrow('effective contract');
    expect(() => assertEngineInvariants({ ...state, progress: { ...state.progress, winner: 'A' } })).toThrow('winner/status');
  });
});
