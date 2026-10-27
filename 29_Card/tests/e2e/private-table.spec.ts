import { test, expect, type Page } from '@playwright/test';

const production = 'http://127.0.0.1:8878';
async function join(page: Page, token: string) {
  await page.route('http://127.0.0.1:8879/29-card/tables', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ pin: '123456', token: token.padEnd(43, '_') }),
  }));
  await page.goto(`${production}/29_Card/index.html`);
  await page.getByRole('button', { name: 'Private table', exact: true }).click();
  await page.getByText('Server settings', { exact: true }).click();
  await page.getByLabel('Table WebSocket address').fill('ws://127.0.0.1:8879/29-card/ws');
  await page.getByRole('button', { name: 'Create table', exact: true }).click();
  await expect(page.getByText('Connection: connected', { exact: true })).toBeVisible();
}

test('PIN tables — create, share, join four players, reject a fifth and reconnect without login', async ({ browser }) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all([0, 1, 2, 3, 4].map(() => browser.newContext({ viewport: { width: 390, height: 844 } })));
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all(pages.map(async page => {
      await page.goto(`${production}/29_Card/index.html`);
      await page.getByRole('button', { name: 'Private table', exact: true }).click();
      await page.getByText('Server settings', { exact: true }).click();
      await page.getByLabel('Table WebSocket address').fill('ws://127.0.0.1:8879/29-card/ws');
      await expect(page.getByLabel('Seat access token')).toHaveCount(0);
    }));
    await pages[0].getByRole('button', { name: 'Create table', exact: true }).click();
    await expect(pages[0].getByText('Connection: connected', { exact: true })).toBeVisible();
    const pin = await pages[0].getByRole('region', { name: 'Private table PIN' }).locator('h2 span').textContent();
    expect(pin).toMatch(/^\d{6}$/);
    for (const page of pages.slice(1)) {
      await page.getByRole('button', { name: 'Join table', exact: true }).click();
      await page.getByLabel('Six-digit PIN').fill(pin!);
      await page.getByRole('button', { name: 'Join table', exact: true }).click();
      if (page === pages[4]) {
        await expect(page.getByRole('alert')).toContainText('full');
        continue;
      }
      await expect(page.getByText('Connection: connected', { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Private table PIN' })).toContainText(pin!);
    }
    for (const page of pages.slice(0, 4)) await page.getByRole('button', { name: 'Ready', exact: true }).click();
    for (const page of pages.slice(0, 4)) await expect(page.getByRole('region', { name: 'Your hand' }).getByRole('button')).toHaveCount(4);
    await expect(pages[4].getByRole('region', { name: 'Your hand' })).toHaveCount(0);
    await expect(pages[4].getByRole('region', { name: 'Completed table history' })).toHaveCount(0);
    const hand = await pages[0].getByRole('region', { name: 'Your hand' }).getByRole('button').allTextContents();
    await pages[0].getByRole('button', { name: 'Disconnect', exact: true }).click();
    await pages[0].getByRole('button', { name: 'Reconnect table' }).click();
    await expect(pages[0].getByText('Connection: connected', { exact: true })).toBeVisible();
    expect(await pages[0].getByRole('region', { name: 'Your hand' }).getByRole('button').allTextContents()).toEqual(hand);
    expect(await pages[0].evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('private table — four real clients bid, conceal trump, double-pass, and play a complete trick', async ({ browser }) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext({ viewport: { width: 390, height: 844 } })));
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    const errors: string[] = [];
    pages.forEach(page => page.on('pageerror', error => errors.push(error.message)));
    await Promise.all(pages.map((page, seat) => join(page, `play-${seat}`)));
    for (const page of pages) await expect(page.getByRole('region', { name: 'Your hand' })).toHaveCount(0);
    for (const page of pages) await page.getByRole('button', { name: 'Ready', exact: true }).click();
    await Promise.all(pages.map(page => expect(page.getByRole('region', { name: 'Your hand' }).getByRole('button')).toHaveCount(4)));
    // The client receives only its own four cards, never another seat's hand.
    const hands = await Promise.all(pages.map(page => page.getByRole('region', { name: 'Your hand' }).getByRole('button').allTextContents()));
    expect(new Set(hands.flat()).size).toBe(16);
    await pages[3].getByRole('button', { name: 'Bid 16', exact: true }).click();
    for (const seat of [2, 1, 0]) {
      await expect(pages[seat].locator('.turn')).toContainText('Your turn');
      await pages[seat].getByRole('button', { name: 'Pass', exact: true }).click();
    }
    await expect(pages[3].getByRole('region', { name: 'Table status' })).toContainText('TRUMP SELECTION');
    await pages[3].getByRole('button', { name: /^Conceal / }).first().click();
    for (const seat of [2, 0]) {
      await expect(pages[seat].locator('.turn')).toContainText('Your turn');
      await pages[seat].getByRole('button', { name: 'Pass double', exact: true }).click();
    }
    await expect(pages[3].getByRole('region', { name: 'Table status' })).toContainText('PLAY');
    for (const page of pages) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    for (let played = 0; played < 4; played++) {
      const turn = (await pages[0].locator('.active-seat b').textContent())!;
      const seat = Number(/Seat (\d)/.exec(turn)![1]) - 1;
      const hand = pages[seat].getByRole('region', { name: 'Your hand' });
      await expect(pages[seat].locator('.turn')).toContainText('Your turn');
      await expect(hand.getByRole('button').locator('visible=true').first()).toBeVisible();
      const before = await hand.getByRole('button').count();
      await hand.locator('button:enabled').first().click();
      await expect(hand.getByRole('button')).toHaveCount(before - 1);
    }
    await expect(pages[0].getByRole('region', { name: 'Current trick' })).toContainText('Trick 2');
    await expect(pages[0].getByText('Trick history', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('private table — all humans ready, finish a real match, and unanimously start a fresh rematch', async ({ browser }) => {
  test.setTimeout(60_000);
  const contexts = await Promise.all([0, 1, 2, 3].map(() => browser.newContext()));
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all(pages.map((page, seat) => join(page, `rematch-${seat}`)));
    for (const page of pages) await page.getByRole('button', { name: 'Ready', exact: true }).click();
    await expect(pages[0].getByRole('region', { name: 'Your hand' }).getByRole('button')).toHaveCount(4);
    const publicState = async () => ((await pages[0].getByRole('region', { name: 'Table status' }).textContent()) ?? '')
      .replace(/\b\d+s\b/g, '') + ((await pages[0].getByRole('region', { name: 'Current trick' }).textContent()) ?? '');
    let moves = 0;
    while (!(await pages[0].getByRole('button', { name: 'Accept rematch' }).isVisible())) {
      expect(++moves).toBeLessThan(100);
      const before = await publicState();
      const label = (await pages[0].locator('.active-seat b').textContent())!;
      const seat = Number(/Seat (\d)/.exec(label)![1]) - 1;
      const player = pages[seat];
      await expect(player.getByText('Connection: connected', { exact: true })).toBeVisible();
      await expect(player.locator('.turn')).toContainText('Your turn');
      const cards = player.getByRole('region', { name: 'Your hand' }).locator('button:enabled');
      if (await cards.count()) await cards.first().click();
      else {
        const pass = player.getByRole('button', { name: 'Pass', exact: true });
        const passDouble = player.getByRole('button', { name: 'Pass double', exact: true });
        if (await pass.isVisible()) await pass.click();
        else if (await passDouble.isVisible()) await passDouble.click();
        else await player.getByRole('region', { name: 'Legal actions' }).locator('button:enabled').first().click();
      }
      await expect.poll(publicState).not.toBe(before);
    }
    await Promise.all(pages.map(page => expect(page.getByRole('button', { name: 'Accept rematch' })).toBeEnabled()));
    await expect(pages[0].getByRole('region', { name: 'Hand summary' })).toBeVisible();
    await expect(pages[0].getByRole('region', { name: 'Completed table history' })).toHaveCount(0);
    for (const page of pages) await page.getByRole('button', { name: 'Accept rematch' }).click();
    await Promise.all(pages.map(page => expect(page.getByRole('region', { name: 'Table status' })).toContainText('Match 2 · PLAYING')));
    for (const page of pages) {
      await expect(page.getByRole('region', { name: 'Your hand' }).getByRole('button')).toHaveCount(4);
      await expect(page.getByLabel('Match scores')).toContainText('Team A 0');
      await expect(page.getByLabel('Match scores')).toContainText('Team B 0');
      await expect(page.getByRole('region', { name: 'Hand summary' })).toHaveCount(0);
    }
    // Reconnect uses only in-memory seat access; no history or login is required.
    await pages[0].getByRole('button', { name: 'Disconnect', exact: true }).click();
    await pages[0].getByRole('button', { name: 'Reconnect table' }).click();
    await expect(pages[0].getByText('Connection: connected', { exact: true })).toBeVisible();
    await expect(pages[0].getByRole('article', { name: 'Match 1 hand 1', exact: true })).toHaveCount(0);
    await expect(pages[0].getByRole('button', { name: 'Latest results' })).toHaveCount(0);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('private table — fixed chat reaches spectators, enforces cooldown, and supports local mute', async ({ browser }) => {
  const sender = await browser.newContext(), observer = await browser.newContext();
  try {
    const player = await sender.newPage(), spectator = await observer.newPage();
    await join(player, 'social-0'); await join(spectator, 'social-spectator');
    const chat = player.getByRole('region', { name: 'Quick chat', exact: true });
    const watchChat = spectator.getByRole('region', { name: 'Quick chat', exact: true });
    await expect(chat.getByRole('textbox')).toHaveCount(0);
    await expect(watchChat.getByRole('button', { name: /^Say / })).toHaveCount(0);
    await player.getByRole('button', { name: 'Say Good luck', exact: true }).click();
    await expect(player.getByRole('button', { name: 'Say Thanks', exact: true })).toBeDisabled();
    await expect(watchChat.getByRole('log', { name: 'Table messages' })).toContainText('Seat 1: Good luck');
    await watchChat.getByText('Mute messages from seats', { exact: true }).click();
    await watchChat.getByLabel('Mute Seat 1', { exact: true }).check();
    await expect(watchChat.getByRole('log', { name: 'Table messages' })).not.toContainText('Good luck');
    await expect(chat.getByRole('log', { name: 'Table messages' })).toContainText('Seat 1: Good luck');
    await expect(spectator.getByRole('region', { name: 'Completed table history' })).toHaveCount(0);
  } finally { await sender.close(); await observer.close(); }
});

test('private table — spectators stay read-only and production serves no private sources or test assets', async ({ page, request }) => {
  await join(page, 'watch-spectator');
  await expect(page.getByText(/Spectator · read only/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your hand' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Leave table', exact: true })).toHaveCount(0);
  for (const path of ['/29_Card/src/client/App.tsx', '/29_Card/src/application/match-actor.ts',
    '/29_Card/src/adapters/pin-server.ts', '/29_Card/src/application/pin-tables.ts',
    '/29_Card/tests/server.cjs', '/29_Card/tests/support/client-fixture.cjs', '/29_Card/app.js.map', '/.build/29-card/server.js']) {
    expect((await request.get(`${production}${path}`)).status()).toBe(404);
  }
  const bundle = await (await request.get(`${production}/29_Card/app.js`)).text();
  expect(bundle).not.toContain('CARD29_JOURNAL_KEY');
  expect(bundle).not.toContain('createMatchActor');
  expect(bundle).not.toContain('startPinServer');
  expect(bundle).not.toContain('play-spectator');
});

test('private table — disconnect clears private cards and rejoin restores the filtered hand', async ({ page }) => {
  await join(page, 'reconnect-3');
  const before = await page.getByRole('region', { name: 'Your hand' }).getByRole('button').allTextContents();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Your hand' })).toHaveCount(0);
  await expect(page.getByLabel('Seat access token')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reconnect table' }).click();
  await expect(page.getByText('Connection: connected', { exact: true })).toBeVisible();
  expect(await page.getByRole('region', { name: 'Your hand' }).getByRole('button').allTextContents()).toEqual(before);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});

test('private table — unknown PIN shows an actionable error without credentials', async ({ page }) => {
  await page.route('http://127.0.0.1:8879/29-card/tables/join', route => route.fulfill({
    status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'TABLE_NOT_FOUND' }),
  }));
  await page.goto(`${production}/29_Card/index.html`);
  await page.getByRole('button', { name: 'Private table', exact: true }).click();
  await page.getByText('Server settings', { exact: true }).click();
  await page.getByLabel('Table WebSocket address').fill('ws://127.0.0.1:8879/29-card/ws');
  await page.getByRole('button', { name: 'Join table', exact: true }).click();
  await page.getByLabel('Six-digit PIN').fill('000000');
  await page.getByRole('button', { name: 'Join table', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('not found');
  await expect(page.getByLabel('Seat access token')).toHaveCount(0);
});
