const { describe, test, expect } = require('@jest/globals');

require('../../carrom-rules.js');
const Rules = globalThis.CarromRules;

describe('Carrom rules', () => {
  test('creates independent games with the correct rack and initial turn', () => {
    const state = Rules.createGame();
    const other = Rules.createGame();

    expect(state.currentPlayer).toBe(1);
    expect(state.coins).toHaveLength(19);
    expect(state.coins.filter(coin => coin.type === 'white')).toHaveLength(9);
    expect(state.coins.filter(coin => coin.type === 'black')).toHaveLength(9);
    expect(state.coins.find(coin => coin.type === 'queen')).toMatchObject({
      x: 300, y: 300, pocketed: false,
    });
    state.coins[0].pocketed = true;
    expect(other.coins[0].pocketed).toBe(false);
  });

  test.each([NaN, Infinity, 0, 101])('rejects invalid shot power %s without changing state', power => {
    const state = Rules.createGame();
    const before = structuredClone(state);

    expect(Rules.beginShot(state, -Math.PI / 2, power)).toBe(false);
    expect(state).toEqual(before);
  });

  test('rejects striker placement outside the baseline or overlapping a coin', () => {
    const state = Rules.createGame();
    const original = { ...state.striker };
    Object.assign(state.coins[0], { x: 300, y: Rules.CONFIG.baselines[1] });

    expect(Rules.placeStriker(state, Rules.CONFIG.baselineMinX - 1)).toBe(false);
    expect(Rules.placeStriker(state, 300)).toBe(false);
    expect(state.striker).toEqual(original);
    expect(Rules.placeStriker(state, Rules.CONFIG.baselineMinX)).toBe(true);
  });

  test('does not resolve a moving shot or allow a second shot during it', () => {
    const state = Rules.createGame();

    expect(Rules.beginShot(state, -Math.PI / 2, 50)).toBe(true);
    expect(Rules.resolveShot(state)).toBeNull();
    expect(Rules.beginShot(state, -Math.PI / 2, 50)).toBe(false);
    expect(state.shotNumber).toBe(1);
    expect(state.completedShots).toBe(0);
  });

  test('resolves a stationary miss once and passes the turn', () => {
    const state = Rules.createGame();
    Rules.beginShot(state, -Math.PI / 2, 50);
    state.striker.vx = 0;
    state.striker.vy = 0;

    expect(Rules.resolveShot(state)).toMatchObject({
      ownCoinsPocketed: 0, turnRetained: false, nextPlayer: 2,
    });
    expect(state.completedShots).toBe(1);
    expect(state.striker.y).toBe(Rules.CONFIG.baselines[2]);
    expect(Rules.resolveShot(state)).toBeNull();
    expect(state.completedShots).toBe(1);
  });

  test('counts an own coin once and retains the shooting player', () => {
    const state = Rules.createGame();
    const coin = state.coins.find(disk => disk.type === 'white');
    Rules.beginShot(state, -Math.PI / 2, 50);
    Rules.recordPocket(state, coin);
    Rules.recordPocket(state, coin);
    state.striker.vx = 0;
    state.striker.vy = 0;

    expect(Rules.resolveShot(state)).toMatchObject({
      pocketedIds: [coin.id], ownCoinsPocketed: 1, turnRetained: true, nextPlayer: 1,
    });
    expect(state.player1Score).toBe(1);
    expect(state.player1CoinsRemaining).toBe(8);
  });

  test('covers the queen with an own coin and awards the configured bonus', () => {
    const state = Rules.createGame();
    const queen = state.coins.find(coin => coin.type === 'queen');
    const own = state.coins.find(coin => coin.type === 'white');
    Rules.beginShot(state, -Math.PI / 2, 50);
    Rules.recordPocket(state, queen);
    Rules.recordPocket(state, own);
    state.striker.vx = 0;
    state.striker.vy = 0;
    Rules.resolveShot(state);

    expect(state.queenStatus).toBe('Covered');
    expect(state.queenCoveredBy).toBe(1);
    expect(state.player1Score).toBe(1 + Rules.CONFIG.queenBonus);
    expect(state.currentPlayer).toBe(1);
  });
});
