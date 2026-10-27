const { describe, test, expect, afterEach } = require('@jest/globals');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createWebSocketGateway } = require('../../src/adapters/websocket-gateway.ts');
const { createMatchActor } = require('../../src/application/match-actor.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { createDeck } = require('../../src/domain/cards.ts');

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function harness(limits = {}, authenticate, lifecycle, table, lobby) {
  const server = createServer();
  const errors = [];
  const gateway = createWebSocketGateway({ server, allowedOrigins: ['https://game.example'], limits, ...(lobby ? { lobby } : {}),
    authenticate: authenticate ?? (async token => {
      if (token === 'seat3') return { matchId: 'test', viewer: 3 };
      if (token === 'seat2') return { matchId: 'test', viewer: 2 };
      if (token === 'seat0') return { matchId: 'test', viewer: 0 };
      if (token === 'seat1') return { matchId: 'test', viewer: 1 };
      if (token === 'watch') return { matchId: 'test', viewer: 'spectator' };
      return null;
    }), onError: error => errors.push(error) });
  const records = [];
  const lastPlayerDisconnects = [];
  let clock = 1000;
  const actor = createMatchActor({ matchId: 'test', ruleset: PRESETS['29-standard'], lifecycle, table }, {
    now: () => clock, firstDealer: () => 0, shuffle: createDeck,
    botDelayMs: () => 600,
    schedule: () => () => {}, append: async record => { records.push(record); },
    publish: (viewer, events) => gateway.publish('test', viewer, events), onError: error => errors.push(error),
  });
  gateway.registerMatch('test', actor, at => lastPlayerDisconnects.push(at));
  await actor.start();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => { actor.stop(); await gateway.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `ws://127.0.0.1:${server.address().port}/29-card/ws`;
  async function connect(token, clientOptions = {}) {
    const socket = new WebSocket(url, { origin: 'https://game.example', ...clientOptions });
    const messages = [];
    const waiters = [];
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      const index = waiters.findIndex(waiter => waiter.type === message.type);
      if (index < 0) messages.push(message);
      else waiters.splice(index, 1)[0].resolve(message);
    });
    const next = type => {
      const index = messages.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise(resolve => waiters.push({ type, resolve }));
    };
    const send = message => socket.send(JSON.stringify(message));
    await once(socket, 'open');
    const client = { socket, messages, next, send };
    if (token) {
      send({ type: 'HELLO', protocolVersion: 1, token });
      await next('WELCOME');
    }
    return client;
  }
  let id = 0;
  const command = (action = { type: 'BID', amount: 16 }, overrides = {}) => ({ type: 'COMMAND', command: {
    commandId: `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    matchId: 'test', expectedVersion: actor.getView(3).version, action, ...overrides,
  } });
  return { actor, records, errors, gateway, connect, command, url, server, lastPlayerDisconnects,
    setTime: timestamp => { clock = timestamp; } };
}

describe('authenticated WebSocket gateway integration', () => {
  test('closing a guest socket during a durable claim never marks that seat connected afterward', async () => {
    let release, entered;
    const appending = new Promise(resolve => { entered = resolve; });
    const lobby = { getView: () => ({ canClaim: true, expiresAt: Date.now() + 60000,
      seats: [0, 1, 2, 3].map(seat => ({ seat, occupied: false })) }),
    claim: () => new Promise(resolve => { release = resolve; entered(); }) };
    const h = await harness({}, async () => ({ matchId: 'test', viewer: 'guest' }), {}, {}, lobby);
    const serverConnection = once(h.server, 'connection');
    const guest = await h.connect('invite');
    const [transport] = await serverConnection;
    const count = h.records.length;
    guest.send({ type: 'TAKE_SEAT', requestId: '00000000-0000-4000-8000-000000000001', seat: 3, token: 'S'.repeat(43) });
    await appending;
    const closed = once(transport, 'close'); guest.socket.terminate(); await closed;
    release({ ok: true, seat: 3, expiresAt: Date.now() + 60000 });
    const observer = await h.connect('invite'); observer.send({ type: 'GET_LOBBY' }); await observer.next('LOBBY');
    await h.actor.dispatch(0, {});
    expect(h.actor.getView(3).seats[3].connected).toBe(false);
    expect(h.records).toHaveLength(count); expect(h.errors).toEqual([]);
  });

  test('guest authentication without a lobby and malformed seat-service results fail closed', async () => {
    const h = await harness({}, async () => ({ matchId: 'test', viewer: 'guest' }));
    const denied = await h.connect(); denied.send({ type: 'HELLO', protocolVersion: 1, token: 'invite' });
    expect(await denied.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    const withLobby = await harness({}, async () => ({ matchId: 'test', viewer: 'guest' }), {}, {}, {
      getView: () => ({ canClaim: true, expiresAt: Date.now() + 60000, seats: [0, 1, 2, 3].map(seat => ({ seat, occupied: false })) }),
      claim: async () => ({ ok: true, seat: 9, expiresAt: Date.now() + 60000 }),
    });
    const guest = await withLobby.connect('invite');
    guest.send({ type: 'TAKE_SEAT', requestId: '00000000-0000-4000-8000-000000000001', seat: 0, token: 'S'.repeat(43) });
    expect(await guest.next('ERROR')).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(withLobby.actor.getView(0).seats[0].connected).toBe(false);
  });

  test('lobby output strips extra data and does not disclose unrelated game-update timing', async () => {
    const expiresAt = Date.now() + 60000;
    const h = await harness({}, async () => ({ matchId: 'test', viewer: 'guest' }), {}, {}, {
      getView: () => ({ canClaim: true, expiresAt, seats: [0, 1, 2, 3].map(seat => ({ seat, occupied: false })), myHand: ['JS'], tokenHash: 'hidden' }),
      claim: async () => ({ ok: false, code: 'TABLE_LOCKED' }),
    });
    const guest = await h.connect('invite');
    const frames = []; guest.socket.on('message', data => frames.push(JSON.parse(data.toString())));
    guest.send({ type: 'GET_LOBBY' });
    const first = await guest.next('LOBBY');
    expect(Object.keys(first.lobby).sort()).toEqual(['canClaim', 'expiresAt', 'seats']);
    h.gateway.publish('test', 'spectator', [{ matchId: 'test', version: 0, seq: 2, timestamp: 1000, eventId: 'unrelated',
      event: { type: 'TABLE_UPDATED', table: h.actor.getView(0).table } }]);
    guest.send({ type: 'GET_LOBBY' }); await guest.next('LOBBY');
    guest.send({ type: 'GET_VIEW' }); await guest.next('ERROR');
    expect(frames.filter(frame => frame.type === 'LOBBY')).toHaveLength(2);
    expect(JSON.stringify(frames)).not.toMatch(/myHand|tokenHash|TABLE_UPDATED/);
  });

  test('fixed chat broadcasts once, resists free text and reconnect rate-limit bypass, and excludes spectator senders', async () => {
    const h = await harness({}, undefined, {});
    const player = await h.connect('seat3');
    const watcher = await h.connect('watch');
    const command = h.command({ type: 'QUICK_CHAT', phraseId: 'GOOD_LUCK' });
    player.send(command);
    const receipt = await player.next('RESULT');
    expect(receipt).toMatchObject({ ok: true });
    const broadcast = await watcher.next('EVENTS');
    expect(broadcast.events.map(entry => entry.event)).toEqual([{ type: 'CHAT_MESSAGE', message: expect.objectContaining({ seat: 3, phraseId: 'GOOD_LUCK' }) }]);
    const sequence = h.actor.getSequence('spectator');
    player.send(command); expect(await player.next('RESULT')).toEqual(receipt);
    expect(h.actor.getSequence('spectator')).toBe(sequence);
    player.send(h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS', text: 'I have JS' }));
    expect(await player.next('ERROR')).toMatchObject({ code: 'INVALID_MESSAGE' });
    watcher.send(h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' }));
    expect(await watcher.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    const replacement = await h.connect('seat3');
    replacement.send(h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' }));
    expect(await replacement.next('RESULT')).toMatchObject({ code: 'CHAT_RATE_LIMITED' });
    h.setTime(3000);
    replacement.send(h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' }));
    expect(await replacement.next('RESULT')).toMatchObject({ ok: true });
    expect(h.actor.getView(3).chat.messages).toHaveLength(2);
    expect(h.errors).toEqual([]);
  });

  test('history is authenticated, bounded and match-scoped without changing state or event cursors', async () => {
    const h = await harness();
    const request = { type: 'GET_HISTORY', requestId: '00000000-0000-4000-8000-000000000099', limit: 10 };
    const guest = await h.connect(); guest.send(request);
    expect(await guest.next('ERROR')).toMatchObject({ code: 'HELLO_REQUIRED' });
    const watcher = await h.connect('watch');
    const count = h.records.length, sequence = h.actor.getSequence('spectator');
    watcher.send(request);
    expect(await watcher.next('HISTORY')).toEqual({ type: 'HISTORY', matchId: 'test', requestId: request.requestId,
      page: { entries: [], total: 0, nextBefore: null, earliestAvailable: null, truncated: false } });
    for (const raw of [{ ...request, limit: 21 }, { ...request, before: 0 }, { ...request, matchId: 'other' }]) {
      watcher.send(raw); expect(await watcher.next('ERROR')).toMatchObject({ code: 'INVALID_MESSAGE' });
    }
    expect(h.records).toHaveLength(count); expect(h.actor.getSequence('spectator')).toBe(sequence);
  });

  test('ready commands are seat-authenticated and no-show sockets close while confirmed players stay', async () => {
    const h = await harness({}, undefined, {}, {});
    const watcher = await h.connect('watch');
    const players = [];
    for (const seat of [0, 1, 2, 3]) players.push(await h.connect(`seat${seat}`));
    expect(h.actor.getView(0)).toMatchObject({ myHand: [], version: 0, table: { phase: 'READY_CHECK' } });
    watcher.send(h.command({ type: 'READY' }, { expectedCheckId: 1 }));
    expect(await watcher.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    players[0].send(h.command({ type: 'READY' }, { expectedCheckId: 1 }));
    expect(await players[0].next('RESULT')).toMatchObject({ ok: true });
    const closed = players.slice(1).map(player => once(player.socket, 'close'));
    h.setTime(16000);
    players[1].send(h.command({ type: 'READY' }, { expectedCheckId: 1 }));
    expect((await Promise.all(closed)).map(event => event[0])).toEqual([1008, 1008, 1008]);
    players[0].send({ type: 'GET_VIEW' });
    expect((await players[0].next('SNAPSHOT')).snapshot).toMatchObject({ myHand: [], table: { phase: 'WAITING' } });
    expect(h.actor.getView(0).seats[0].connected).toBe(true);
    expect(h.errors).toEqual([]);
  });

  test('routes only authenticated views and private traffic, preserving actor idempotency', async () => {
    const h = await harness();
    const bidder = await h.connect('seat3');
    const defender = await h.connect('seat2');
    const spectator = await h.connect('watch');
    for (const [client, viewer] of [[bidder, 3], [defender, 2], [spectator, 'spectator']]) {
      client.send({ type: 'GET_VIEW' });
      expect(await client.next('SNAPSHOT')).toEqual({ type: 'SNAPSHOT', matchId: 'test',
        seq: h.actor.getSequence(viewer), snapshot: h.actor.getView(viewer) });
      client.send({ type: 'RESUME', matchId: 'test', seq: 0 });
      const replay = await client.next('REPLAY');
      const deals = replay.events.filter(event => event.event.type === 'CARDS_DEALT');
      expect(deals).toHaveLength(viewer === 'spectator' ? 0 : 1);
      if (deals.length) expect(deals[0].event.cards).toEqual(h.actor.getView(viewer).myHand);
      expect(replay.events.map(event => event.seq)).toEqual(replay.events.map((_, index) => index + 1));
    }
    const command = h.command();
    bidder.send(command);
    const result = await bidder.next('RESULT');
    expect(result).toMatchObject({ ok: true, version: 2 });
    for (const client of [bidder, defender, spectator]) {
      const events = await client.next('EVENTS');
      expect(events.events.some(event => event.event.type === 'BID_MADE')).toBe(true);
      expect(events.events.some(event => event.event.type === 'LEGAL_ACTIONS')).toBe(client === defender);
    }
    bidder.send(command);
    expect(await bidder.next('RESULT')).toEqual(result);
    expect(h.records).toHaveLength(2);
    expect(h.errors).toEqual([]);
  });

  test('reconnect resumes missed events and replaces the old socket', async () => {
    const h = await harness();
    const original = await h.connect('seat3');
    const seq = h.actor.getSequence(3);
    original.send(h.command()); await original.next('RESULT');
    const closed = once(original.socket, 'close');
    const resumed = await h.connect('seat3');
    expect((await closed)[0]).toBe(1008);
    resumed.send({ type: 'RESUME', matchId: 'test', seq });
    const replay = await resumed.next('REPLAY');
    expect(replay.events[0].seq).toBe(seq + 1);
    expect(replay.seq).toBe(h.actor.getSequence(3));
    resumed.send({ type: 'RESUME', matchId: 'test', seq: replay.seq });
    expect((await resumed.next('REPLAY')).events).toEqual([]);
  });

  test('expired, future and post-recovery cursors receive an authoritative filtered snapshot', async () => {
    const h = await harness({ maxBufferedEvents: 1 });
    const client = await h.connect('seat3');
    for (const seq of [0, 99999]) {
      client.send({ type: 'RESUME', matchId: 'test', seq });
      expect((await client.next('SNAPSHOT')).snapshot).toEqual(h.actor.getView(3));
    }
    h.gateway.unregisterMatch('test');
    h.gateway.registerMatch('test', h.actor);
    const recovered = await h.connect('seat3');
    recovered.send({ type: 'RESUME', matchId: 'test', seq: 0 });
    expect((await recovered.next('SNAPSHOT')).seq).toBe(h.actor.getSequence(3));
  });

  test('rejects pre-auth commands, invalid tokens, incompatible protocols and bad origins', async () => {
    const h = await harness();
    const unauth = await h.connect();
    unauth.send({ type: 'GET_VIEW' });
    expect(await unauth.next('ERROR')).toMatchObject({ code: 'HELLO_REQUIRED' });
    unauth.send({ type: 'HELLO', protocolVersion: 1, token: 'forged' });
    expect(await unauth.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    const old = await h.connect();
    old.send({ type: 'HELLO', protocolVersion: 0, token: 'seat3' });
    expect(await old.next('ERROR')).toMatchObject({ code: 'UPGRADE_REQUIRED' });
    const rejected = new WebSocket(h.url, { origin: 'https://evil.example' });
    expect((await once(rejected, 'error'))[0].message).toContain('403');
    expect(h.records).toHaveLength(1);
  });

  test('rejects spoofed seats, system actions, cross-match access and spectator commands', async () => {
    const h = await harness();
    const player = await h.connect('seat2');
    const spectator = await h.connect('watch');
    for (const command of [h.command({ type: 'TIMEOUT', decisionVersion: 1 }),
      h.command(undefined, { actor: 3 }), h.command(undefined, { seat: 3 })]) {
      player.send(command);
      expect(await player.next('ERROR')).toMatchObject({ code: 'INVALID_MESSAGE' });
    }
    for (const message of [h.command(undefined, { matchId: 'other' }),
      { type: 'RESUME', matchId: 'other', seq: 0 }]) {
      player.send(message);
      expect(await player.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    }
    spectator.send(h.command());
    expect(await spectator.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    player.send(h.command());
    expect(await player.next('RESULT')).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(h.actor.getView(3).version).toBe(1);
  });

  test('rejects stale versions with only the authenticated seat snapshot', async () => {
    const h = await harness();
    const client = await h.connect('seat2');
    client.send(h.command({ type: 'PASS' }, { expectedVersion: 0 }));
    const result = await client.next('RESULT');
    expect(result).toMatchObject({ ok: false, code: 'STALE_STATE', snapshot: { myHand: h.actor.getView(2).myHand } });
  });

  test('bounds match receipts and keeps seat rate limits across reconnects', async () => {
    const h = await harness({ messagesPerWindow: 2, maxCommandsPerMatch: 1 });
    const client = await h.connect('seat3');
    client.send(h.command()); expect((await client.next('RESULT')).ok).toBe(true);
    const resumed = await h.connect('seat3');
    resumed.send(h.command());
    expect(await resumed.next('ERROR')).toMatchObject({ code: 'MATCH_COMMAND_LIMIT' });
    const again = await h.connect('seat3');
    again.send({ type: 'GET_VIEW' });
    expect(await again.next('ERROR')).toMatchObject({ code: 'RATE_LIMITED' });
    expect(h.records).toHaveLength(2);
  });

  test('reports storage failures without leaking server details or publishing uncommitted events', async () => {
    const h = await harness();
    const client = await h.connect('seat3');
    const command = h.command();
    h.actor.stop();
    client.send(command);
    expect(await client.next('ERROR')).toEqual({ type: 'ERROR', code: 'SERVICE_UNAVAILABLE' });
    expect(h.errors).toHaveLength(1);
    expect(client.messages.filter(message => message.type === 'EVENTS')).toEqual([]);
  });

  test('rejects malformed JSON, binary frames and unknown fields without changing the match', async () => {
    const h = await harness();
    const client = await h.connect('seat3');
    for (const raw of ['{', Buffer.from('{}'), JSON.stringify({ type: 'GET_VIEW', viewer: 0 })]) {
      client.socket.send(raw);
      expect(await client.next('ERROR')).toEqual({ type: 'ERROR', code: 'INVALID_MESSAGE' });
    }
    client.send({ type: 'HELLO', protocolVersion: 1, token: 'seat2' });
    expect(await client.next('ERROR')).toMatchObject({ code: 'ALREADY_AUTHENTICATED' });
    client.send({ type: 'GET_VIEW' });
    expect((await client.next('SNAPSHOT')).snapshot.myHand).toEqual(h.actor.getView(3).myHand);
    expect(h.records).toHaveLength(1);
  });

  test('bounds unauthenticated connections and requires HELLO before its deadline', async () => {
    const h = await harness({ maxConnections: 1, helloTimeoutMs: 100 });
    const client = await h.connect();
    const closed = once(client.socket, 'close');
    const excess = new WebSocket(h.url, { origin: 'https://game.example' });
    expect((await once(excess, 'error'))[0].message).toContain('403');
    expect((await closed)[0]).toBe(1008);
    const replacement = await h.connect('seat3');
    replacement.send({ type: 'GET_VIEW' });
    expect((await replacement.next('SNAPSHOT')).snapshot.version).toBe(1);
  });

  test('terminates sockets missing two heartbeats without stopping the actor', async () => {
    const h = await harness({ heartbeatMs: 20 }, undefined, {});
    const observer = await h.connect('watch');
    const client = await h.connect('seat3', { autoPong: false });
    expect((await once(client.socket, 'close'))[0]).toBe(1006);
    for (;;) {
      const delivery = await observer.next('EVENTS');
      if (delivery.events.some(event => event.event.type === 'PLAYER_DISCONNECTED')) break;
    }
    expect(h.actor.getView(3).version).toBe(1);
    expect(h.actor.getView(3).seats[3]).toMatchObject({ connected: false, controller: 'human' });
  });

  test('tracks real connections without treating session replacement as a disconnect', async () => {
    const h = await harness({}, undefined, {});
    const original = await h.connect('seat3');
    expect(h.actor.getView(3).seats[3].connected).toBe(true);
    const count = h.records.length;
    const closed = once(original.socket, 'close');
    const replacement = await h.connect('seat3');
    await closed;
    replacement.send({ type: 'GET_VIEW' });
    const snapshot = await replacement.next('SNAPSHOT');
    expect(snapshot.snapshot.seats[3]).toMatchObject({ connected: true, controller: 'human' });
    expect(h.records).toHaveLength(count);
    const observer = await h.connect('watch');
    replacement.socket.close();
    const disconnected = await observer.next('EVENTS');
    expect(disconnected.events.map(event => event.event)).toEqual([{ type: 'PLAYER_DISCONNECTED', seat: 3 }]);
    expect(h.records.at(-1).lifecycleOperation).toEqual({ type: 'CONNECTION', seat: 3, connected: false });
    expect(h.errors).toEqual([]);
  });

  test('reports the timestamp when the final player disconnects', async () => {
    const h = await harness({}, undefined, {});
    const firstTransport = once(h.server, 'connection');
    const first = await h.connect('seat3');
    const [firstServerSocket] = await firstTransport;
    const secondTransport = once(h.server, 'connection');
    const second = await h.connect('seat2');
    const [secondServerSocket] = await secondTransport;

    const firstClosed = once(firstServerSocket, 'close');
    first.socket.close();
    await firstClosed;
    expect(h.lastPlayerDisconnects).toEqual([]);

    const secondClosed = once(secondServerSocket, 'close');
    second.send({ type: 'LEAVE_TABLE' });
    expect(await second.next('LEFT_TABLE')).toMatchObject({ type: 'LEFT_TABLE', matchId: 'test' });
    await secondClosed;
    expect(h.lastPlayerDisconnects).toHaveLength(1);
    expect(h.lastPlayerDisconnects[0]).toEqual(expect.any(Number));
  });

  test('explicit leave hands control to a bot and authenticated reconnect waits for a boundary', async () => {
    const h = await harness({}, undefined, {});
    const player = await h.connect('seat3');
    const watcher = await h.connect('watch');
    watcher.send({ type: 'LEAVE_TABLE' });
    expect(await watcher.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    player.send({ type: 'LEAVE_TABLE' });
    expect(await player.next('LEFT_TABLE')).toEqual({ type: 'LEFT_TABLE', matchId: 'test' });
    expect(h.actor.getView(3).seats[3]).toMatchObject({ connected: false, controller: 'bot' });
    const returned = await h.connect('seat3');
    returned.send({ type: 'GET_VIEW' });
    const snapshot = await returned.next('SNAPSHOT');
    expect(snapshot.snapshot.seats[3]).toMatchObject({ connected: true, controller: 'bot', reclaimPending: true });
    returned.send(h.command());
    expect(await returned.next('RESULT')).toMatchObject({ code: 'SEAT_NOT_CONTROLLED' });
    expect(h.errors).toEqual([]);
  });

  test('unregistering an active match records a disconnect before detaching routing', async () => {
    const h = await harness({}, undefined, {});
    const player = await h.connect('seat3');
    const closed = once(player.socket, 'close');
    h.gateway.unregisterMatch('test');
    expect((await closed)[0]).toBe(1001);
    await h.actor.dispatch(0, {});
    expect(h.actor.getView(3).seats[3]).toMatchObject({ connected: false, controller: 'human' });
    expect(h.records.at(-1).lifecycleOperation).toEqual({ type: 'CONNECTION', seat: 3, connected: false });
    expect(h.errors).toEqual([]);
  });

  test('disconnects slow consumers and rejects oversized inbound frames', async () => {
    const h = await harness({ maxBufferedBytes: 256 });
    const client = await h.connect('seat3');
    const slowClosed = once(client.socket, 'close');
    client.send({ type: 'GET_VIEW' });
    expect((await slowClosed)[0]).toBe(1013);
    const oversized = await h.connect('seat2');
    const largeClosed = once(oversized.socket, 'close');
    oversized.socket.send('x'.repeat(17 * 1024));
    expect([1006, 1009]).toContain((await largeClosed)[0]);
    expect(h.records).toHaveLength(1);
  });

  test('bounds queued messages while authentication is pending and sanitizes provider failures', async () => {
    let resolveAuth;
    let started;
    const authenticating = new Promise(resolve => { started = resolve; });
    const h = await harness({ maxPendingMessages: 1 }, () => new Promise(resolve => { resolveAuth = resolve; started(); }));
    const client = await h.connect();
    const closed = once(client.socket, 'close');
    client.send({ type: 'HELLO', protocolVersion: 1, token: 'seat3' });
    await authenticating;
    client.send({ type: 'GET_VIEW' });
    expect(await client.next('ERROR')).toMatchObject({ code: 'RATE_LIMITED' });
    expect((await closed)[0]).toBe(1008);
    resolveAuth({ matchId: 'test', viewer: 3 });

    const failed = await harness({}, async () => { throw new Error('secret provider detail'); });
    const denied = await failed.connect();
    denied.send({ type: 'HELLO', protocolVersion: 1, token: 'seat3' });
    expect(await denied.next('ERROR')).toEqual({ type: 'ERROR', code: 'SERVICE_UNAVAILABLE' });
    expect(failed.errors).toHaveLength(1);
  });
});
