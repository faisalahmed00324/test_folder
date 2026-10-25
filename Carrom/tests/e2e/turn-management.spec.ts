import { test, expect } from '../support/game';

test('02 — misses pass the turn and reset the striker to opposite baselines', async ({ game }) => {
  await game.shot();
  await game.expectTurn(2);
  const state = await game.shot();
  await game.expectTurn(1);
  expect(state.player1Score).toBe(0);
  expect(state.player2Score).toBe(0);
  expect(state.completedShots).toBe(2);
});

test('03 — own coin retains the turn, but the next miss passes without recounting old pockets', async ({ game }) => {
  for (const player of [1, 2] as const) {
    await game.load({ currentPlayer: player });
    const color = player === 1 ? 'white' : 'black';
    const first = await game.shot({ pocketedIds: [`${color}-1`] });
    expect(first[`player${player}Score`]).toBe(1);
    expect(first.lastShotResult?.turnRetained).toBe(true);
    await game.expectTurn(player);
    const second = await game.shot();
    expect(second[`player${player}Score`]).toBe(1);
    expect(second.lastShotResult?.ownCoinsPocketed).toBe(0);
    expect(second.lastShotResult?.pocketedIds).toEqual([]);
    await game.expectTurn(player === 1 ? 2 : 1);
  }
});

test('04 — opponent-only pocket removes that coin but grants no points or extra turn', async ({ game }) => {
  const state = await game.shot({ pocketedIds: ['black-1'] });
  expect(state.player1Score).toBe(0);
  expect(state.player2Score).toBe(0);
  expect(state.player2CoinsRemaining).toBe(8);
  expect(state.lastShotResult?.turnRetained).toBe(false);
  await game.expectTurn(2);
});

test('05 — multiple/mixed pockets score only new own coins and retain the turn', async ({ game }) => {
  const state = await game.shot({ pocketedIds: ['white-1', 'white-2', 'black-1'] });
  expect(state.player1Score).toBe(2);
  expect(state.player2Score).toBe(0);
  expect(state.player1CoinsRemaining).toBe(7);
  expect(state.player2CoinsRemaining).toBe(8);
  await game.expectTurn(1);
  const next = await game.shot({ pocketedIds: ['white-3'] });
  expect(next.player1Score).toBe(3);
  expect(next.lastShotResult?.ownCoinsPocketed).toBe(1);
});
