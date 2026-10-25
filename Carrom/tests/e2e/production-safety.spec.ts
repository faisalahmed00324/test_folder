import { test, expect } from '@playwright/test';

const production = 'http://127.0.0.1:8878';

test('production — no scenario API or driver is present, even with test-mode query flags', async ({ page, request }) => {
  await page.goto(`${production}/Carrom/carrom.html?test=true&e2e=true`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-board-state', 'stationary');
  expect(await page.evaluate(() => typeof window.__carromTest)).toBe('undefined');
  const source = await (await request.get(`${production}/Carrom/carrom.js`)).text();
  expect(source).not.toContain('__carromTest');
  expect(source).not.toContain('E2E_INJECTION_POINT');
  for (const path of ['/Carrom/tests/support/browser-driver.js', '/Carrom/tests/server.cjs', '/Carrom/inst.md']) {
    expect((await request.get(`${production}${path}`)).status()).toBe(404);
  }
});

test('production — actual build supports UI placement, aiming, shooting and opposite-side turn changes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${production}/Carrom/carrom.html`);
  const board = page.getByTestId('board');
  const box = await board.boundingBox();
  if (!box) throw new Error('Board not visible');
  const click = (x: number, y: number) => page.mouse.click(box.x + x * box.width / 600, box.y + y * box.height / 600);
  await click(100, 480);
  await click(100, 200);
  await expect(board).toHaveAttribute('data-striker-x', '100');
  await page.getByTestId('shoot').click();
  await expect(board).toHaveAttribute('data-board-state', 'moving');
  await expect(board).toHaveAttribute('data-completed-shots', '1', { timeout: 12_000 });
  await expect(board).toHaveAttribute('data-board-state', 'stationary');
  await expect(page.getByTestId('turn')).toHaveText("Player 2's Turn — Top");
  await expect(board).toHaveAttribute('data-striker-y', '120');
  await expect(page.getByTestId('shoot')).toBeEnabled();
  expect(errors).toEqual([]);
});
