const { describe, test, expect, afterEach } = require('@jest/globals');
const { mkdtemp, readFile, writeFile, appendFile, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createMatchActor, restoreMatchActor } = require('../../src/application/match-actor.ts');
const { openFileJournal } = require('../../src/adapters/file-journal.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { createDeck } = require('../../src/domain/cards.ts');

const resources = [];
afterEach(async () => {
  for (const cleanup of resources.reverse()) await cleanup();
  resources.length = 0;
  jest.restoreAllMocks();
});
async function location() {
  const dir = await mkdtemp(join(tmpdir(), '29-journal-'));
  resources.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'match.journal');
}
async function journal(path, key = Buffer.alloc(32, 7), matchId = 'match') {
  const store = await openFileJournal(path, key, matchId);
  resources.push(() => store.close());
  return store;
}
function runtime(append = jest.fn(async () => {})) {
  const scheduled = [];
  let clock = 1000;
  const ports = { now: () => clock, firstDealer: jest.fn(() => 0), shuffle: jest.fn(createDeck),
    append, publish: jest.fn(), onError: jest.fn(),
    schedule: (deadline, callback) => { scheduled.push({ deadline, callback }); return jest.fn(); } };
  return { ports, scheduled, setTime: value => { clock = value; } };
}
const options = { matchId: 'match', ruleset: PRESETS['29-standard'] };
let id = 0;
function command(actor, seat, action, expectedVersion = actor.getView(seat).version) {
  return { matchId: 'match', commandId: `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    expectedVersion, action };
}

describe('encrypted append-only file journal', () => {
  test('encrypts records, fsyncs before completion, locks writers and reopens committed data', async () => {
    const path = await location();
    const store = await journal(path);
    await expect(openFileJournal(path, Buffer.alloc(32, 7), 'match')).rejects.toMatchObject({ code: 'EEXIST' });
    const r = runtime(store.append);
    const actor = createMatchActor(options, r.ports);
    await actor.start();
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('START_DEAL'); expect(text).not.toContain('JC');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    actor.stop(); await store.close();
    const reopened = await journal(path);
    expect(reopened.records).toHaveLength(1);
    expect(reopened.records[0].input.action.type).toBe('START_DEAL');
    await expect(store.append(reopened.records[0])).rejects.toThrow('unavailable');
  });

  test('rejects wrong keys, wrong match, tampering, reordered records and unknown format', async () => {
    const path = await location();
    const store = await journal(path);
    const r = runtime(store.append); const actor = createMatchActor(options, r.ports);
    await actor.start(); await actor.dispatch(3, command(actor, 3, { type: 'BID', amount: 16 }));
    actor.stop(); await store.close();
    const original = await readFile(path, 'utf8');
    await expect(openFileJournal(path, Buffer.alloc(32, 9), 'match')).rejects.toThrow();
    await expect(openFileJournal(path, Buffer.alloc(32, 7), 'other')).rejects.toThrow();
    const lines = original.trimEnd().split('\n');
    const envelope = JSON.parse(lines[0]);
    for (const changed of [
      { ...envelope, tag: '0'.repeat(32) }, { ...envelope, format: 2 },
      { ...envelope, previous: '1'.repeat(64) },
    ]) {
      await writeFile(path, `${JSON.stringify(changed)}\n${lines[1]}\n`);
      await expect(openFileJournal(path, Buffer.alloc(32, 7), 'match')).rejects.toThrow();
    }
    await writeFile(path, `${lines.reverse().join('\n')}\n`);
    await expect(openFileJournal(path, Buffer.alloc(32, 7), 'match')).rejects.toThrow();
  });

  test('discards only an incomplete tail and continues appending with a valid chain', async () => {
    const path = await location(); const store = await journal(path);
    const r = runtime(store.append); const actor = createMatchActor(options, r.ports);
    await actor.start(); actor.stop(); await store.close();
    const original = await readFile(path, 'utf8');
    await appendFile(path, '{"partial":');
    const reopened = await journal(path);
    expect(await readFile(path, 'utf8')).toBe(original);
    await reopened.append(reopened.records[0]);
    await reopened.close();
    expect((await journal(path)).records).toHaveLength(2);
  });

  test('validates key length and refuses publicly readable journals', async () => {
    const path = await location();
    await expect(openFileJournal(path, Buffer.alloc(8), 'match')).rejects.toThrow('configuration');
    await writeFile(path, '', { mode: 0o644 });
    await expect(openFileJournal(path, Buffer.alloc(32), 'match')).rejects.toThrow('private');
  });

  test('sync failure rejects the append and prevents subsequent writes', async () => {
    const fs = require('node:fs/promises');
    const originalOpen = fs.open;
    const handles = [];
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args); handles.push(handle); return handle;
    });
    const path = await location(); const store = await journal(path);
    const handle = handles[1];
    jest.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('sync failed'));
    const r = runtime(store.append); const actor = createMatchActor(options, r.ports);
    await expect(actor.start()).rejects.toThrow('sync failed');
    expect(r.ports.publish).not.toHaveBeenCalled();
    await expect(store.append({})).rejects.toThrow('unavailable');
  });
});

describe('verified match recovery', () => {
  test('completed hand history is rebuilt from the encrypted journal after live play has advanced', async () => {
    const { baselineBotAction } = require('../../src/application/baseline-bot.ts');
    const path = await location(); const store = await journal(path);
    const r = runtime(store.append);
    const actor = createMatchActor(options, r.ports); await actor.start();
    for (let count = 0; actor.getView(0).handNumber === 1; count++) {
      expect(count).toBeLessThan(150);
      const seat = actor.getView(0).toAct;
      expect(await actor.dispatch(seat, command(actor, seat, baselineBotAction(actor.getView(seat))))).toMatchObject({ ok: true });
    }
    expect(actor.getView(0).summary).toBeNull();
    const before = actor.getHistory(0, { limit: 10 });
    expect(before.entries).toHaveLength(1); expect(before.entries[0].kind).toBe('HAND');
    actor.stop(); await store.close();
    const reopened = await journal(path);
    const recovered = await restoreMatchActor(reopened.records, runtime(reopened.append).ports);
    expect(recovered.getHistory('spectator', { limit: 10 })).toEqual(before);
    recovered.stop();
  });

  test.each(Object.keys(PRESETS))('%s recovers mid-trick and continues with identical events', async preset => {
    const records = []; const r = runtime(async record => { records.push(record); });
    const actor = createMatchActor({ ...options, ruleset: PRESETS[preset] }, r.ports);
    await actor.start();
    let count = 0;
    while (actor.getView(0).phase !== 'PLAY' || actor.getView(0).currentTrick.plays.length !== 2) {
      const seat = actor.getView(0).toAct;
      await actor.dispatch(seat, command(actor, seat, actor.getView(seat).legalActions[0]));
      expect(++count).toBeLessThan(200);
    }
    const fresh = runtime(); const restored = await restoreMatchActor(JSON.parse(JSON.stringify(records)), fresh.ports);
    expect(restored.getView(0)).toEqual(actor.getView(0));
    const seat = actor.getView(0).toAct;
    const move = command(actor, seat, actor.getView(seat).legalActions[0]);
    expect(await restored.dispatch(seat, move)).toEqual(await actor.dispatch(seat, move));
    expect(restored.getView(seat)).toEqual(actor.getView(seat));
    expect(fresh.ports.publish.mock.calls).toEqual(r.ports.publish.mock.calls.slice(-5));
    restored.stop(); actor.stop();
  });

  test('restores views, rejected receipts, deadlines and sequence counters without redealing or republishing', async () => {
    const path = await location(); const store = await journal(path);
    const r = runtime(store.append); const actor = createMatchActor(options, r.ports);
    await actor.start();
    const bid = command(actor, 3, { type: 'BID', amount: 16 });
    const accepted = await actor.dispatch(3, bid);
    const stale = command(actor, 2, { type: 'PASS' }, 1);
    const rejected = await actor.dispatch(2, stale);
    const before = [0, 1, 2, 3, 'spectator'].map(seat => actor.getView(seat));
    const lastSeq = r.ports.publish.mock.calls.filter(([viewer]) => viewer === 2).flatMap(([, events]) => events).at(-1).seq;
    actor.stop(); await store.close();
    const reopened = await journal(path); const fresh = runtime(reopened.append);
    const restored = await restoreMatchActor(reopened.records, fresh.ports);
    expect([0, 1, 2, 3, 'spectator'].map(seat => restored.getView(seat))).toEqual(before);
    expect(fresh.ports.firstDealer).not.toHaveBeenCalled(); expect(fresh.ports.shuffle).not.toHaveBeenCalled();
    expect(fresh.ports.publish).not.toHaveBeenCalled();
    expect(await restored.dispatch(3, bid)).toEqual(accepted);
    expect(await restored.dispatch(2, stale)).toEqual(rejected);
    await restored.dispatch(2, command(restored, 2, { type: 'PASS' }));
    const next = fresh.ports.publish.mock.calls.find(([viewer]) => viewer === 2)[1];
    expect(next[0].seq).toBe(lastSeq + 1);
    expect(fresh.scheduled.at(-1).deadline).toBe(21000);
    restored.stop();
  });

  test('reschedules expired deadlines and preserves an already-consumed time bank', async () => {
    const records = []; const r = runtime(async record => { records.push(record); });
    const actor = createMatchActor(options, r.ports); await actor.start();
    r.setTime(21000); r.scheduled.at(-1).callback();
    // Dispatch queues behind the scheduled bank extension.
    const late = command(actor, 3, { type: 'BID', amount: 17 });
    r.setTime(51000); await actor.dispatch(3, late);
    expect(actor.getView(3).timeBankMs).toBe(0);
    actor.stop();
    const fresh = runtime(); fresh.setTime(60000);
    const restored = await restoreMatchActor(JSON.parse(JSON.stringify(records)), fresh.ports);
    expect(restored.getView(3)).toMatchObject({ deadline: 51000, timeBankMs: 0, remainingMs: 0 });
    expect(fresh.scheduled.at(-1).deadline).toBe(51000);
    fresh.scheduled.at(-1).callback();
    await restored.dispatch(3, late);
    expect(restored.getView(3).auction.current).toBe(16);
    expect(restored.getView(3).toAct).toBe(2);
    restored.stop();
  });

  test('rejects corrupt state, receipts, derived configuration, duplicate history and unsupported engines', async () => {
    const records = []; const r = runtime(async record => { records.push(record); });
    const actor = createMatchActor(options, r.ports); await actor.start();
    await actor.dispatch(3, command(actor, 3, { type: 'BID', amount: 16 })); actor.stop();
    const changes = [
      history => { history[0].state.version = 99; },
      history => { history[1].receipt.response.ok = false; },
      history => { history[0].metadata.engineVersion = '2.0.0'; },
      history => { history[0].metadata.ruleset.maxBid = 100; },
      history => { history.push(history[1]); },
      history => { history[0].input.now = 1001; },
      history => { history[1].deliveries[0].events[0].seq = 99; },
    ];
    for (const change of changes) {
      const history = structuredClone(records); change(history);
      const fresh = runtime();
      await expect(restoreMatchActor(history, fresh.ports)).rejects.toThrow();
      expect(fresh.ports.publish).not.toHaveBeenCalled(); expect(fresh.ports.append).not.toHaveBeenCalled();
    }
    await expect(restoreMatchActor([], runtime().ports)).rejects.toThrow();
  });
});
