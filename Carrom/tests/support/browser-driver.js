// Injected INSIDE the application closure, exclusively by Carrom/tests/server.cjs.
// No scenario resolution is reimplemented here: use the production Rules and Physics.
window.__carromTest = Object.freeze({
  snapshot() {
    return JSON.parse(JSON.stringify({ ...state, aimAngle, config: CONFIG }));
  },
  load(options = {}) {
    resetGame();
    if (options.currentPlayer) state.currentPlayer = options.currentPlayer;
    for (const id of options.pocketedIds || []) {
      const coin = state.coins.find(c => c.id === id);
      if (!coin || coin.type === 'queen') throw new Error(`Invalid fixture coin: ${id}`);
      coin.pocketed = true;
      coin.creditedTo = coin.type === 'white' ? 1 : 2;
    }
    if (options.queenCoveredBy) {
      state.coins.find(c => c.type === 'queen').pocketed = true;
      state.queenStatus = 'Covered';
      state.queenCoveredBy = options.queenCoveredBy;
    }
    if (options.positions) {
      for (const position of options.positions) {
        const coin = state.coins.find(c => c.id === position.id);
        if (!coin || coin.pocketed) throw new Error(`Invalid positioned coin: ${position.id}`);
        Object.assign(coin, { x: position.x, y: position.y });
      }
    }
    Rules.syncTotals(state);
    Rules.resetStriker(state);
    aimAngle = Rules.defaultAim(state.currentPlayer);
    render();
  },
  shot(options = {}) {
    if (!Rules.beginShot(state, Rules.defaultAim(state.currentPlayer), 50)) throw new Error('Cannot begin scenario shot');
    // Deterministic end-of-physics events use the SAME pocket collection as real physics.
    for (const id of options.pocketedIds || []) {
      const disk = [state.striker, ...state.coins].find(c => c.id === id);
      if (!disk || disk.pocketed) throw new Error(`Invalid new pocket: ${id}`);
      if (disk.type === 'striker' && !CONFIG.strikerCanBePocketed) {
        throw new Error('Striker pockets are disabled by the user-confirmed rules');
      }
      Rules.recordPocket(state, disk);
    }
    if (options.foul) Rules.recordFoul(state, options.foul);
    for (const disk of [state.striker, ...state.coins]) disk.vx = disk.vy = 0;
    finishShot();
  },
  resolveAgain() { finishShot(); },
});
