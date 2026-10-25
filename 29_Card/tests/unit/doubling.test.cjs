const { describe, test, expect } = require('@jest/globals');
const { PRESETS } = require('../../src/domain/presets.ts');
const { nextSeat, partnerSeat } = require('../../src/domain/seats.ts');
const {
  doublingActionSchema, createDoubling, legalDoublingActions, applyDoublingAction, applyDoublingTimeout,
} = require('../../src/domain/doubling.ts');

function act(state, type) {
  const before = structuredClone(state);
  const result = applyDoublingAction(state, state.toAct, { type });
  expect(result.ok).toBe(true);
  expect(state).toEqual(before);
  return result;
}

describe('doubling boundary', () => {
  test.each(['DOUBLE', 'REDOUBLE', 'PASS_DOUBLE'])('accepts %s', type => {
    expect(doublingActionSchema.safeParse({ type }).success).toBe(true);
  });
  test.each([{}, null, { type: 'PASS' }, { type: 'DOUBLE', stake: 8 }])('rejects %p', payload => {
    expect(doublingActionSchema.safeParse(payload).success).toBe(false);
  });
});

describe('doubling decision sequence (T20)', () => {
  test.each([0, 1, 2, 3])('defenders then declarers act in order for declarer %s', declarer => {
    const cfg = PRESETS['29-standard'];
    const state = createDoubling(cfg, declarer);
    const defender = nextSeat(declarer, cfg.direction);
    expect(state.toAct).toBe(defender);
    expect(legalDoublingActions(state)).toEqual([{ type: 'DOUBLE' }, { type: 'PASS_DOUBLE' }]);
    const passed = act(state, 'PASS_DOUBLE');
    expect(passed.state.toAct).toBe(partnerSeat(defender));
    const doubled = act(passed.state, 'DOUBLE');
    expect(doubled.state).toMatchObject({ stakeMultiplier: 2, doubledBy: partnerSeat(defender), toAct: declarer });
    expect(legalDoublingActions(doubled.state)).toEqual([{ type: 'REDOUBLE' }, { type: 'PASS_DOUBLE' }]);
    const declaringPass = act(doubled.state, 'PASS_DOUBLE');
    expect(declaringPass.state.toAct).toBe(partnerSeat(declarer));
    const redoubled = act(declaringPass.state, 'REDOUBLE');
    expect(redoubled.state).toMatchObject({ stakeMultiplier: 4, stage: 'DONE', toAct: null, redoubledBy: partnerSeat(declarer) });
    expect(redoubled.events).toEqual([{ type: 'REDOUBLED', seat: partnerSeat(declarer), stakeMultiplier: 4, auto: false }]);
    expect(legalDoublingActions(redoubled.state)).toEqual([]);
  });

  test('first double and first redouble skip their respective partners', () => {
    const initial = createDoubling(PRESETS['29-standard'], 0);
    const doubled = act(initial, 'DOUBLE');
    expect(doubled.state.toAct).toBe(0);
    expect(doubled.events).toEqual([{ type: 'DOUBLED', seat: 3, stakeMultiplier: 2, auto: false }]);
    expect(act(doubled.state, 'REDOUBLE').state).toMatchObject({ stage: 'DONE', redoubledBy: 0, stakeMultiplier: 4 });
  });

  test('both defenders passing keeps stake one', () => {
    let state = createDoubling(PRESETS['29-standard'], 0);
    state = act(state, 'PASS_DOUBLE').state;
    state = act(state, 'PASS_DOUBLE').state;
    expect(state).toMatchObject({ stage: 'DONE', stakeMultiplier: 1, doubledBy: null });
  });

  test('both declarers passing keeps stake two', () => {
    let state = act(createDoubling(PRESETS['29-standard'], 0), 'DOUBLE').state;
    state = act(state, 'PASS_DOUBLE').state;
    expect(act(state, 'PASS_DOUBLE').state).toMatchObject({ stage: 'DONE', stakeMultiplier: 2, redoubledBy: null });
  });

  test.each(['29-simplified', '28-standard'])('%s skips disabled doubling', name => {
    const state = createDoubling(PRESETS[name], 0);
    expect(state).toMatchObject({ stage: 'DONE', toAct: null, stakeMultiplier: 1 });
    expect(legalDoublingActions(state)).toEqual([]);
    expect(applyDoublingAction(state, 0, { type: 'DOUBLE' })).toEqual({ ok: false, state, events: [], code: 'WRONG_PHASE' });
  });

  test('rejects wrong actors and stage-incompatible actions without mutation', () => {
    const initial = createDoubling(PRESETS['29-standard'], 0);
    const before = structuredClone(initial);
    expect(applyDoublingAction(initial, 0, { type: 'DOUBLE' })).toEqual({ ok: false, state: initial, events: [], code: 'NOT_YOUR_TURN' });
    expect(applyDoublingAction(initial, 3, { type: 'REDOUBLE' })).toEqual({ ok: false, state: initial, events: [], code: 'DOUBLE_NOT_ALLOWED' });
    expect(initial).toEqual(before);
    const doubled = act(initial, 'DOUBLE').state;
    expect(applyDoublingAction(doubled, 0, { type: 'DOUBLE' }).code).toBe('DOUBLE_NOT_ALLOWED');
  });

  test('timeouts pass deterministically and cannot act on a finished phase', () => {
    const initial = createDoubling(PRESETS['29-standard'], 0);
    const result = applyDoublingTimeout(initial);
    expect(result.events).toEqual([{ type: 'DOUBLE_PASSED', seat: 3, stakeMultiplier: 1, auto: true }]);
    const done = applyDoublingTimeout(result.state).state;
    expect(applyDoublingTimeout(done)).toEqual({ ok: false, state: done, events: [], code: 'WRONG_PHASE' });
    const redouble = act(initial, 'DOUBLE').state;
    expect(applyDoublingTimeout(redouble).events[0]).toMatchObject({ type: 'DOUBLE_PASSED', auto: true, stakeMultiplier: 2 });
  });
});
