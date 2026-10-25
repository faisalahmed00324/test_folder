import { test, expect, coinIds } from '../support/game';

test('UI — click and drag sideways along each player’s baseline; reject opponent baseline placement', async ({ game }) => {
  for (const player of [1, 2] as const) {
    await game.load({ currentPlayer: player });
    const y = player === 1 ? 480 : 120;
    await game.clickBoard(150, y);
    expect((await game.snapshot()).striker).toMatchObject({ x: 150, y });
    await game.dragBoard(150, y, 420, y);
    expect((await game.snapshot()).striker.x).toBeCloseTo(420);
    await game.clickBoard(250, 600 - y);
    expect((await game.snapshot()).striker).toMatchObject({ x: 420, y });
    await game.dragBoard(420, y, 10, y);
    expect((await game.snapshot()).striker.x).toBe(80);
    await game.dragBoard(80, y, 590, y);
    expect((await game.snapshot()).striker.x).toBe(520);
  }
});

test('UI — position slider supports keyboard movement before shooting', async ({ game, page }) => {
  const slider = page.getByTestId('striker-position');
  await slider.focus();
  await slider.press('Home');
  expect((await game.snapshot()).striker.x).toBe(80);
  await slider.press('ArrowRight');
  expect((await game.snapshot()).striker.x).toBe(81);
  await slider.press('End');
  expect((await game.snapshot()).striker.x).toBe(520);
});

test('UI — a coin blocks striker placement by click, drag, and slider', async ({ game, page }) => {
  await game.load({ positions: [{ id: 'white-1', x: 150, y: 480 }] });
  await game.clickBoard(150, 480);
  expect((await game.snapshot()).striker.x).toBe(300);
  await expect(page.getByTestId('message')).toContainText('blocked by a coin');
  await game.dragBoard(300, 480, 150, 480);
  expect(Math.abs((await game.snapshot()).striker.x - 150)).toBeGreaterThanOrEqual(27);
  const slider = page.getByTestId('striker-position');
  await slider.focus();
  await slider.press('Home');
  for (let i = 0; i < 70; i++) await slider.press('ArrowRight');
  expect(Math.abs((await game.snapshot()).striker.x - 150)).toBeGreaterThanOrEqual(27.5);
  await expect(page.getByTestId('message')).toContainText('blocked by a coin');
});

test('UI — click/drag aiming is from the striker and persists after release, for both sides', async ({ game, page }) => {
  for (const player of [1, 2] as const) {
    await game.load({ currentPlayer: player });
    const y = player === 1 ? 480 : 120;
    await game.clickBoard(400, 300);
    const expected = Math.atan2(300 - y, 100);
    expect((await game.snapshot()).aimAngle).toBeCloseTo(expected);
    // Hover without a pressed pointer must not change the selected direction.
    const hover = await game.coordinates(100, 250);
    await page.mouse.move(hover.x, hover.y);
    expect((await game.snapshot()).aimAngle).toBeCloseTo(expected);
    await game.dragBoard(400, 300, 200, 280);
    expect((await game.snapshot()).aimAngle).toBeCloseTo(Math.atan2(280 - y, -100));
  }
});

test('UI — real striker-to-coin shot moves the rack and resolves only when all disks stop', async ({ game, page }) => {
  await game.clickBoard(300, 250);
  await game.power(85);
  await expect(page.getByTestId('power-value')).toHaveText('85');
  const before = await game.snapshot();
  const after = await game.shootAndWait();
  expect(after.coins.some((coin, i) => coin.pocketed ||
    Math.hypot(coin.x - before.coins[i].x, coin.y - before.coins[i].y) > 1)).toBe(true);
  expect(after.completedShots).toBe(1);
  expect(after.lastShotResult?.id).toBe(1);
  await expect(page.getByTestId('shoot')).toBeEnabled();
});

test('UI — movement, power and repeated shooting are locked throughout an active shot', async ({ game, page }) => {
  await game.clickBoard(100, 480);
  await game.clickBoard(100, 200);
  await game.power(100);
  await page.getByTestId('shoot').click();
  await expect(page.getByTestId('board')).toHaveAttribute('data-board-state', 'moving');
  await expect(page.getByTestId('shoot')).toBeDisabled();
  await expect(page.getByTestId('power')).toBeDisabled();
  await expect(page.getByTestId('striker-position')).toBeDisabled();
  await game.clickBoard(420, 480);
  const moving = await game.snapshot();
  expect(moving.striker.x).toBeCloseTo(100);
  expect(moving.shotNumber).toBe(1);
  await game.stationary(1);
  await game.expectTurn(2);
});

test('UI — physics coin-pocket events update score and the following real miss passes the turn', async ({ game }) => {
  // The white coin starts within the pocket mouth, but is captured by real Physics.step.
  await game.load({ positions: [{ id: 'white-1', x: 54, y: 54 }] });
  await game.clickBoard(100, 480);
  await game.clickBoard(100, 200);
  await game.power(25);
  const pocketed = await game.shootAndWait();
  expect(pocketed.player1Score).toBe(1);
  expect(pocketed.lastShotResult?.pocketedIds).toContain('white-1');
  await game.expectTurn(1);
  await game.clickBoard(100, 480);
  await game.clickBoard(100, 200);
  const missed = await game.shootAndWait();
  expect(missed.player1Score).toBe(1);
  expect(missed.lastShotResult?.pocketedIds).toEqual([]);
  await game.expectTurn(2);
});

test('UI — restart during animation cancels the old shot and leaves a fresh stationary game', async ({ game, page }) => {
  await game.power(100);
  await page.getByTestId('shoot').click();
  await expect(page.getByTestId('board')).toHaveAttribute('data-board-state', 'moving');
  await page.getByTestId('restart').click();
  await game.stationary(0);
  await game.expectTurn(1);
  expect((await game.snapshot()).shotNumber).toBe(0);
  // A new real shot must finish exactly once, without an orphaned pre-restart loop.
  await game.clickBoard(100, 480);
  await game.clickBoard(100, 200);
  await game.power(15);
  const state = await game.shootAndWait();
  expect(state.completedShots).toBe(1);
  expect(state.shotNumber).toBe(1);
  await game.expectTurn(2);
});

test('regression — a completed shot cannot be resolved twice', async ({ game, page }) => {
  const before = await game.shot({ pocketedIds: ['queen', 'white-1'] });
  await page.evaluate(() => window.__carromTest.resolveAgain());
  expect(await game.snapshot()).toEqual(before);
});

test('regression — the last coin and queen may be covered together to win', async ({ game }) => {
  await game.load({ currentPlayer: 2, pocketedIds: coinIds('black', 8) });
  const state = await game.shot({ pocketedIds: ['queen', 'black-9'] });
  expect(state.gameStatus).toBe('Finished');
  expect(state.winner).toBe(2);
  expect(state.player2Score).toBe(12);
});

test('UI — scaled mobile canvas uses correct placement and aiming coordinates', async ({ game, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await game.clickBoard(160, 480);
  expect((await game.snapshot()).striker.x).toBeCloseTo(160);
  await game.clickBoard(250, 250);
  expect((await game.snapshot()).aimAngle).toBeCloseTo(Math.atan2(-230, 90));
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
});
