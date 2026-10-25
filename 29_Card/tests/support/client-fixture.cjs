const { createEngine, applyEngineCommand, engineView } = require('../../src/domain/engine.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { createDeck } = require('../../src/domain/cards.ts');

function clientSnapshot(viewer = 3) {
  const initial = createEngine(PRESETS['29-standard'], 0);
  const { state } = applyEngineCommand(initial, { actor: 'system', now: 1000, expectedVersion: 0,
    action: { type: 'START_DEAL', deck: createDeck() } });
  return { ...engineView(state, viewer), deadline: 21000, remainingMs: 20000,
    timeBankMs: viewer === 'spectator' ? null : 30000,
    seats: Array.from({ length: 4 }, () => ({ connected: true, controller: 'human', reclaimPending: false })) };
}
function completedSummary() {
  let state = createEngine(PRESETS['29-standard'], 0);
  state = applyEngineCommand(state, { actor: 'system', now: 1000, expectedVersion: 0,
    action: { type: 'START_DEAL', deck: createDeck() } }).state;
  for (let count = 0; state.summary === null && count < 150; count++) {
    const result = applyEngineCommand(state, { actor: 'system', now: state.lastCommandTime + 5000,
      expectedVersion: state.version, action: { type: 'TIMEOUT', decisionVersion: state.version } });
    if (!result.ok) throw new Error(`Fixture hand failed: ${result.code}`);
    state = result.state;
  }
  if (!state.summary) throw new Error('Fixture hand did not finish');
  return state.summary;
}
module.exports = { clientSnapshot, completedSummary };
