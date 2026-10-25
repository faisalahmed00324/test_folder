const { describe, test, expect, afterEach } = require('@jest/globals');
const { createMatchActor, restoreMatchActor } = require('../../src/application/match-actor.ts');
const { baselineBotAction } = require('../../src/application/baseline-bot.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { rulesetSchema } = require('../../src/domain/ruleset.ts');
const { createDeck } = require('../../src/domain/cards.ts');
const { commandSchema } = require('../../src/protocol/player-command.ts');
const { createTableSession, reconcileTable, applyTableAction, expireTable, tableSettingsSchema } = require('../../src/application/table-session.ts');

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
function harness(options = {}) {
  jest.useFakeTimers({ now: 1000 });
  const records = [], published = [];
  const { maxBid, totalPoints, ...raw } = PRESETS['29-standard'];
  const ruleset = rulesetSchema.parse({ ...raw, matchEnd: { winAt: 1, loseAt: -1 } });
  const ports = { now: () => Date.now(), firstDealer: jest.fn().mockReturnValueOnce(0).mockReturnValue(1),
    shuffle: jest.fn(createDeck), botDelayMs: () => 600,
    schedule: (deadline, callback) => { const timer = setTimeout(callback, Math.max(0, deadline - Date.now())); return () => clearTimeout(timer); },
    append: jest.fn(async record => { records.push(record); }),
    publish: jest.fn((viewer, events) => published.push({ viewer, events })), onError: jest.fn() };
  const actor = createMatchActor({ matchId: 'table', ruleset, lifecycle: {}, table: {}, ...options }, ports);
  let id = 0;
  function command(action, seat = 0, overrides = {}, target = actor) {
    const view = target.getView(seat);
    return { matchId: 'table', commandId: `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      expectedVersion: view.version, ...(['READY', 'REMATCH_VOTE'].includes(action.type) ? { expectedCheckId: view.table.checkId } : {}),
      action, ...overrides };
  }
  async function connectAll(target = actor) { for (const seat of [0, 1, 2, 3]) await target.setConnected(seat, true); }
  async function readyAll(target = actor) {
    for (const seat of [0, 1, 2, 3]) expect(await target.dispatch(seat, command({ type: 'READY' }, seat, {}, target))).toMatchObject({ ok: true });
  }
  async function finish() {
    let moves = 0;
    while (actor.getView(0).status === 'IN_PROGRESS') {
      const seat = actor.getView(0).toAct;
      const action = baselineBotAction(actor.getView(seat));
      expect(action).not.toBeNull();
      expect(await actor.dispatch(seat, command(action, seat))).toMatchObject({ ok: true });
      expect(++moves).toBeLessThan(150);
    }
  }
  return { actor, ports, records, published, command, connectAll, readyAll, finish };
}

describe('pure private-table consent rules', () => {
  const bots = [false, false, false, false];
  const settings = tableSettingsSchema.parse({});
  test('opens a fixed ready check only when all seats are filled, without mutating inputs', () => {
    const initial = createTableSession(); const before = structuredClone(initial);
    expect(reconcileTable(initial, [true, false, false, false], bots, false, 1000, settings)).toEqual(initial);
    const ready = reconcileTable(initial, [true, true, true, true], bots, false, 1000, settings);
    expect(ready).toMatchObject({ phase: 'READY_CHECK', deadline: 16000, checkId: 1 });
    expect(initial).toEqual(before);
    expect(applyTableAction(ready, 0, { type: 'READY' }, 0, [true, true, true, true], bots, 2000)).toMatchObject({ code: 'STALE_CHECK' });
    expect(applyTableAction(ready, 0, { type: 'READY' }, 1, [true, true, true, true], bots, 16000)).toMatchObject({ code: 'CHECK_EXPIRED' });
    expect(() => expireTable(ready, 15999)).toThrow('not due');
    expect(ready.ready).toEqual([false, false, false, false]);
  });
  test('provisioned bots do not vote for disconnected humans and rematch needs every connected human', () => {
    const ready = reconcileTable(createTableSession(), [true, true, true, false], [false, false, false, true], false, 1000, settings);
    expect(ready.ready).toEqual([false, false, false, true]);
    expect(applyTableAction(ready, 3, { type: 'READY' }, 1, [true, true, true, false], [false, false, false, true], 1000)).toMatchObject({ code: 'SEAT_NOT_CONNECTED' });
    const ended = reconcileTable({ ...ready, phase: 'PLAYING', deadline: null }, [true, true, true, false], bots, true, 2000, settings);
    expect(ended).toMatchObject({ phase: 'REMATCH', deadline: 22000, votes: [null, null, null, null] });
    expect(applyTableAction(ended, 3, { type: 'REMATCH_VOTE', accept: true }, ended.checkId, [true, true, true, false], bots, 2000)).toMatchObject({ code: 'SEAT_NOT_CONNECTED' });
    expect(expireTable(ended, 22000).table.phase).toBe('CLOSED');
  });
  test('validates commands and bounded settings at the boundary', () => {
    const h = harness();
    for (const raw of [{}, { readyMs: 0 }, { rematchMs: 2_147_483_648 }]) {
      expect(tableSettingsSchema.safeParse(raw).success).toBe(Object.keys(raw).length === 0);
    }
    expect(commandSchema.safeParse({ matchId: 'table', commandId: '00000000-0000-4000-8000-000000000001',
      expectedVersion: 0, action: { type: 'READY' } }).success).toBe(false);
    expect(commandSchema.safeParse({ matchId: 'table', commandId: '00000000-0000-4000-8000-000000000001',
      expectedVersion: 0, expectedCheckId: 1, action: { type: 'REMATCH_VOTE', accept: 'yes' } }).success).toBe(false);
    h.actor.stop();
  });
});

describe('durable actor ready checks and rematches', () => {
  test('deals no cards and arms no gameplay timers before unanimous readiness', async () => {
    const h = harness(); await h.actor.start();
    expect(h.actor.getView(0)).toMatchObject({ phase: 'AWAITING_DEAL', myHand: [], deadline: null, table: { phase: 'WAITING' } });
    expect(h.ports.shuffle).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
    expect(await h.actor.dispatch(0, h.command({ type: 'BID', amount: 16 }))).toMatchObject({ code: 'TABLE_NOT_PLAYING' });
    await h.connectAll();
    expect(h.actor.getView(0)).toMatchObject({ deadline: 16000, legalActions: [{ type: 'READY' }], table: { phase: 'READY_CHECK' } });
    const ready = h.command({ type: 'READY' });
    expect(await h.actor.dispatch(0, ready)).toMatchObject({ ok: true });
    expect(await h.actor.dispatch(0, ready)).toMatchObject({ ok: true });
    for (const seat of [1, 2]) await h.actor.dispatch(seat, h.command({ type: 'READY' }, seat));
    expect(h.ports.shuffle).not.toHaveBeenCalled();
    await h.actor.dispatch(3, h.command({ type: 'READY' }, 3));
    expect(h.ports.shuffle).toHaveBeenCalledTimes(1);
    expect(h.actor.getView(3)).toMatchObject({ phase: 'AUCTION', myHand: expect.any(Array), version: 1, table: { phase: 'PLAYING', matchNumber: 1 } });
    expect(h.actor.getView(3).myHand).toHaveLength(4);
    expect(h.ports.onError).not.toHaveBeenCalled(); h.actor.stop();
  });

  test('ready no-shows reopen only their slots and old confirmations cannot ready a later check', async () => {
    const h = harness(); await h.actor.start(); await h.connectAll();
    const old = h.command({ type: 'READY' }, 0);
    await h.actor.dispatch(0, old);
    await jest.advanceTimersByTimeAsync(15000);
    expect(h.actor.getView(0)).toMatchObject({ table: { phase: 'WAITING', ready: [false, false, false, false] }, deadline: null });
    expect(h.actor.getView(0).seats.map(seat => seat.connected)).toEqual([true, false, false, false]);
    expect(h.ports.shuffle).not.toHaveBeenCalled();
    await h.connectAll();
    expect(h.actor.getView(0).table.checkId).toBe(2);
    expect(await h.actor.dispatch(0, old)).toMatchObject({ ok: true });
    expect(h.actor.getView(0).table.ready[0]).toBe(false);
    expect(await h.actor.dispatch(0, h.command({ type: 'READY' }, 0, { expectedCheckId: 1 }))).toMatchObject({ code: 'STALE_CHECK' });
    h.actor.stop();
  });

  test('a connection loss cancels the current check and leaving a waiting table never starts a bot', async () => {
    const h = harness(); await h.actor.start(); await h.connectAll();
    await h.actor.dispatch(0, h.command({ type: 'READY' }, 0));
    await h.actor.leave(1);
    expect(h.actor.getView(0).table).toMatchObject({ phase: 'WAITING', deadline: null, ready: [false, false, false, false] });
    expect(h.actor.getView(0).seats[1]).toMatchObject({ connected: false, controller: 'human' });
    await jest.advanceTimersByTimeAsync(600000);
    expect(h.actor.getView(0).table.phase).toBe('WAITING'); expect(h.ports.shuffle).not.toHaveBeenCalled();
    h.actor.stop();
  });

  test('unanimous rematch resets scores, controllers, banks, and deck once with a recorded random dealer', async () => {
    const h = harness(); await h.actor.start(); await h.connectAll(); await h.readyAll(); await h.finish();
    const endedVersion = h.actor.getView(0).version;
    const endedSeq = h.actor.getSequence(0);
    expect(h.actor.getView(0).table).toMatchObject({ phase: 'REMATCH', deadline: 21000, matchNumber: 1 });
    const oldMove = h.records.find(record => record.receipt?.command.action.type === 'BID').receipt;
    for (const seat of [0, 1, 2]) expect(await h.actor.dispatch(seat, h.command({ type: 'REMATCH_VOTE', accept: true }, seat))).toMatchObject({ ok: true });
    const last = h.command({ type: 'REMATCH_VOTE', accept: true }, 3);
    const receipt = await h.actor.dispatch(3, last);
    expect(receipt.ok).toBe(true);
    expect(await h.actor.dispatch(3, last)).toEqual(receipt);
    expect(h.ports.firstDealer).toHaveBeenCalledTimes(2); expect(h.ports.shuffle).toHaveBeenCalledTimes(2);
    expect(h.actor.getView(0)).toMatchObject({ dealer: 1, handNumber: 1, gameScores: { A: 0, B: 0 },
      timeBankMs: 30000, table: { phase: 'PLAYING', matchNumber: 2 } });
    expect(h.actor.getView(0).version).toBeGreaterThan(endedVersion);
    expect(h.actor.getSequence(0)).toBeGreaterThan(endedSeq);
    expect(h.records.some(record => record.rematchDealer === 1)).toBe(true);
    expect(await h.actor.dispatch(oldMove.seat, oldMove.command)).toEqual(oldMove.response);
    expect(await h.actor.dispatch(0, h.command({ type: 'BID', amount: 16 }, 0, { expectedVersion: 1 }))).toMatchObject({ code: 'STALE_STATE' });
    const archive = JSON.parse(JSON.stringify(h.records)); h.actor.stop();
    h.ports.firstDealer.mockClear(); h.ports.shuffle.mockClear();
    const restored = await restoreMatchActor(archive, h.ports);
    expect(restored.getView(0)).toMatchObject({ dealer: 1, gameScores: { A: 0, B: 0 }, table: { matchNumber: 2 } });
    expect(await restored.dispatch(3, last)).toEqual(receipt);
    expect(h.ports.firstDealer).not.toHaveBeenCalled(); expect(h.ports.shuffle).not.toHaveBeenCalled();
    restored.stop();
  });

  test.each(['decline', 'expiry'])('%s closes the rematch without drawing a dealer or dealing', async reason => {
    const h = harness(); await h.actor.start(); await h.connectAll(); await h.readyAll(); await h.finish();
    if (reason === 'decline') await h.actor.dispatch(0, h.command({ type: 'REMATCH_VOTE', accept: false }));
    else await jest.advanceTimersByTimeAsync(20000);
    expect(h.actor.getView(0).table).toMatchObject({ phase: 'CLOSED', deadline: null, matchNumber: 1 });
    expect(h.ports.shuffle).toHaveBeenCalledTimes(1); expect(h.ports.firstDealer).toHaveBeenCalledTimes(1);
    expect(await h.actor.dispatch(1, h.command({ type: 'REMATCH_VOTE', accept: true }, 1))).toMatchObject({ code: 'WRONG_PHASE' });
    h.actor.stop();
  });

  test('a late return cannot rescue abandonment but can vote in the new rematch window', async () => {
    const h = harness({ lifecycle: { disconnectGraceMs: 100000, abandonAfterMs: 1000 } });
    await h.actor.start(); await h.connectAll(); await h.readyAll();
    for (const seat of [0, 1, 2, 3]) await h.actor.setConnected(seat, false);
    jest.setSystemTime(2000);
    await h.actor.setConnected(0, true);
    expect(h.actor.getView(0)).toMatchObject({ status: 'ABANDONED', table: { phase: 'REMATCH' },
      legalActions: [{ type: 'REMATCH_VOTE', accept: true }, { type: 'REMATCH_VOTE', accept: false }] });
    expect(h.actor.getView(0).seats[0].connected).toBe(true);
    expect(await h.actor.dispatch(0, h.command({ type: 'REMATCH_VOTE', accept: true }))).toMatchObject({ ok: true });
    h.actor.stop();
  });

  test('rematch replenishes a spent bank and requires renewed consent after a voter disconnects', async () => {
    const h = harness({ timers: { turnMs: 1, doubleMs: 1, timeBankMs: 30000 } });
    await h.actor.start(); await h.connectAll(); await h.readyAll();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.actor.getView(3).timeBankMs).toBe(0);
    await h.finish();
    for (const seat of [0, 1, 2]) await h.actor.dispatch(seat, h.command({ type: 'REMATCH_VOTE', accept: true }, seat));
    await h.actor.setConnected(0, false);
    await h.actor.setConnected(0, true);
    expect(h.actor.getView(0).table.votes).toEqual([null, true, true, null]);
    await h.actor.dispatch(3, h.command({ type: 'REMATCH_VOTE', accept: true }, 3));
    expect(h.actor.getView(0).table.phase).toBe('REMATCH');
    await h.actor.dispatch(0, h.command({ type: 'REMATCH_VOTE', accept: true }));
    expect(h.actor.getView(3)).toMatchObject({ timeBankMs: 30000, table: { phase: 'PLAYING', matchNumber: 2 } });
    h.actor.stop();
  });

  test('restart invalidates old ready consent, preserves rematch deadline, and verifies stored coordination', async () => {
    const h = harness(); await h.actor.start(); await h.connectAll();
    await h.actor.dispatch(0, h.command({ type: 'READY' }));
    const readyArchive = JSON.parse(JSON.stringify(h.records)); h.actor.stop();
    const restored = await restoreMatchActor(readyArchive, h.ports);
    expect(restored.getView(0).table).toMatchObject({ phase: 'WAITING', ready: [false, false, false, false] });
    await h.connectAll(restored); await h.readyAll(restored); restored.stop();
    const corrupt = structuredClone(readyArchive); corrupt.at(-1).table.ready[1] = true;
    await expect(restoreMatchActor(corrupt, h.ports)).rejects.toThrow('replay mismatch');
    const other = harness(); await other.actor.start(); await other.connectAll(); await other.readyAll(); await other.finish();
    await other.actor.dispatch(0, other.command({ type: 'REMATCH_VOTE', accept: true }));
    const deadline = other.actor.getView(0).table.deadline;
    const archive = JSON.parse(JSON.stringify(other.records)); other.actor.stop();
    const ended = await restoreMatchActor(archive, other.ports);
    expect(ended.getView(0).table).toMatchObject({ phase: 'REMATCH', deadline, votes: [null, null, null, null] });
    await jest.advanceTimersByTimeAsync(20000);
    expect(ended.getView(0).table.phase).toBe('CLOSED'); ended.stop();
  });

  test('a crash between consent and the automatic deal recovers exactly one deal; failed consent never publishes', async () => {
    const h = harness(); await h.actor.start(); await h.connectAll(); await h.readyAll();
    const archive = JSON.parse(JSON.stringify(h.records.slice(0, -1))); h.actor.stop();
    h.ports.shuffle.mockClear();
    const recovered = await restoreMatchActor(archive, h.ports);
    expect(recovered.getView(0)).toMatchObject({ phase: 'AUCTION', table: { phase: 'PLAYING' } });
    expect(h.ports.shuffle).toHaveBeenCalledTimes(1); recovered.stop();
    const failed = harness(); await failed.actor.start(); await failed.connectAll();
    const count = failed.published.length;
    failed.ports.append.mockRejectedValueOnce(new Error('disk failed'));
    await expect(failed.actor.dispatch(0, failed.command({ type: 'READY' }))).rejects.toThrow('disk failed');
    expect(failed.published).toHaveLength(count); expect(failed.ports.shuffle).not.toHaveBeenCalled(); failed.actor.stop();
  });

  test('a crash after rematch consent uses its committed dealer, not a second random draw', async () => {
    const h = harness(); await h.actor.start(); await h.connectAll(); await h.readyAll(); await h.finish();
    for (const seat of [0, 1, 2, 3]) await h.actor.dispatch(seat, h.command({ type: 'REMATCH_VOTE', accept: true }, seat));
    const archive = JSON.parse(JSON.stringify(h.records.slice(0, -1))); h.actor.stop();
    expect(archive.at(-1).rematchDealer).toBe(1);
    h.ports.firstDealer.mockClear(); h.ports.shuffle.mockClear();
    const recovered = await restoreMatchActor(archive, h.ports);
    expect(recovered.getView(0)).toMatchObject({ phase: 'AUCTION', dealer: 1, table: { matchNumber: 2, phase: 'PLAYING' } });
    expect(h.ports.firstDealer).not.toHaveBeenCalled(); expect(h.ports.shuffle).toHaveBeenCalledTimes(1);
    recovered.stop();
  });
});
