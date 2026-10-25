import { test, expect } from '../support/game';

test('11 — invalid shot returns one prior own coin and its point, never an opponent coin', async ({ game }) => {
  await game.shot({ pocketedIds: ['white-1', 'white-2', 'black-1'] });
  const state = await game.shot({ foul: 'Shot attempted while the board was moving' });
  expect(state.player1Score).toBe(1);
  expect(state.player1CoinsRemaining).toBe(8);
  expect(state.player2CoinsRemaining).toBe(8);
  expect(state.lastShotResult?.returnedIds).toHaveLength(1);
  expect(state.lastShotResult?.returnedIds[0]).toMatch(/^white-/);
  expect(state.lastShotResult?.turnRetained).toBe(false);
  await game.expectTurn(2);
});

test('12 — a foul without a previous own coin cannot invent a penalty coin or negative score', async ({ game, page }) => {
  const state = await game.shot({ foul: 'Shot attempted while the board was moving' });
  expect(state.lastShotResult?.returnedIds).toEqual([]);
  expect(state.player1Score).toBe(0);
  expect(state.player1CoinsRemaining).toBe(9);
  await expect(page.getByTestId('message')).toContainText('Foul:');
  await game.expectTurn(2);
});

test('13 — striker rebounds from a real corner-pocket shot, for both players', async ({ game, page }) => {
  for (const player of [1, 2] as const) {
    await game.load({ currentPlayer: player });
    const baseline = player === 1 ? 480 : 120;
    const pocketY = player === 1 ? 40 : 560;
    await game.clickBoard(80, baseline);
    await game.clickBoard(55, player === 1 ? 55 : 545);
    await game.power(100);
    // Observe the real animation; do not move disks or resolve the shot in this observer.
    await page.evaluate(pocketY => {
      const observations = { nearest: Infinity, sawPocketed: false };
      const observer = new MutationObserver(() => {
        const striker = window.__carromTest.snapshot().striker;
        observations.nearest = Math.min(observations.nearest, Math.hypot(striker.x - 40, striker.y - pocketY));
        observations.sawPocketed ||= striker.pocketed;
      });
      observer.observe(document.getElementById('board')!, { attributes: true, attributeFilter: ['data-striker-x'] });
      (window as unknown as { strikerObservation: { observer: MutationObserver; observations: typeof observations } })
        .strikerObservation = { observer, observations };
    }, pocketY);
    const state = await game.shootAndWait();
    const observed = await page.evaluate(() => {
      const observed = (window as unknown as {
        strikerObservation: { observer: MutationObserver; observations: { nearest: number; sawPocketed: boolean } };
      }).strikerObservation;
      observed.observer.disconnect();
      return observed.observations;
    });
    expect(state.config.strikerCanBePocketed).toBe(false);
    expect(observed.nearest).toBeLessThan(25);
    expect(observed.sawPocketed).toBe(false);
    expect(state.lastShotResult?.fouls).toEqual([]);
    expect(state.striker.pocketed).toBe(false);
    expect(state.lastShotResult?.pocketedIds).not.toContain('striker');
    await game.expectTurn(player === 1 ? 2 : 1);
  }
});
