const { describe, test, expect, afterEach } = require('@jest/globals');
const { createMatchActor, restoreMatchActor } = require('../../src/application/match-actor.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { createDeck } = require('../../src/domain/cards.ts');
const { nodeRuntime, secureShuffle } = require('../../src/adapters/node-runtime.ts');

function harness(options = {}) {
  jest.useFakeTimers({ now: 1000 });
  const records = [];
  const published = [];
  const ports = { now: () => Date.now(), firstDealer: () => 0, shuffle: jest.fn(createDeck),
    botDelayMs: jest.fn(() => 600),
    schedule: (deadline, callback) => {
      const timer = setTimeout(callback, Math.max(0, deadline - Date.now()));
      return () => clearTimeout(timer);
    },
    append: jest.fn(async record => { records.push(record); }),
    publish: jest.fn((viewer, events) => { published.push({ viewer, events }); }), onError: jest.fn(),
  };
  const actor = createMatchActor({ matchId: 'test', ruleset: PRESETS['29-standard'], ...options }, ports);
  let id = 0;
  function command(action, viewer = 3, overrides = {}) {
    return { commandId: `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      matchId: 'test', expectedVersion: actor.getView(viewer).version, action, ...overrides };
  }
  return { actor, ports, records, published, command };
}
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('single-writer match runtime', () => {
  test('starts once, persists before publication, and publishes private sequenced traffic only', async () => {
    const h = harness();
    // Publication happens during startup, before external getView is available.
    h.ports.publish.mockImplementation((viewer, events) => {
      expect(h.records).toHaveLength(1);
      expect(events.every(event => event.matchId === 'test' && event.timestamp === 1000 && event.eventId)).toBe(true);
      expect(events.map(event => event.seq)).toEqual(events.map((_, i) => i + 1));
      expect(events.filter(event => event.event.type === 'CARDS_DEALT')).toHaveLength(viewer === 'spectator' ? 0 : 1);
    });
    await h.actor.start(); await h.actor.start();
    expect(h.ports.shuffle).toHaveBeenCalledTimes(1);
    expect(h.actor.getView(3)).toMatchObject({ phase: 'AUCTION', deadline: 21000, remainingMs: 20000, timeBankMs: 30000 });
    expect(h.actor.getView('spectator')).toMatchObject({ myHand: [], timeBankMs: null });
    expect(h.ports.onError).not.toHaveBeenCalled();
  });

  test('serializes concurrent commands and returns cached successful and rejected results', async () => {
    const h = harness(); await h.actor.start();
    const bid = h.command({ type: 'BID', amount: 16 });
    const [first, duplicate] = await Promise.all([h.actor.dispatch(3, bid), h.actor.dispatch(3, bid)]);
    expect(first).toEqual(duplicate); expect(first.ok).toBe(true);
    expect(h.records).toHaveLength(2);
    const stale = h.command({ type: 'PASS' }, 2, { expectedVersion: 1 });
    const rejected = await h.actor.dispatch(2, stale);
    expect(rejected).toMatchObject({ ok: false, code: 'STALE_STATE', snapshot: { myHand: h.actor.getView(2).myHand } });
    expect(await h.actor.dispatch(2, stale)).toEqual(rejected);
    expect(h.records).toHaveLength(3);
    rejected.snapshot.myHand.pop();
    expect((await h.actor.dispatch(2, stale)).snapshot.myHand).toHaveLength(4);
  });

  test('rejects client authority, spoofed seats, malformed and cross-match inputs', async () => {
    const h = harness(); await h.actor.start();
    for (const raw of [{}, h.command({ type: 'TIMEOUT', decisionVersion: 1 }),
      { ...h.command({ type: 'BID', amount: 16 }), actor: 'system' },
      h.command({ type: 'BID', amount: 16 }, 3, { matchId: 'another' })]) {
      expect(await h.actor.dispatch(3, raw)).toMatchObject({ ok: false, code: 'INVALID_COMMAND' });
    }
    expect(await h.actor.dispatch(9, h.command({ type: 'PASS' }))).toMatchObject({ code: 'INVALID_COMMAND' });
    expect(() => h.actor.getView(9)).toThrow();
    expect(h.records).toHaveLength(1);
  });

  test('uses the time bank once, rejects expired arrivals, then applies forced opener default', async () => {
    const h = harness(); await h.actor.start();
    const expired = h.command({ type: 'BID', amount: 17 });
    jest.setSystemTime(21000);
    expect(await h.actor.dispatch(3, expired)).toMatchObject({ code: 'TURN_EXPIRED' });
    await jest.advanceTimersByTimeAsync(20000);
    expect(h.actor.getView(3)).toMatchObject({ deadline: 51000, timeBankMs: 0, phase: 'AUCTION' });
    const turn = h.published.flatMap(entry => entry.events).find(event => event.event.remainingMs === 10000);
    expect(turn.event.deadline).toBe(51000);
    await jest.advanceTimersByTimeAsync(10000);
    expect(h.actor.getView(3).auction.current).toBe(16);
    expect(h.actor.getView(3).toAct).toBe(2);
    expect(await h.actor.dispatch(3, expired)).toMatchObject({ code: 'TURN_EXPIRED', version: 1 });
    expect(h.ports.onError).not.toHaveBeenCalled();
  });

  test('late callbacks never extend a bank from callback arrival time', async () => {
    const h = harness(); await h.actor.start();
    jest.setSystemTime(100000);
    await jest.advanceTimersByTimeAsync(20000);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.actor.getView(3).auction.current).toBe(16);
    expect(h.actor.getView(3).timeBankMs).toBe(0);
  });

  test('storage failure fails closed without publishing an uncommitted transition', async () => {
    const h = harness(); await h.actor.start();
    const bid = h.command({ type: 'BID', amount: 16 });
    h.ports.append.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(h.actor.dispatch(3, bid)).rejects.toThrow('disk unavailable');
    expect(h.ports.publish).toHaveBeenCalledTimes(5);
    expect(() => h.actor.getView(3)).toThrow('unavailable');
    await expect(h.actor.dispatch(3, bid)).rejects.toThrow('unavailable');
  });

  test('graceful shutdown drains an in-flight journal append before completing', async () => {
    const h = harness(); await h.actor.start();
    let release;
    let entered;
    const appending = new Promise(resolve => { entered = resolve; });
    h.ports.append.mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); }));
    const dispatched = h.actor.dispatch(3, h.command({ type: 'BID', amount: 16 }));
    await appending;
    let drained = false;
    const shutdown = h.actor.shutdown().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    expect(await dispatched).toMatchObject({ ok: true, version: 2 });
    await shutdown;
    expect(drained).toBe(true);
    expect(() => h.actor.getView(3)).toThrow('unavailable');
    await jest.advanceTimersByTimeAsync(100000);
    expect(h.ports.append).toHaveBeenCalledTimes(2);
  });

  test('revelation preserves the deadline and stale scheduled work cannot act', async () => {
    const h = harness({ timers: { turnMs: 20, doubleMs: 10, timeBankMs: 0 } });
    const callbacks = [];
    h.ports.schedule = (deadline, callback) => { callbacks.push(callback); return jest.fn(); };
    await h.actor.start();
    let found = false;
    for (let count = 0; count < 500 && !found; count++) {
      const seat = h.actor.getView(0).toAct;
      const actorView = h.actor.getView(seat);
      const reveal = actorView.legalActions.find(action => ['CALL_TRUMP', 'REVEAL_TRUMP'].includes(action.type));
      if (reveal) {
        const deadline = actorView.deadline;
        const stale = callbacks[callbacks.length - 1];
        jest.setSystemTime(Date.now() + 1);
        await h.actor.dispatch(seat, h.command(reveal, seat));
        expect(h.actor.getView(seat).deadline).toBe(deadline);
        const version = h.actor.getView(seat).version;
        stale();
        const action = h.actor.getView(seat).legalActions[0];
        await h.actor.dispatch(seat, h.command(action, seat, { expectedVersion: version - 1 }));
        expect(h.actor.getView(seat).version).toBe(version);
        found = true;
      } else {
        await h.actor.dispatch(seat, h.command(actorView.legalActions[0], seat));
      }
    }
    expect(found).toBe(true);
    expect(h.ports.onError).not.toHaveBeenCalled();
  });

  test('publication errors do not undo persisted commands; stop cancels deadlines', async () => {
    const h = harness(); await h.actor.start();
    h.ports.publish.mockImplementation(() => { throw new Error('socket gone'); });
    expect((await h.actor.dispatch(3, h.command({ type: 'BID', amount: 16 }))).ok).toBe(true);
    expect(h.ports.onError).toHaveBeenCalledTimes(5);
    h.actor.stop(); await jest.advanceTimersByTimeAsync(100000);
    expect(h.records).toHaveLength(2);
    expect(() => h.actor.getView(3)).toThrow('unavailable');
  });

  test('runtime advances a complete match with fresh deals using timeout decisions', async () => {
    const h = harness({ timers: { turnMs: 10, doubleMs: 5, timeBankMs: 0 } });
    await h.actor.start();
    let turns = 0;
    while (h.actor.getView(0).status === 'IN_PROGRESS') {
      await jest.advanceTimersByTimeAsync(10);
      expect(++turns).toBeLessThan(3000);
    }
    expect(h.actor.getView(0).status).toBe('FINISHED');
    expect(h.ports.shuffle.mock.calls.length).toBeGreaterThan(1);
    expect(h.ports.onError).not.toHaveBeenCalled();
    for (const viewer of [0, 1, 2, 3, 'spectator']) {
      const events = h.published.filter(entry => entry.viewer === viewer).flatMap(entry => entry.events);
      expect(events.map(event => event.seq)).toEqual(events.map((_, i) => i + 1));
    }
  });
});

describe('persisted disconnect and bot lifecycle', () => {
  async function table(options = {}) {
    const h = harness({ lifecycle: {}, timers: { turnMs: 600000, timeBankMs: 30000 }, ...options });
    await h.actor.start();
    for (const seat of [0, 1, 2, 3]) await h.actor.setConnected(seat, true);
    return h;
  }
  function events(h, viewer = 'spectator') {
    return h.published.filter(entry => entry.viewer === viewer).flatMap(entry => entry.events);
  }

  test('disconnect grace preserves turn timing, then the filtered-view bot makes the timeout-policy move', async () => {
    const h = await table();
    const deadline = h.actor.getView(3).deadline;
    await h.actor.setConnected(3, false);
    const count = h.records.length;
    await h.actor.setConnected(3, false);
    expect(h.records).toHaveLength(count);
    await jest.advanceTimersByTimeAsync(59999);
    expect(h.actor.getView(3).seats[3]).toMatchObject({ connected: false, controller: 'human' });
    await jest.advanceTimersByTimeAsync(1);
    expect(h.actor.getView(3)).toMatchObject({ deadline, timeBankMs: 30000,
      seats: [{ controller: 'human' }, {}, {}, { controller: 'bot' }] });
    expect(events(h).filter(entry => entry.event.type === 'BOT_TOOK_OVER')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(599);
    expect(h.actor.getView(3).auction.current).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.actor.getView(3).auction.current).toBe(16);
    expect(h.records.at(-1).input).toMatchObject({ actor: 3, action: { type: 'BID', amount: 16 } });
    expect(h.records.at(-2).botDelayMs).toBe(600);
    expect(h.ports.onError).not.toHaveBeenCalled();
    const seqs = events(h).map(event => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    h.actor.stop();
  });

  test('reconnection within grace cancels takeover without restarting the turn or time bank', async () => {
    const h = await table();
    await h.actor.setConnected(3, false);
    await jest.advanceTimersByTimeAsync(59999);
    await h.actor.setConnected(3, true);
    const count = h.records.length;
    await h.actor.setConnected(3, true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.records).toHaveLength(count);
    expect(h.actor.getView(3)).toMatchObject({ deadline: 601000, timeBankMs: 30000 });
    expect(events(h).some(entry => entry.event.type === 'BOT_TOOK_OVER')).toBe(false);
    expect(await h.actor.dispatch(3, h.command({ type: 'BID', amount: 16 }))).toMatchObject({ ok: true });
    h.actor.stop();
  });

  test('leave takes over immediately and reconnect reclaims only after the current bot decision', async () => {
    const h = await table();
    await h.actor.leave(3);
    expect(h.actor.getView(3).seats[3]).toMatchObject({ controller: 'bot', connected: false });
    await h.actor.setConnected(3, true);
    expect(h.actor.getView(3).seats[3]).toMatchObject({ controller: 'bot', reclaimPending: true, connected: true });
    const blocked = h.command({ type: 'BID', amount: 17 });
    expect(await h.actor.dispatch(3, blocked)).toMatchObject({ code: 'SEAT_NOT_CONTROLLED' });
    await jest.advanceTimersByTimeAsync(600);
    expect(h.actor.getView(3).auction.current).toBe(16);
    expect(h.actor.getView(3).seats[3]).toEqual({ controller: 'human', connected: true, reclaimPending: false });
    expect(h.records.at(-1).state.settings.preferences[3].isBot).toBe(false);
    expect(await h.actor.dispatch(3, blocked)).toMatchObject({ code: 'SEAT_NOT_CONTROLLED' });
    expect(events(h).some(entry => entry.event.type === 'PLAYER_RECLAIMED')).toBe(true);
    h.actor.stop();
  });

  test('all-human abandonment uses the last disconnect, survives bots, and is cancelled by a return', async () => {
    const h = await table({ lifecycle: { disconnectGraceMs: 100, abandonAfterMs: 2000 } });
    for (const seat of [0, 1, 2]) await h.actor.setConnected(seat, false);
    await jest.advanceTimersByTimeAsync(1000);
    expect(h.actor.getView(0).status).toBe('IN_PROGRESS');
    await h.actor.setConnected(3, false);
    await jest.advanceTimersByTimeAsync(1999);
    expect(h.actor.getView(0).status).toBe('IN_PROGRESS');
    await h.actor.setConnected(0, true);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.actor.getView(0).status).toBe('IN_PROGRESS');
    await h.actor.setConnected(0, false);
    await jest.advanceTimersByTimeAsync(2000);
    expect(h.actor.getView(0)).toMatchObject({ phase: 'ABANDONED', status: 'ABANDONED', winner: null, deadline: null });
    const count = h.records.length;
    await jest.advanceTimersByTimeAsync(10000);
    expect(h.records).toHaveLength(count);
    expect(h.ports.onError).not.toHaveBeenCalled();
    h.actor.stop();
  });

  test('late reconnects cannot evade grace or an already-expired abandonment deadline', async () => {
    const h = await table({ lifecycle: { disconnectGraceMs: 100, abandonAfterMs: 1000 } });
    await h.actor.setConnected(3, false);
    jest.setSystemTime(1100);
    await h.actor.setConnected(3, true);
    expect(h.actor.getView(3).seats[3]).toMatchObject({ controller: 'bot', reclaimPending: true });
    for (const seat of [0, 1, 2, 3]) await h.actor.setConnected(seat, false);
    jest.setSystemTime(2100);
    await h.actor.setConnected(3, true);
    expect(h.actor.getView(3).status).toBe('ABANDONED');
    h.actor.stop();
  });

  test('turn timeouts still run offline and an expired rejected arrival does not disarm the scheduler', async () => {
    const h = await table({ timers: { turnMs: 100, timeBankMs: 0 } });
    await h.actor.setConnected(3, false);
    const rejected = h.command({ type: 'BID', amount: 17 });
    expect(await h.actor.dispatch(3, rejected)).toMatchObject({ code: 'SEAT_NOT_CONTROLLED' });
    await jest.advanceTimersByTimeAsync(100);
    expect(h.actor.getView(3).auction.current).toBe(16);
    const seat = h.actor.getView(0).toAct;
    const late = h.command({ type: 'PASS' }, seat);
    jest.setSystemTime(1200);
    expect(await h.actor.dispatch(seat, late)).toMatchObject({ code: 'TURN_EXPIRED' });
    await jest.advanceTimersByTimeAsync(100);
    expect(h.actor.getView(0).toAct).not.toBe(seat);
    h.actor.stop();
  });

  test.each(Object.keys(PRESETS))('%s baseline bots complete full matches from legal filtered views', async preset => {
    const h = harness({ ruleset: PRESETS[preset], lifecycle: { abandonAfterMs: 1000000 },
      timers: { turnMs: 5000, timeBankMs: 0 } });
    await h.actor.start();
    await jest.advanceTimersByTimeAsync(60000);
    let moves = 0;
    while (h.actor.getView(0).status === 'IN_PROGRESS') {
      await jest.advanceTimersByTimeAsync(600);
      expect(++moves).toBeLessThan(3000);
    }
    expect(h.actor.getView(0).status).toBe('FINISHED');
    const botMoves = h.records.filter(record => record.input && record.input.actor !== 'system');
    expect(botMoves.length).toBeGreaterThan(32);
    expect(botMoves.some(record => record.input.action.type === 'SELECT_TRUMP')).toBe(true);
    expect(botMoves.some(record => record.input.action.type === 'PLAY_CARD')).toBe(true);
    expect(h.ports.onError).not.toHaveBeenCalled();
    h.actor.stop();
  });

  test('recovery verifies presence/bot records, preserves offline deadlines, and disconnects old sockets', async () => {
    const h = await table();
    await h.actor.leave(3);
    await jest.advanceTimersByTimeAsync(600);
    const archive = JSON.parse(JSON.stringify(h.records));
    h.actor.stop();
    h.ports.append.mockClear(); h.ports.publish.mockClear();
    const recovered = await restoreMatchActor(archive, h.ports);
    expect(recovered.getView(0).auction.current).toBe(16);
    expect(recovered.getView(0).seats.every(seat => !seat.connected)).toBe(true);
    expect(h.records.at(-1).lifecycleOperation.type).toBe('RESTART_DISCONNECT');
    expect(recovered.getView(0).seats[3].controller).toBe('bot');
    await jest.advanceTimersByTimeAsync(60000);
    expect(recovered.getView(0).seats.every(seat => seat.controller === 'bot')).toBe(true);
    recovered.stop();
    for (const mutate of [
      records => { records.at(-1).lifecycle.seats[3].controller = 'human'; },
      records => { records.find(record => record.botDelayMs).botDelayMs = 1; },
      records => { records.find(record => record.input?.actor === 3).input.action.amount = 17; },
    ]) {
      const changed = structuredClone(archive); mutate(changed);
      await expect(restoreMatchActor(changed, h.ports)).rejects.toThrow();
    }
  });

  test('all simultaneous grace expiries commit at the same recorded time', async () => {
    const h = await table();
    for (const seat of [0, 1, 2, 3]) await h.actor.setConnected(seat, false);
    await jest.advanceTimersByTimeAsync(60000);
    expect(h.actor.getView(0).seats.every(seat => seat.controller === 'bot')).toBe(true);
    const takeovers = h.records.filter(record => record.lifecycleOperation?.type === 'TAKEOVER');
    expect(takeovers.map(record => record.lifecycleOperation.seat)).toEqual([0, 1, 2, 3]);
    expect(takeovers.map(record => record.recordedAt)).toEqual([61000, 61000, 61000, 61000]);
    expect(h.actor.getView(3)).toMatchObject({ deadline: 601000, timeBankMs: 30000 });
    h.actor.stop();
  });

  test('recovery preserves an already-offline abandonment deadline instead of granting more time', async () => {
    const h = await table({ lifecycle: { disconnectGraceMs: 100, abandonAfterMs: 2000 } });
    for (const seat of [0, 1, 2, 3]) await h.actor.setConnected(seat, false);
    await jest.advanceTimersByTimeAsync(500);
    h.actor.stop();
    const recovered = await restoreMatchActor(JSON.parse(JSON.stringify(h.records)), h.ports);
    await jest.advanceTimersByTimeAsync(1499);
    expect(recovered.getView(0).status).toBe('IN_PROGRESS');
    await jest.advanceTimersByTimeAsync(1);
    expect(recovered.getView(0)).toMatchObject({ status: 'ABANDONED', winner: null });
    expect(h.records.at(-1).input).toMatchObject({ now: 3000, action: { type: 'ABANDON' } });
    recovered.stop();
  });

  test('revelation does not hand a returning human control halfway through a bot turn', async () => {
    const { baselineBotAction } = require('../../src/application/baseline-bot.ts');
    const h = harness({ lifecycle: { disconnectGraceMs: 1, abandonAfterMs: 1000000 },
      timers: { turnMs: 5000, timeBankMs: 0 } });
    await h.actor.start();
    await jest.advanceTimersByTimeAsync(1);
    let found = false;
    for (let count = 0; count < 400 && h.actor.getView(0).status === 'IN_PROGRESS'; count++) {
      const seat = h.actor.getView(0).toAct;
      const view = h.actor.getView(seat);
      const action = baselineBotAction(view);
      if (action && ['CALL_TRUMP', 'REVEAL_TRUMP'].includes(action.type)) {
        await h.actor.setConnected(seat, true);
        const deadline = view.deadline;
        await jest.advanceTimersByTimeAsync(600);
        expect(h.actor.getView(seat)).toMatchObject({ deadline, toAct: seat });
        expect(h.actor.getView(seat).seats[seat]).toMatchObject({ controller: 'bot', reclaimPending: true });
        expect(h.records.at(-1).input.action.type).toBe(action.type);
        await jest.advanceTimersByTimeAsync(600);
        expect(h.actor.getView(seat).seats[seat]).toMatchObject({ controller: 'human', reclaimPending: false });
        expect(h.records.at(-2).input.action.type).toBe('PLAY_CARD');
        found = true;
        break;
      }
      await jest.advanceTimersByTimeAsync(600);
    }
    expect(found).toBe(true);
    expect(h.ports.onError).not.toHaveBeenCalled();
    h.actor.stop();
  });

  test('stale grace callbacks cannot take over a reconnected seat', async () => {
    const h = harness({ lifecycle: {}, timers: { turnMs: 600000 } });
    const callbacks = [];
    h.ports.schedule = (deadline, callback) => { callbacks.push(callback); return () => {}; };
    await h.actor.start();
    for (const seat of [0, 1, 2, 3]) await h.actor.setConnected(seat, true);
    await h.actor.setConnected(3, false);
    const stale = callbacks.at(-1);
    await h.actor.setConnected(3, true);
    const count = h.records.length;
    jest.setSystemTime(61000);
    stale();
    // Invalid input is still serialized, providing a queue barrier without a move.
    await h.actor.dispatch(0, {});
    expect(h.records).toHaveLength(count);
    expect(h.actor.getView(3).seats[3]).toMatchObject({ controller: 'human', connected: true });
    h.actor.stop();
  });

  test('presence timestamps cannot move backwards even without an engine command', async () => {
    const h = await table();
    jest.setSystemTime(2000);
    await h.actor.setConnected(0, false);
    const count = h.records.length;
    jest.setSystemTime(1999);
    await expect(h.actor.setConnected(1, false)).rejects.toThrow('runtime clock');
    expect(h.records).toHaveLength(count);
    expect(() => h.actor.getView(0)).toThrow('unavailable');
    h.actor.stop();
  });

  test('a bot-only table never triggers all-human abandonment', async () => {
    const h = harness({ lifecycle: { disconnectGraceMs: 100, abandonAfterMs: 200 },
      settings: { preferences: Array.from({ length: 4 }, () => ({ autoDeclarePair: false, isBot: true })) } });
    await h.actor.start();
    await jest.advanceTimersByTimeAsync(600);
    expect(h.actor.getView(0)).toMatchObject({ status: 'IN_PROGRESS', auction: { current: 16 } });
    expect(h.records.some(record => record.input?.action.type === 'ABANDON')).toBe(false);
    h.actor.stop();
  });

  test('lifecycle configuration requires a delay source and bounded positive deadlines', () => {
    const { lifecycleSettingsSchema } = require('../../src/application/seat-lifecycle.ts');
    const h = harness();
    expect(() => createMatchActor({ matchId: 'bad', ruleset: PRESETS['29-standard'], lifecycle: {} },
      { ...h.ports, botDelayMs: undefined })).toThrow('bot-delay');
    for (const settings of [{ disconnectGraceMs: 0 }, { abandonAfterMs: -1 },
      { disconnectGraceMs: 2_147_483_648 }, { abandonAfterMs: 0.5 }, { bogus: true }]) {
      expect(lifecycleSettingsSchema.safeParse(settings).success).toBe(false);
    }
    expect(lifecycleSettingsSchema.parse({})).toEqual({ disconnectGraceMs: 60000, abandonAfterMs: 600000 });
    h.actor.stop();
  });

  test('presence storage failure cannot publish takeover or continue the match', async () => {
    const h = await table();
    const before = events(h).length;
    h.ports.append.mockRejectedValueOnce(new Error('disk failed'));
    await expect(h.actor.leave(3)).rejects.toThrow('disk failed');
    expect(events(h)).toHaveLength(before);
    await jest.advanceTimersByTimeAsync(60000);
    expect(() => h.actor.getView(3)).toThrow('unavailable');
    h.actor.stop();
  });
});

describe('Node production effects', () => {
  test('bot delay samples a fixed crypto range without consulting a decision', () => {
    const random = jest.spyOn(require('node:crypto'), 'randomInt').mockReturnValue(1250);
    expect(nodeRuntime.botDelayMs()).toBe(1250);
    expect(random).toHaveBeenCalledWith(600, 1501);
  });
  test('Fisher-Yates uses crypto integer bounds and never loses cards', () => {
    const crypto = require('node:crypto');
    const random = jest.spyOn(crypto, 'randomInt').mockImplementation(max => max - 1);
    expect(secureShuffle()).toEqual(createDeck());
    expect(random.mock.calls.map(([max]) => max)).toEqual(Array.from({ length: 31 }, (_, i) => 32 - i));
    expect(nodeRuntime.firstDealer()).toBe(3);
    random.mockRestore();
    expect(new Set(secureShuffle()).size).toBe(32);
  });

  test('Node deadlines can be cancelled', async () => {
    jest.useFakeTimers({ now: 1000 });
    const callback = jest.fn();
    const cancel = nodeRuntime.schedule(1100, callback);
    cancel(); await jest.advanceTimersByTimeAsync(100);
    expect(callback).not.toHaveBeenCalled();
    nodeRuntime.schedule(900, callback);
    await jest.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(nodeRuntime.now()).toBe(1100);
  });
});
