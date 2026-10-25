const { describe, test, expect } = require('@jest/globals');
const { rulesetSchema } = require('../../src/domain/ruleset.ts');
const { PRESETS } = require('../../src/domain/presets.ts');

function inputFor(name = '29-standard') {
  const { totalPoints, maxBid, ...input } = structuredClone(PRESETS[name]);
  return input;
}

describe('versioned rulesets', () => {
  test.each(Object.keys(PRESETS))('%s validates and derives point limits', name => {
    const cfg = rulesetSchema.parse(inputFor(name));
    expect(cfg).toEqual(PRESETS[name]);
    expect(cfg.totalPoints).toBe(28);
    expect(cfg.maxBid).toBe(28);
    expect(cfg.rulesetId).toBe(`${name}@1.0.0`);
  });

  test('presets preserve the required differences', () => {
    expect(PRESETS['29-standard']).toMatchObject({
      direction: 'counterclockwise', minBid: 16, auctionStyle: 'priorityDuel',
      trumpIndicator: 'faceDownCard', callerMustTrump: true,
      doubling: { enabled: true }, pair: { enabled: true },
    });
    expect(PRESETS['29-simplified']).toMatchObject({
      direction: 'clockwise', auctionStyle: 'openAscending', trumpIndicator: 'external',
      revealPolicy: 'mandatoryOnFirstVoid', declarerRevealPlay: 'anyCard',
      revealTrickSemantics: 'wholeTrick', doubling: { enabled: false }, pair: { enabled: false },
    });
    expect(PRESETS['28-standard']).toMatchObject({
      minBid: 14, partnerOverbidMin: 20, secondRound: { enabled: true, minBid: 24 },
      declarerRevealPlay: 'indicatorCard', scoreBands: [
        { from: 14, to: 19, win: 1, loss: 2 },
        { from: 20, to: 28, win: 2, loss: 3 },
      ],
    });
  });

  test('parsing makes an independent deeply frozen copy', () => {
    const input = inputFor();
    const cfg = rulesetSchema.parse(input);
    input.scoreBands[0].win = 99;
    input.doubling.stakes[0] = 99;
    expect(cfg.scoreBands[0].win).toBe(1);
    expect(cfg.doubling.stakes).toEqual([1, 2, 4]);
    for (const value of [PRESETS, cfg, cfg.secondRound, cfg.doubling, cfg.doubling.stakes,
      cfg.pair, cfg.scoreBands, cfg.scoreBands[0], cfg.matchEnd]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  test('bonus changes derived total and maximum bid', () => {
    const input = inputFor();
    input.lastTrickBonus = 1;
    input.scoreBands[0].to = 29;
    expect(rulesetSchema.parse(input)).toMatchObject({ totalPoints: 29, maxBid: 29 });
  });

  test.each([
    ['unversioned ID', { rulesetId: '29-standard' }],
    ['invalid version', { rulesetId: '29-standard@01.0.0' }],
    ['unknown field', { secretRule: true }],
    ['untrusted derived field', { maxBid: 99 }],
    ['unsupported bonus', { lastTrickBonus: 2 }],
    ['minimum above maximum', { minBid: 30 }],
    ['fractional minimum', { minBid: 16.5 }],
    ['partner minimum below range', { partnerOverbidMin: 15 }],
    ['partner minimum above range', { partnerOverbidMin: 29 }],
    ['indicator with external trump', { trumpIndicator: 'external', declarerRevealPlay: 'indicatorCard' }],
    ['seventh card with external trump', { trumpIndicator: 'external', seventhCardTrump: true }],
    ['external any-trump obligation', { trumpIndicator: 'external' }],
    ['second-round minimum too low', { secondRound: { enabled: true, minBid: 16 } }],
    ['second-round minimum too high', { secondRound: { enabled: true, minBid: 29 } }],
    ['unsupported second-round combination', { secondRound: { enabled: true, minBid: 24 } }],
    ['pair floor below minimum', { pair: { enabled: true, adjustment: 4, floor: 15, ceiling: 28, windowMs: 4000 } }],
    ['pair ceiling above total', { pair: { enabled: true, adjustment: 4, floor: 16, ceiling: 29, windowMs: 4000 } }],
    ['inverted pair bounds', { pair: { enabled: true, adjustment: 4, floor: 25, ceiling: 20, windowMs: 4000 } }],
    ['score band gap', { scoreBands: [{ from: 16, to: 27, win: 1, loss: 1 }] }],
    ['score band overlap', { scoreBands: [{ from: 16, to: 28, win: 1, loss: 1 }, { from: 20, to: 28, win: 2, loss: 2 }] }],
    ['score band outside range', { scoreBands: [{ from: 15, to: 28, win: 1, loss: 1 }] }],
    ['inverted score band', { scoreBands: [{ from: 28, to: 16, win: 1, loss: 1 }] }],
    ['empty score bands', { scoreBands: [] }],
    ['nonpositive win threshold', { matchEnd: { winAt: 0, loseAt: -6 } }],
    ['nonnegative loss threshold', { matchEnd: { winAt: 6, loseAt: 0 } }],
    ['unsupported stake', { doubling: { enabled: true, timing: 'afterFullDeal', stakes: [1, 2, 8] } }],
  ])('rejects %s without changing input', (_label, changes) => {
    const input = { ...inputFor(), ...changes };
    const before = structuredClone(input);
    expect(rulesetSchema.safeParse(input).success).toBe(false);
    expect(input).toEqual(before);
  });

  test.each(['auctionStyle', 'trumpIndicator', 'seventhCardTrump', 'doubling'])('rejects unsupported second-round %s', field => {
    const input = inputFor('28-standard');
    input[field] = {
      auctionStyle: 'priorityDuel', trumpIndicator: 'external', seventhCardTrump: true,
      doubling: { enabled: true, timing: 'beforeSecondDeal', stakes: [1, 2, 4] },
    }[field];
    expect(rulesetSchema.safeParse(input).success).toBe(false);
  });
});
