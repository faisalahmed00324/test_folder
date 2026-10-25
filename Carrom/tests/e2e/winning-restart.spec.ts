import { test, expect, coinIds } from '../support/game';

test('14 — legally pocketing the final own coin with a covered queen declares victory and locks shots', async ({ game, page }) => {
  for (const player of [1, 2] as const) {
    const color = player === 1 ? 'white' : 'black';
    await game.load({ currentPlayer: player, pocketedIds: coinIds(color, 8), queenCoveredBy: player });
    const state = await game.shot({ pocketedIds: [`${color}-9`] });
    expect(state.winner).toBe(player);
    expect(state.gameStatus).toBe('Finished');
    expect(state[`player${player}Score`]).toBe(12);
    expect(state[`player${player}CoinsRemaining`]).toBe(0);
    await expect(page.getByTestId('winner')).toHaveText(`Player ${player} Wins!`);
    await expect(page.getByTestId('final-scores')).toContainText('12');
    await expect(page.getByTestId('shoot')).toBeDisabled();
  }
});

test('15 — final own coin before queen coverage is returned without its point; no premature win', async ({ game, page }) => {
  await game.load({ pocketedIds: coinIds('white', 8) });
  const state = await game.shot({ pocketedIds: ['white-9'] });
  expect(state.gameStatus).toBe('Playing');
  expect(state.winner).toBeNull();
  expect(state.player1CoinsRemaining).toBe(1);
  expect(state.player1Score).toBe(8);
  expect(state.coins.find(c => c.id === 'white-9')?.pocketed).toBe(false);
  expect(state.lastShotResult?.returnedIds).toContain('white-9');
  await expect(page.getByTestId('winner-panel')).toBeHidden();
  await expect(page.getByTestId('message')).toContainText('Final coin returned');
  await game.expectTurn(2);
});

test('16 — Play Again after victory resets all scores, coins, queen, turns, power, and shot history', async ({ game, page }) => {
  await game.load({ currentPlayer: 2, pocketedIds: coinIds('black', 8), queenCoveredBy: 2 });
  await game.shot({ pocketedIds: ['black-9'] });
  await page.getByTestId('play-again').click();
  await game.stationary(0);
  const state = await game.snapshot();
  expect(state.player1Score).toBe(0);
  expect(state.player2Score).toBe(0);
  expect(state.player1CoinsRemaining).toBe(9);
  expect(state.player2CoinsRemaining).toBe(9);
  expect(state.coins.every(c => !c.pocketed)).toBe(true);
  expect(state.queenStatus).toBe('OnBoard');
  expect(state.queenPendingCoverBy).toBeNull();
  expect(state.queenCoveredBy).toBeNull();
  expect(state.winner).toBeNull();
  expect(state.gameStatus).toBe('Playing');
  expect(state.lastShotResult).toBeNull();
  expect(state.shotNumber).toBe(0);
  await expect(page.getByTestId('winner-panel')).toBeHidden();
  await expect(page.getByTestId('power')).toHaveValue('50');
  await game.expectTurn(1);
});
