import { test, expect } from '../support/game';

test('01 — initial board: 9 white, 9 black, centered queen, Player 1 starts', async ({ game, page }) => {
  const state = await game.snapshot();
  expect(state.coins).toHaveLength(19);
  expect(state.coins.filter(c => c.type === 'white')).toHaveLength(9);
  expect(state.coins.filter(c => c.type === 'black')).toHaveLength(9);
  expect(state.coins.find(c => c.type === 'queen')).toMatchObject({ x: 300, y: 300, pocketed: false });
  expect(state.player1Score).toBe(0);
  expect(state.player2Score).toBe(0);
  expect(state.queenStatus).toBe('OnBoard');
  expect(state.completedShots).toBe(0);
  for (let i = 0; i < state.coins.length; i++) {
    for (let j = i + 1; j < state.coins.length; j++) {
      const a = state.coins[i], b = state.coins[j];
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.radius + b.radius);
    }
  }
  await expect(page.getByTestId('player-1')).toContainText('White · Bottom');
  await expect(page.getByTestId('player-2')).toContainText('Black · Top');
  await game.expectTurn(1);
});
