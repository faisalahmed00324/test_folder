const { describe, test, expect } = require('@jest/globals');
const { baselineBotAction } = require('../../src/application/baseline-bot.ts');
const { defaultTrumpSelection, weakestPlayAction } = require('../../src/domain/decision-policy.ts');
const { createEngine, applyEngineCommand, engineView, engineToAct } = require('../../src/domain/engine.ts');
const { createDeck } = require('../../src/domain/cards.ts');
const { PRESETS } = require('../../src/domain/presets.ts');

describe('filtered-view baseline bot decisions', () => {
  test.each(Object.keys(PRESETS))('%s chooses legal actions directly from production seat views', preset => {
    let state = createEngine(PRESETS[preset], 0);
    state = applyEngineCommand(state, { actor: 'system', now: 1000, expectedVersion: 0,
      action: { type: 'START_DEAL', deck: createDeck() } }).state;
    const phases = new Set();
    for (let count = 0; state.progress.status === 'IN_PROGRESS' && state.progress.handNumber === 1; count++) {
      expect(count).toBeLessThan(150);
      const viewer = engineView(state, engineToAct(state));
      const before = structuredClone(viewer);
      phases.add(viewer.phase);
      const action = baselineBotAction(viewer);
      expect(viewer).toEqual(before);
      expect(action).not.toBeNull();
      expect(viewer.legalActions).toContainEqual(action);
      const result = applyEngineCommand(state, { actor: viewer.viewer, now: 1001 + count,
        expectedVersion: state.version, action });
      expect(result.ok).toBe(true);
      state = result.state;
    }
    expect(phases.has('TRUMP_SELECTION')).toBe(true);
    expect(phases.has('PLAY')).toBe(true);
  });

  test('prefers pass and weakest legal play over optional revelation', () => {
    const view = { phase: 'AUCTION', ruleset: PRESETS['29-standard'], legalActions: [
      { type: 'BID', amount: 18 }, { type: 'HOLD', amount: 16 }, { type: 'PASS' },
    ] };
    expect(baselineBotAction(view)).toEqual({ type: 'PASS' });
    expect(baselineBotAction({ phase: 'PLAY', legalActions: [
      { type: 'CALL_TRUMP' }, { type: 'PLAY_CARD', cardId: 'JS' },
      { type: 'PLAY_CARD', cardId: '7S' }, { type: 'PLAY_CARD', cardId: '7C' },
    ] })).toEqual({ type: 'PLAY_CARD', cardId: '7C' });
    expect(baselineBotAction({ phase: 'PLAY', legalActions: [{ type: 'REVEAL_TRUMP' }] })).toEqual({ type: 'REVEAL_TRUMP' });
    expect(baselineBotAction({ phase: 'PAIR_WINDOW', legalActions: [{ type: 'DECLARE_PAIR' }] })).toEqual({ type: 'DECLARE_PAIR' });
  });

  test('has no decision for spectators, closed windows or nondecision phases', () => {
    const view = engineView(createEngine(PRESETS['29-standard'], 0), 'spectator');
    expect(baselineBotAction(view)).toBeNull();
    expect(baselineBotAction({ phase: 'REDEAL_WINDOW', legalActions: [{ type: 'REQUEST_REDEAL' }] })).toBeNull();
    expect(baselineBotAction({ phase: 'AUCTION', legalActions: [{ type: 'HOLD' }], ruleset: PRESETS['29-standard'] })).toBeNull();
  });

  test('selection shares the timeout point/count/rank/tie policy without mutating received order', () => {
    const hand = ['JC', '7C', '9D', 'AD'];
    const before = [...hand];
    expect(defaultTrumpSelection(hand, 'faceDownCard')).toEqual({ cardId: '7C' });
    expect(defaultTrumpSelection(hand, 'external')).toEqual({ suit: 'C' });
    expect(defaultTrumpSelection(['7S', '7H', '7D', '7C'], 'external')).toEqual({ suit: 'C' });
    expect(hand).toEqual(before);
    expect(() => defaultTrumpSelection([], 'external')).toThrow('requires cards');
    expect(() => weakestPlayAction([])).toThrow('No legal play');
  });
});
