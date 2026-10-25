const { describe, test, expect } = require('@jest/globals');
const {
  auctionActionSchema, createAuction, createSecondRoundAuction,
  legalAuctionActions, applyAuctionAction, applyAuctionTimeout,
} = require('../../src/domain/auction.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { rulesetSchema } = require('../../src/domain/ruleset.ts');

const standard = PRESETS['29-standard'];
const simplified = PRESETS['29-simplified'];
const twentyEight = PRESETS['28-standard'];
const bid = amount => ({ type: 'BID', amount });
const pass = { type: 'PASS' };
const hold = { type: 'HOLD' };

function act(state, action, seat = state.toAct) {
  const before = structuredClone(state);
  const result = applyAuctionAction(state, seat, action);
  expect(state).toEqual(before);
  expect(result.ok).toBe(true);
  return result;
}

function reject(state, action, code, seat = state.toAct) {
  const before = structuredClone(state);
  const result = applyAuctionAction(state, seat, action);
  expect(result).toEqual({ ok: false, state, events: [], code });
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}

function custom(name, changes) {
  const { maxBid, totalPoints, ...input } = structuredClone(PRESETS[name]);
  return rulesetSchema.parse({ ...input, ...changes });
}

describe('auction command boundary', () => {
  test.each([bid(16), pass, hold])('accepts %p', action => {
    expect(auctionActionSchema.safeParse(action).success).toBe(true);
  });
  test.each([bid(16.5), bid('16'), bid(NaN), bid(Infinity), {}, null,
    { type: 'PASS', amount: 16 }, { type: 'PLAY_CARD', cardId: 'JS' }])('rejects %p', action => {
    expect(auctionActionSchema.safeParse(action).success).toBe(false);
  });
});

describe('priority duel (T07-T11)', () => {
  test('eldest opens and the section 7.2 example produces P2 at 19', () => {
    let { state } = createAuction(standard, 0);
    expect(state.order).toEqual([3, 2, 1, 0]);
    expect(state.toAct).toBe(3);
    expect(legalAuctionActions(state)).toEqual(Array.from({ length: 13 }, (_, i) => bid(16 + i)));
    const sequence = [[3, bid(16)], [2, bid(17)], [3, hold], [2, bid(18)],
      [3, pass], [1, pass], [0, bid(19)], [2, hold], [0, pass]];
    let result;
    for (const [seat, action] of sequence) {
      expect(state.toAct).toBe(seat);
      result = act(state, action, seat);
      state = result.state;
    }
    expect(state).toMatchObject({ status: 'WON', holder: 2, highBidder: 2, current: 19, toAct: null });
    expect(result.events.at(-1)).toEqual({ type: 'AUCTION_WON', round: 1, declarer: 2, contract: 19, trumpSelection: 'initial' });
    expect(legalAuctionActions(state)).toEqual([]);
    reject(state, bid(20), 'WRONG_PHASE', 2);
  });

  test('challenger must raise; equal holder BID normalizes to HOLD', () => {
    let { state } = createAuction(standard, 0);
    state = act(state, bid(16)).state;
    reject(state, bid(16), 'BID_TOO_LOW');
    reject(state, hold, 'HOLD_NOT_ALLOWED');
    state = act(state, bid(17)).state;
    const result = act(state, bid(17));
    expect(result.events).toEqual([{ type: 'BID_HELD', seat: 3, amount: 17, auto: false }]);
    expect(result.state.history.at(-1)).toEqual({ seat: 3, action: 'HOLD', amount: 17, auto: false });
    expect(result.state.toAct).toBe(2);
  });

  test('holder can raise instead of holding and face their partner later', () => {
    let { state } = createAuction(standard, 0);
    for (const action of [bid(16), bid(17), bid(19), pass]) state = act(state, action).state;
    expect(state).toMatchObject({ holder: 3, toAct: 1, current: 19 });
    reject(state, bid(20), 'NOT_YOUR_TURN', 2);
    state = act(state, bid(20)).state;
    expect(state.toAct).toBe(3);
    state = act(state, pass).state;
    expect(state).toMatchObject({ holder: 1, highBidder: 1, toAct: 0 });
  });

  test.each([hold, bid(28)])('holder retains the right to match maximum with %p', action => {
    let { state } = createAuction(standard, 0);
    state = act(state, bid(16)).state;
    state = act(state, bid(28)).state;
    expect(state).toMatchObject({ status: 'BIDDING', toAct: 3 });
    expect(legalAuctionActions(state)).toEqual([hold, pass]);
    const result = act(state, action);
    expect(result.state).toMatchObject({ status: 'WON', highBidder: 3, current: 28 });
    expect(result.events.filter(event => event.type === 'PASSED')).toEqual([
      { type: 'PASSED', seat: 2, auto: true },
      { type: 'PASSED', seat: 1, auto: true },
      { type: 'PASSED', seat: 0, auto: true },
    ]);
  });

  test('holder may pass at maximum, leaving challenger as declarer', () => {
    let { state } = createAuction(standard, 0);
    for (const action of [bid(16), bid(28), pass]) state = act(state, action).state;
    expect(state).toMatchObject({ status: 'WON', highBidder: 2, holder: 2, current: 28 });
  });

  test('maximum opening auto-passes all challengers', () => {
    const result = act(createAuction(standard, 0).state, bid(28));
    expect(result.state.status).toBe('WON');
    expect(result.state.history.map(entry => entry.auto)).toEqual([false, true, true, true]);
  });

  test.each([15, 29, 16.5, NaN, Infinity, '16'])('rejects invalid bid %p', amount => {
    reject(createAuction(standard, 0).state, bid(amount), 'BID_INVALID');
  });

  test('forced opener cannot pass or hold', () => {
    const { state } = createAuction(standard, 0);
    reject(state, pass, 'WRONG_PHASE');
    reject(state, hold, 'HOLD_NOT_ALLOWED');
    reject(state, bid(16), 'NOT_YOUR_TURN', 0);
  });

  test.each(['29-standard', '29-simplified'])('%s permits optional opening and all-pass redeal', name => {
    const cfg = custom(name, { openingBidForced: false });
    let { state } = createAuction(cfg, 0);
    let result;
    for (let i = 0; i < 4; i++) {
      result = act(state, pass);
      state = result.state;
    }
    expect(state).toMatchObject({ status: 'ALL_PASSED', highBidder: null, current: null, toAct: null });
    expect(result.events.at(-1)).toEqual({ type: 'AUCTION_ALL_PASSED', policy: 'redealSameDealer' });
  });

  test.each([1, 2, 3])('optional duel opening after %s passes', count => {
    const cfg = custom('29-standard', { openingBidForced: false });
    let { state } = createAuction(cfg, 0);
    for (let i = 0; i < count; i++) state = act(state, pass).state;
    const opener = state.toAct;
    state = act(state, bid(16)).state;
    while (state.toAct !== null) state = act(state, pass).state;
    expect(state).toMatchObject({ status: 'WON', holder: opener, highBidder: opener, current: 16 });
  });
});

describe('open ascending (T12, T13)', () => {
  test('ends only after all other players pass', () => {
    let { state } = createAuction(simplified, 0);
    for (const action of [bid(16), bid(17), bid(18), pass]) state = act(state, action).state;
    expect(state).toMatchObject({ status: 'BIDDING', highBidder: 3, toAct: 1 });
    for (const action of [bid(19), bid(20)]) state = act(state, action).state;
    expect(state).toMatchObject({ status: 'BIDDING', highBidder: 2, toAct: 3 });
    state = act(state, pass).state;
    state = act(state, pass).state;
    expect(state).toMatchObject({ status: 'WON', highBidder: 2, current: 20 });
  });

  test('three passes after opening end auction; passed player cannot rejoin', () => {
    let { state } = createAuction(simplified, 0);
    state = act(state, bid(16)).state;
    state = act(state, pass).state;
    reject(state, bid(17), 'NOT_YOUR_TURN', 2);
    state = act(state, pass).state;
    state = act(state, pass).state;
    expect(state).toMatchObject({ status: 'WON', highBidder: 1, current: 16 });
  });

  test('Twenty-Eight requires 20 to overbid partner', () => {
    let { state } = createAuction(twentyEight, 0);
    state = act(state, bid(16)).state;
    state = act(state, pass).state;
    reject(state, bid(19), 'PARTNER_OVERBID_TOO_LOW');
    expect(legalAuctionActions(state).filter(action => action.type === 'BID')[0]).toEqual(bid(20));
    expect(act(state, bid(20)).state.highBidder).toBe(1);
  });

  test('hold is not legal and equal bids are too low', () => {
    let { state } = createAuction(simplified, 0);
    reject(state, hold, 'HOLD_NOT_ALLOWED');
    state = act(state, bid(16)).state;
    reject(state, bid(16), 'BID_TOO_LOW');
  });

  test('maximum opening skips every other bidder with automatic passes', () => {
    const result = act(createAuction(simplified, 2).state, bid(28));
    expect(result.state).toMatchObject({ status: 'WON', highBidder: 3, current: 28 });
    expect(result.events).toEqual([
      { type: 'BID_MADE', seat: 3, amount: 28, auto: false },
      { type: 'PASSED', seat: 0, auto: true },
      { type: 'PASSED', seat: 1, auto: true },
      { type: 'PASSED', seat: 2, auto: true },
      { type: 'AUCTION_WON', round: 1, declarer: 3, contract: 28, trumpSelection: 'initial' },
    ]);
  });

  test('optional opener can pass before another player bids', () => {
    const cfg = custom('29-simplified', { openingBidForced: false });
    let { state } = createAuction(cfg, 0);
    state = act(state, pass).state;
    state = act(state, bid(17)).state;
    state = act(state, pass).state;
    state = act(state, pass).state;
    expect(state).toMatchObject({ status: 'WON', highBidder: 2, current: 17 });
  });
});

describe('Twenty-Eight second round (T14-T16 auction results)', () => {
  test('all passes preserve the declarer, contract, and trump', () => {
    const previous = { declarer: 2, contract: 18 };
    let { state } = createSecondRoundAuction(twentyEight, 0, previous);
    previous.contract = 28;
    expect(state).toMatchObject({ round: 2, active: [3, 2, 1, 0], toAct: 3 });
    let result;
    for (let i = 0; i < 4; i++) {
      result = act(state, pass);
      state = result.state;
    }
    expect(result.events.at(-1)).toEqual({ type: 'AUCTION_WON', round: 2, declarer: 2, contract: 18, trumpSelection: 'unchanged' });
  });

  test.each([[3, 'reselect'], [2, 'unchanged'], [0, 'reselect']])('seat %s wins with trump %s', (declarer, trumpSelection) => {
    let { state } = createSecondRoundAuction(twentyEight, 0, { declarer: 2, contract: 18 });
    while (state.toAct !== declarer) state = act(state, pass).state;
    let result = act(state, bid(24));
    state = result.state;
    while (state.toAct !== null) {
      result = act(state, pass);
      state = result.state;
    }
    expect(result.events.at(-1)).toEqual({ type: 'AUCTION_WON', round: 2, declarer, contract: 24, trumpSelection });
  });

  test('resets first-round passes by creating a fresh active set', () => {
    let { state } = createAuction(twentyEight, 0);
    state = act(state, bid(18)).state;
    while (state.toAct !== null) state = act(state, pass).state;
    const second = createSecondRoundAuction(twentyEight, 0, { declarer: state.highBidder, contract: state.current }).state;
    expect(second.active).toEqual([3, 2, 1, 0]);
    expect(second.history).toEqual([]);
    expect(second.toAct).toBe(3);
  });

  test('second-round minimum applies, including to previous declarer', () => {
    const { state } = createSecondRoundAuction(twentyEight, 0, { declarer: 3, contract: 18 });
    reject(state, bid(23), 'BID_TOO_LOW');
    expect(legalAuctionActions(state)[0]).toEqual(bid(24));
    expect(act(state, bid(24)).state.current).toBe(24);
  });

  test('second round may circle past high bidder and accepts later raises', () => {
    let { state } = createSecondRoundAuction(twentyEight, 0, { declarer: 0, contract: 18 });
    for (const action of [bid(24), bid(25), pass, pass]) state = act(state, action).state;
    expect(state).toMatchObject({ status: 'BIDDING', toAct: 3, highBidder: 2 });
    state = act(state, bid(26)).state;
    state = act(state, pass).state;
    expect(state).toMatchObject({ status: 'WON', highBidder: 3, current: 26 });
  });

  test('maximum original contract auto-passes all seats at creation', () => {
    const result = createSecondRoundAuction(twentyEight, 0, { declarer: 3, contract: 28 });
    expect(result.state).toMatchObject({ status: 'WON', highBidder: 3, current: 28, toAct: null });
    expect(result.state.history).toHaveLength(4);
    expect(result.state.history.every(entry => entry.auto)).toBe(true);
    expect(result.events.at(-1).trumpSelection).toBe('unchanged');
  });

  test('maximum new contract auto-passes everyone else', () => {
    const { state } = createSecondRoundAuction(twentyEight, 0, { declarer: 0, contract: 18 });
    expect(act(state, bid(28)).state).toMatchObject({ status: 'WON', current: 28, highBidder: 3 });
  });

  test('rejects disabled second rounds and invalid existing contracts', () => {
    expect(() => createSecondRoundAuction(standard, 0, { declarer: 0, contract: 16 })).toThrow(RangeError);
    for (const contract of [13, 29, 18.5, NaN]) {
      expect(() => createSecondRoundAuction(twentyEight, 0, { declarer: 0, contract })).toThrow(RangeError);
    }
  });
});

describe('deterministic auction timeouts', () => {
  test('forced opener bids the minimum; other turns pass', () => {
    const { state } = createAuction(standard, 0);
    const opening = applyAuctionTimeout(state);
    expect(opening.ok).toBe(true);
    expect(opening.state.history).toEqual([{ seat: 3, action: 'BID', amount: 16, auto: true }]);
    const challenger = applyAuctionTimeout(opening.state);
    expect(challenger.state.history.at(-1)).toEqual({ seat: 2, action: 'PASS', auto: true });
  });

  test('holder timeout concedes duel; optional opener and second round pass', () => {
    let { state } = createAuction(standard, 0);
    state = act(state, bid(16)).state;
    state = act(state, bid(17)).state;
    expect(applyAuctionTimeout(state).state).toMatchObject({ holder: 2, toAct: 1 });
    const optional = createAuction(custom('29-standard', { openingBidForced: false }), 0).state;
    expect(applyAuctionTimeout(optional).state.history[0].action).toBe('PASS');
    const second = createSecondRoundAuction(twentyEight, 0, { declarer: 0, contract: 18 }).state;
    expect(applyAuctionTimeout(second).state.history[0].action).toBe('PASS');
  });

  test('finished auction has no timeout action', () => {
    const state = act(createAuction(standard, 0).state, bid(28)).state;
    expect(applyAuctionTimeout(state)).toEqual({ ok: false, state, events: [], code: 'WRONG_PHASE' });
  });
});

describe('auction legal-action simulations', () => {
  test.each(Object.keys(PRESETS))('%s always terminates with legal bounded bids and replayable transitions', name => {
    let seed = 29;
    const randomIndex = length => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % length;
    };
    for (let run = 0; run < 500; run++) {
      const cfg = PRESETS[name];
      let { state } = createAuction(cfg, run % 4);
      for (let round = 1; round <= (cfg.secondRound.enabled ? 2 : 1); round++) {
        let commands = 0;
        while (state.toAct !== null) {
          const actions = legalAuctionActions(state);
          expect(actions.length).toBeGreaterThan(0);
          const action = actions[randomIndex(actions.length)];
          const result = applyAuctionAction(state, state.toAct, action);
          expect(result).toEqual(applyAuctionAction(state, state.toAct, action));
          expect(result.ok).toBe(true);
          state = result.state;
          const passed = state.history.filter(entry => entry.action === 'PASS').map(entry => entry.seat);
          expect(new Set(passed).size).toBe(passed.length);
          expect(state.active.every(seat => !passed.includes(seat))).toBe(true);
          if (state.toAct !== null) expect(state.active).toContain(state.toAct);
          expect(++commands).toBeLessThan(100);
        }
        expect(state.status).toBe('WON');
        expect(state.current).toBeGreaterThanOrEqual(cfg.minBid);
        expect(state.current).toBeLessThanOrEqual(cfg.maxBid);
        expect(state.history.filter(entry => entry.action === 'BID').map(entry => entry.amount))
          .toEqual(state.history.filter(entry => entry.action === 'BID').map(entry => entry.amount).sort((a, b) => a - b));
        if (round === 1 && cfg.secondRound.enabled) {
          state = createSecondRoundAuction(cfg, run % 4, { declarer: state.highBidder, contract: state.current }).state;
        }
      }
    }
  });
});
