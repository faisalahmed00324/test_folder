const { describe, test, expect } = require('@jest/globals');
const { createTableClient } = require('../../src/client/table-client.ts');
const { parseServerMessage, snapshotSchema, validEndpoint } = require('../../src/client/protocol.ts');
const { clientSnapshot, completedSummary } = require('../support/client-fixture.cjs');

function harness() {
  const sockets = [], scheduled = [], updates = [];
  let id = 0;
  const client = createTableClient({
    socket: url => {
      const socket = { url, readyState: 1, sent: [], close() { this.readyState = 3; },
        send(data) { this.sent.push(JSON.parse(data)); } };
      sockets.push(socket); return socket;
    },
    schedule: (delay, callback) => { const task = { delay, callback, active: true }; scheduled.push(task); return () => { task.active = false; }; },
    commandId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`, changed: state => updates.push(state),
    seatToken: () => 'S'.repeat(43),
  });
  const receive = (message, socket = sockets.at(-1)) => socket.onmessage({ data: JSON.stringify(message) });
  const welcome = viewer => receive({ type: 'WELCOME', protocolVersion: 1, matchId: 'table', viewer });
  const snapshot = (view = clientSnapshot(), seq = 5) => receive({ type: 'SNAPSHOT', matchId: 'table', seq, snapshot: view });
  function connect(viewer = 3) {
    client.connect('ws://127.0.0.1:8766/29-card/ws', 'private-token');
    sockets.at(-1).onopen(); welcome(viewer); snapshot(clientSnapshot(viewer));
  }
  return { client, sockets, scheduled, updates, receive, welcome, snapshot, connect, state: () => updates.at(-1) };
}

describe('browser protocol boundary', () => {
  test('accepts actual projected engine views and strips unused fields', () => {
    const parsed = snapshotSchema.parse({ ...clientSnapshot(), serverSecret: 'not-rendered' });
    expect(parsed.serverSecret).toBeUndefined();
    expect(parsed.myHand).toEqual(clientSnapshot().myHand);
    expect(snapshotSchema.safeParse({ ...clientSnapshot(), myHand: ['not-a-card'] }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...clientSnapshot(), legalActions: [{ type: 'SET_BOT', seat: 3, isBot: true }] }).success).toBe(false);
    for (const raw of ['{', '{}', 'x'.repeat(256 * 1024 + 1), {}, JSON.stringify({ type: 'WELCOME', protocolVersion: 2 })]) {
      expect(parseServerMessage(raw)).toBeNull();
    }
  });
  test('rejects plaintext remote endpoints and credentials/query tokens in addresses', () => {
    for (const url of ['wss://cards.example/29-card/ws', 'ws://localhost:1234/29-card/ws']) expect(validEndpoint(url)).toBe(true);
    for (const url of ['http://localhost/29-card/ws', 'ws://cards.example/29-card/ws', 'wss://user:pass@cards.example/29-card/ws',
      'wss://cards.example/29-card/ws?token=secret', 'wss://cards.example/other', 'nope']) expect(validEndpoint(url)).toBe(false);
  });
});

describe('framework-independent table connection', () => {
  test('guests see seating only, must save a separate token before claiming, then reconnect as their assigned seat', () => {
    const h = harness(); h.client.connect('ws://127.0.0.1:8766/29-card/ws', 'invite'); h.sockets[0].onopen(); h.welcome('guest');
    const lobby = { canClaim: true, expiresAt: 10000, seats: [0, 1, 2, 3].map(seat => ({ seat, occupied: false })) };
    h.receive({ type: 'LOBBY', matchId: 'table', lobby });
    expect(h.state()).toMatchObject({ status: 'seating', snapshot: null });
    h.client.play({ type: 'BID', amount: 16 }); h.client.loadHistory();
    h.client.prepareSeat(0);
    expect(h.state()).toMatchObject({ selectedSeat: 0, seatToken: 'S'.repeat(43), seatingPending: false });
    expect(h.sockets[0].sent.filter(message => message.type === 'TAKE_SEAT')).toEqual([]);
    h.client.confirmSeat();
    const claim = h.sockets[0].sent.at(-1);
    expect(claim).toMatchObject({ type: 'TAKE_SEAT', seat: 0, token: 'S'.repeat(43) });
    h.receive({ type: 'EVENTS', matchId: 'table', events: [] });
    expect(h.state().snapshot).toBeNull();
    h.receive({ type: 'SEAT_RESULT', matchId: 'table', requestId: claim.requestId, result: { ok: true, seat: 0, expiresAt: 10000 } });
    h.snapshot(clientSnapshot(0));
    expect(h.state()).toMatchObject({ status: 'connected', lobby: null, seatToken: null, selectedSeat: null, snapshot: { viewer: 0 } });
    h.sockets[0].onclose({ code: 1006 });
    h.scheduled.find(task => task.active && task.delay === 1000).callback(); h.sockets.at(-1).onopen();
    expect(h.sockets.at(-1).sent[0]).toEqual({ type: 'HELLO', protocolVersion: 1, token: 'S'.repeat(43) });
    h.client.disconnect();
  });

  test('lost claim acknowledgements retry the same private token/nonce, including an already occupied slot', () => {
    const h = harness(); h.client.connect('ws://127.0.0.1:8766/29-card/ws', 'invite'); h.welcome('guest');
    const lobby = { canClaim: true, expiresAt: 10000, seats: [0, 1, 2, 3].map(seat => ({ seat, occupied: false })) };
    h.receive({ type: 'LOBBY', matchId: 'table', lobby }); h.client.prepareSeat(1); h.client.confirmSeat();
    const claim = h.sockets[0].sent.at(-1);
    h.sockets[0].onclose({ code: 1006 });
    h.scheduled.find(task => task.active && task.delay === 1000).callback(); h.welcome('guest');
    h.receive({ type: 'LOBBY', matchId: 'table', lobby: { ...lobby, seats: lobby.seats.map(slot => ({ ...slot, occupied: slot.seat === 1 })) } });
    expect(h.sockets.at(-1).sent.at(-1)).toEqual(claim);
    h.receive({ type: 'SEAT_RESULT', matchId: 'table', requestId: claim.requestId, result: { ok: true, seat: 2, expiresAt: 10000 } });
    expect(h.state()).toMatchObject({ status: 'error', error: 'SESSION_CHANGED', seatToken: null, snapshot: null });
  });

  test('seat rejection stays in the lobby and clears the unused credential', () => {
    const h = harness(); h.client.connect('ws://127.0.0.1:8766/29-card/ws', 'invite'); h.welcome('guest');
    const lobby = { canClaim: true, expiresAt: 10000, seats: [0, 1, 2, 3].map(seat => ({ seat, occupied: false })) };
    h.receive({ type: 'LOBBY', matchId: 'table', lobby }); h.client.prepareSeat(1); h.client.confirmSeat();
    const claim = h.sockets[0].sent.at(-1);
    h.receive({ type: 'SEAT_RESULT', matchId: 'table', requestId: claim.requestId, result: { ok: false, code: 'SEAT_TAKEN' } });
    expect(h.state()).toMatchObject({ status: 'seating', seatingPending: false, seatError: 'SEAT_TAKEN', seatToken: null });
    h.client.disconnect(); expect(h.state().lobby).toBeNull();
  });

  test('authenticates, locks duplicate/illegal actions and uses server version/UUID without seat authority', () => {
    const h = harness(); h.connect();
    expect(h.state().status).toBe('connected');
    const socket = h.sockets[0];
    expect(socket.sent[0]).toEqual({ type: 'HELLO', protocolVersion: 1, token: 'private-token' });
    h.client.play({ type: 'PLAY_CARD', cardId: 'JS' });
    h.client.play({ type: 'BID', amount: 16 }); h.client.play({ type: 'BID', amount: 16 });
    const commands = socket.sent.filter(message => message.type === 'COMMAND');
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toEqual({ commandId: '00000000-0000-4000-8000-000000000001',
      matchId: 'table', expectedVersion: 1, action: { type: 'BID', amount: 16 } });
    h.receive({ type: 'RESULT', commandId: commands[0].command.commandId, ok: true, version: 2 });
    expect(h.state()).toMatchObject({ status: 'syncing', pending: false });
    h.snapshot({ ...clientSnapshot(), version: 2 }, 6);
    expect(h.state().status).toBe('connected');
    expect(JSON.stringify(h.updates)).not.toContain('private-token');
  });

  test('invalidations and sequence gaps coalesce view requests and disable stale moves', () => {
    const h = harness(); h.connect();
    const event = seq => ({ matchId: 'table', seq, version: 2, timestamp: 1000, eventId: `e${seq}`, event: { type: 'TURN' } });
    h.receive({ type: 'EVENTS', matchId: 'table', events: [event(6)] });
    h.receive({ type: 'EVENTS', matchId: 'table', events: [event(8)] });
    h.client.play({ type: 'BID', amount: 16 });
    expect(h.sockets[0].sent.filter(message => message.type === 'COMMAND')).toHaveLength(0);
    expect(h.sockets[0].sent.filter(message => message.type === 'GET_VIEW')).toHaveLength(2);
    h.snapshot({ ...clientSnapshot(), version: 2 }, 8);
    expect(h.state().status).toBe('syncing');
    h.snapshot({ ...clientSnapshot(), version: 2 }, 8);
    expect(h.state().status).toBe('connected');
    h.receive({ type: 'EVENTS', matchId: 'table', events: [event(6)] });
    expect(h.state().status).toBe('connected');
  });

  test('reconnect hides cards and retries an uncertain move with its original id and version', () => {
    const h = harness(); h.connect();
    h.client.play({ type: 'BID', amount: 16 });
    const command = h.sockets[0].sent.at(-1);
    h.sockets[0].onclose({ code: 1006 });
    expect(h.state()).toMatchObject({ status: 'reconnecting', snapshot: null, pending: true });
    h.scheduled.find(task => task.active && task.delay === 1000).callback();
    const next = h.sockets.at(-1); next.onopen();
    // Lifecycle events may arrive before WELCOME on a newly authenticated socket.
    h.receive({ type: 'EVENTS', matchId: 'table', events: [] });
    expect(next.sent).toHaveLength(1);
    h.welcome(3); h.snapshot({ ...clientSnapshot(), version: 2 }, 8);
    expect(next.sent.at(-1)).toEqual(command);
    h.receive({ type: 'RESULT', commandId: command.command.commandId, ok: true, version: 2 });
    h.snapshot({ ...clientSnapshot(), version: 2 }, 8);
    expect(h.state()).toMatchObject({ status: 'connected', pending: false, error: null });
  });

  test('spectators and returning bot-controlled humans cannot dispatch moves', () => {
    const h = harness(); h.connect('spectator');
    h.client.play({ type: 'BID', amount: 16 }); h.client.leave();
    expect(h.sockets[0].sent).toHaveLength(2);
    h.client.disconnect(); h.connect();
    const view = clientSnapshot(); view.seats[3].controller = 'bot';
    h.snapshot(view); h.client.play({ type: 'BID', amount: 16 });
    expect(h.state().pending).toBe(false);
  });

  test('authentication errors, malformed data and changed identities fail closed and erase private view', () => {
    const h = harness();
    h.client.connect('ws://127.0.0.1:8766/29-card/ws', 'token');
    h.receive({ type: 'ERROR', code: 'UNAUTHORIZED' });
    expect(h.state()).toMatchObject({ status: 'error', snapshot: null, error: 'UNAUTHORIZED' });
    h.connect(); h.snapshot(clientSnapshot(2));
    expect(h.state().error).toBe('SESSION_CHANGED');
    h.connect(); h.sockets.at(-1).onmessage({ data: '{' });
    expect(h.state().error).toBe('INVALID_SERVER_MESSAGE');
    h.connect(); h.sockets.at(-1).onclose({ code: 1008 });
    expect(h.state()).toMatchObject({ status: 'error', snapshot: null, error: 'SESSION_CLOSED' });
    h.connect(); h.sockets.at(-1).onclose({ code: 1008, reason: 'Ready check expired' });
    expect(h.state()).toMatchObject({ status: 'error', snapshot: null, error: 'READY_CHECK_EXPIRED' });
  });

  test('disconnect cancels retries; leave acknowledgements clear credentials and private cards', () => {
    const h = harness(); h.connect(); h.client.leave();
    expect(h.sockets[0].sent.at(-1)).toEqual({ type: 'LEAVE_TABLE' });
    h.receive({ type: 'LEFT_TABLE', matchId: 'table' });
    expect(h.state()).toMatchObject({ status: 'left', snapshot: null });
    h.connect(); h.sockets.at(-1).onclose({ code: 1006 });
    h.client.disconnect();
    expect(h.scheduled.some(task => task.active)).toBe(false);
    expect(h.state().status).toBe('disconnected');
  });

  test('connect and snapshot waits expire without hanging or retaining private cards', () => {
    const h = harness(); h.client.connect('ws://127.0.0.1:8766/29-card/ws', 'token');
    h.scheduled.find(task => task.active).callback();
    expect(h.state().error).toBe('CONNECTION_TIMEOUT');
    h.client.connect('ws://127.0.0.1:8766/29-card/ws', 'token'); h.welcome(3);
    h.scheduled.find(task => task.active).callback();
    expect(h.state()).toMatchObject({ error: 'SYNC_TIMEOUT', snapshot: null });
    h.client.connect('ws://evil.example/29-card/ws', 'token');
    expect(h.state().error).toBe('INVALID_CONNECTION');
  });

  test('preserves the live hand summary across an automatic fresh deal without reducing game events', () => {
    const h = harness(); h.connect();
    h.receive({ type: 'EVENTS', matchId: 'table', events: [{ matchId: 'table', seq: 6, version: 40,
      timestamp: 10000, eventId: 'scored', event: { type: 'HAND_SCORED', summary: completedSummary() } }] });
    h.snapshot({ ...clientSnapshot(), version: 41, handNumber: 2, dealNumber: 2 }, 7);
    expect(h.state().lastSummary).toMatchObject({ tricks: expect.any(Array), declaringTeam: expect.any(String) });
    expect(h.state().lastSummary.tricks).toHaveLength(8);
    h.client.disconnect();
    expect(h.state().lastSummary).toBeNull();
  });

  test('ignores stale handlers and fails closed on a sequence rollback across reconnect', () => {
    const h = harness(); h.connect();
    const old = h.sockets[0].onmessage;
    h.sockets[0].onclose({ code: 1006 });
    h.scheduled.find(task => task.active && task.delay === 1000).callback();
    old({ data: '{' });
    expect(h.state().error).toBeNull();
    h.welcome(3); h.snapshot(clientSnapshot(), 4);
    expect(h.state().error).toBe('OUT_OF_ORDER_SNAPSHOT');
  });

  test('surfaces command rejection and never waits indefinitely for a missing move receipt', () => {
    const h = harness(); h.connect();
    h.client.play({ type: 'BID', amount: 16 });
    h.receive({ type: 'RESULT', commandId: '00000000-0000-4000-8000-000000000001',
      ok: false, version: 1, code: 'STALE_STATE' });
    expect(h.state()).toMatchObject({ pending: false, error: 'STALE_STATE', status: 'syncing' });
    h.snapshot(); h.client.play({ type: 'BID', amount: 16 });
    h.scheduled.find(task => task.active).callback();
    expect(h.state()).toMatchObject({ error: 'MOVE_CONFIRMATION_TIMEOUT', snapshot: null, pending: false });
  });

  test('table consent carries the current check identity and a new match clears the prior summary', () => {
    const h = harness(); h.connect();
    const table = { phase: 'READY_CHECK', checkId: 7, matchNumber: 1, ready: [false, false, false, false],
      votes: [null, null, null, null], deadline: 16000 };
    h.snapshot({ ...clientSnapshot(), table, legalActions: [{ type: 'READY' }] });
    h.client.play({ type: 'READY' });
    const command = h.sockets[0].sent.at(-1).command;
    expect(command).toMatchObject({ expectedVersion: 1, expectedCheckId: 7, action: { type: 'READY' } });
    h.receive({ type: 'RESULT', commandId: command.commandId, ok: true, version: 1 });
    h.snapshot({ ...clientSnapshot(), table: { ...table, phase: 'REMATCH' }, summary: completedSummary(),
      status: 'FINISHED', legalActions: [{ type: 'REMATCH_VOTE', accept: true }] });
    expect(h.state().lastSummary).not.toBeNull();
    h.snapshot({ ...clientSnapshot(), version: 20, table: { ...table, phase: 'PLAYING', matchNumber: 2, deadline: null } }, 9);
    expect(h.state().lastSummary).toBeNull();
  });

  test('chat uses an authenticated action, not a free-text payload or a fabricated game legal move', () => {
    const h = harness(); h.connect();
    h.client.play({ type: 'QUICK_CHAT', phraseId: 'GOOD_LUCK' });
    expect(h.state().pending).toBe(false);
    h.snapshot({ ...clientSnapshot(), chat: { canSend: true, remainingMs: 0, messages: [] } });
    h.client.play({ type: 'QUICK_CHAT', phraseId: 'GOOD_LUCK' });
    expect(h.sockets[0].sent.at(-1)).toMatchObject({ type: 'COMMAND', command: { action: { type: 'QUICK_CHAT', phraseId: 'GOOD_LUCK' }, expectedVersion: 1 } });
    expect(h.state().pending).toBe(true);
  });

  test('chat-only traffic updates the transcript without spending whole-game refresh quota', () => {
    const h = harness(); h.connect();
    h.snapshot({ ...clientSnapshot(), chat: { canSend: true, remainingMs: 0, messages: [], cooldownStartedAt: null } });
    const reads = () => h.sockets[0].sent.filter(message => message.type === 'GET_VIEW').length;
    const before = reads();
    for (let i = 1; i <= 2; i++) {
      h.client.play({ type: 'QUICK_CHAT', phraseId: 'THANKS' });
      const command = h.sockets[0].sent.at(-1).command;
      h.receive({ type: 'EVENTS', matchId: 'table', events: [{ matchId: 'table', seq: 5 + i, version: 1,
        eventId: `chat-event-${i}`, timestamp: i * 2000,
        event: { type: 'CHAT_MESSAGE', message: { id: `table:chat:${i}`, seat: 3, phraseId: 'THANKS', timestamp: i * 2000 } } }] });
      h.receive({ type: 'RESULT', commandId: command.commandId, ok: true, version: 1, chatMessageId: `table:chat:${i}` });
      expect(h.state()).toMatchObject({ status: 'connected', pending: false,
        snapshot: { chat: { remainingMs: 2000, cooldownStartedAt: i * 2000 } } });
    }
    expect(reads()).toBe(before);
    expect(h.state().snapshot.chat.messages).toHaveLength(2);
    h.receive({ type: 'EVENTS', matchId: 'table', events: [{ matchId: 'table', seq: 8, version: 2,
      eventId: 'game-turn', timestamp: 5000, event: { type: 'TURN' } }] });
    expect(h.state().status).toBe('syncing'); expect(reads()).toBe(before + 1);
  });

  test('history requests correlate replies, use exclusive cursors, and do not lock game controls', () => {
    const h = harness(); h.connect();
    h.client.loadHistory();
    const first = h.sockets[0].sent.at(-1);
    expect(first).toMatchObject({ type: 'GET_HISTORY', limit: 10 });
    expect(h.state()).toMatchObject({ status: 'connected', pending: false, historyPending: true });
    h.client.loadHistory();
    expect(h.sockets[0].sent.at(-1)).toEqual(first);
    const page = { entries: [], total: 0, truncated: false, earliestAvailable: null, nextBefore: null };
    h.receive({ type: 'HISTORY', matchId: 'table', requestId: '00000000-0000-4000-8000-000000000099', page });
    expect(h.state().historyPending).toBe(true);
    h.receive({ type: 'HISTORY', matchId: 'table', requestId: first.requestId, page });
    expect(h.state()).toMatchObject({ historyPending: false, history: page });
    h.client.loadHistory(12);
    expect(h.sockets[0].sent.at(-1)).toMatchObject({ type: 'GET_HISTORY', before: 12 });
    h.scheduled.find(task => task.active).callback();
    expect(h.state()).toMatchObject({ status: 'connected', historyPending: false, historyError: 'HISTORY_TIMEOUT' });
    h.client.disconnect();
    expect(h.state()).toMatchObject({ history: null, historyError: null, snapshot: null });
  });
});
