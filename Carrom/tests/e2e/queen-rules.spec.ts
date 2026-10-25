import { test, expect } from '../support/game';

test('06 — queen plus own coin covers immediately; queen bonus is awarded exactly once', async ({ game, page }) => {
  const first = await game.shot({ pocketedIds: ['queen', 'white-1'] });
  expect(first.queenStatus).toBe('Covered');
  expect(first.queenCoveredBy).toBe(1);
  expect(first.queenPendingCoverBy).toBeNull();
  expect(first.player1Score).toBe(4);
  await expect(page.getByTestId('queen-status')).toHaveText('Queen: Covered by Player 1');
  await game.expectTurn(1);
  const second = await game.shot();
  expect(second.player1Score).toBe(4);
  expect(second.queenCoveredBy).toBe(1);
  await game.expectTurn(2);
});

test('07 — queen alone grants one immediate attempt, with bonus only after a successful cover', async ({ game }) => {
  const pending = await game.shot({ pocketedIds: ['queen'] });
  expect(pending.queenStatus).toBe('PendingCover');
  expect(pending.queenPendingCoverBy).toBe(1);
  expect(pending.player1Score).toBe(0);
  await game.expectTurn(1);
  const covered = await game.shot({ pocketedIds: ['white-1'] });
  expect(covered.queenStatus).toBe('Covered');
  expect(covered.player1Score).toBe(4);
  expect(covered.queenPendingCoverBy).toBeNull();
  await game.expectTurn(1);
});

test('08 — missing a covering attempt returns the queen to a free position and passes the turn', async ({ game }) => {
  await game.shot({ pocketedIds: ['queen'] });
  const state = await game.shot();
  expect(state.queenStatus).toBe('OnBoard');
  expect(state.queenPendingCoverBy).toBeNull();
  expect(state.player1Score).toBe(0);
  const queen = state.coins.find(c => c.id === 'queen')!;
  expect(queen.pocketed).toBe(false);
  for (const coin of state.coins.filter(c => c.id !== 'queen' && !c.pocketed)) {
    expect(Math.hypot(coin.x - queen.x, coin.y - queen.y)).toBeGreaterThanOrEqual(coin.radius + queen.radius);
  }
  await game.expectTurn(2);
});

test('09 — an opponent-only pocket cannot cover the queen', async ({ game }) => {
  await game.shot({ pocketedIds: ['queen'] });
  const state = await game.shot({ pocketedIds: ['black-1'] });
  expect(state.queenStatus).toBe('OnBoard');
  expect(state.queenCoveredBy).toBeNull();
  expect(state.player1Score).toBe(0);
  expect(state.player2Score).toBe(0);
  expect(state.player2CoinsRemaining).toBe(8);
  await game.expectTurn(2);
});

test('10 — an invalid covering shot returns the queen, restores own pockets, and ends the turn', async ({ game, page }) => {
  await game.shot({ pocketedIds: ['queen'] });
  const state = await game.shot({ pocketedIds: ['white-1'], foul: 'Shot attempted while the board was moving' });
  expect(state.queenStatus).toBe('OnBoard');
  expect(state.queenPendingCoverBy).toBeNull();
  expect(state.player1Score).toBe(0);
  expect(state.player1CoinsRemaining).toBe(9);
  expect(state.lastShotResult?.returnedIds).toEqual(expect.arrayContaining(['queen', 'white-1']));
  await expect(page.getByTestId('message')).toHaveClass(/foul/);
  await game.expectTurn(2);
});
