import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { commandSchema, type createMatchActor, type RuntimeEvent } from '../application/match-actor';
import type { Viewer } from '../domain/engine';
import { seatSchema } from '../domain/seats';
import { historyRequestSchema } from '../protocol/history';
import { seatClaimSchema, seatClaimResultSchema, lobbyViewSchema, type LobbyView, type SeatClaim } from '../protocol/invitations';

const matchIdSchema = z.string().min(1).max(128);
const sessionSchema = z.strictObject({ matchId: matchIdSchema, viewer: z.union([seatSchema, z.literal('spectator'), z.literal('guest')]),
  expiresAt: z.number().int().positive().safe().optional() });
const helloSchema = z.strictObject({ type: z.literal('HELLO'), protocolVersion: z.number().int().nonnegative(),
  token: z.string().min(1).max(4096) });
const messageSchema = z.union([
  helloSchema,
  z.strictObject({ type: z.literal('GET_VIEW') }),
  z.strictObject({ type: z.literal('RESUME'), matchId: matchIdSchema, seq: z.number().int().nonnegative().safe() }),
  z.strictObject({ type: z.literal('COMMAND'), command: commandSchema }),
  z.strictObject({ type: z.literal('LEAVE_TABLE') }),
  historyRequestSchema,
  z.strictObject({ type: z.literal('GET_LOBBY') }),
  seatClaimSchema.extend({ type: z.literal('TAKE_SEAT') }),
]);
const limitsSchema = z.strictObject({
  maxConnections: z.number().int().positive().default(100),
  maxBufferedEvents: z.number().int().positive().default(512),
  maxPendingMessages: z.number().int().positive().default(16),
  maxBufferedBytes: z.number().int().positive().default(256 * 1024),
  messagesPerWindow: z.number().int().positive().default(30),
  rateWindowMs: z.number().int().positive().default(10_000),
  maxCommandsPerMatch: z.number().int().positive().default(10_000),
  helloTimeoutMs: z.number().int().positive().default(5000),
  heartbeatMs: z.number().int().positive().default(10_000),
});
type Actor = Pick<ReturnType<typeof createMatchActor>, 'dispatch' | 'getView' | 'getSequence' | 'getHistory' | 'setConnected' | 'leave'>;
type Session = z.infer<typeof sessionSchema>;
type Rate = { since: number; count: number };
type Connection = { socket: WebSocket; session?: Session; pending: number; missed: number; rate: Rate;
  expiryTimer?: ReturnType<typeof setTimeout>; lobbyFingerprint?: string };
type Table = { actor: Actor; buffers: Map<Viewer, RuntimeEvent[]>; rates: Map<Viewer, Rate>; commands: number };

// Attach only to a private Node host. TLS and identity/token issuance belong to
// the host; authentication must verify membership, not decode client seat claims.
export function createWebSocketGateway(options: {
  server: Server;
  allowedOrigins: readonly string[];
  authenticate(token: string, request: IncomingMessage): Promise<unknown>;
  onError(error: unknown): void;
  lobby?: { getView(matchId: string): LobbyView; claim(matchId: string, request: SeatClaim): Promise<unknown> };
  limits?: z.input<typeof limitsSchema>;
}) {
  const origins = new Set(z.array(z.url()).min(1).parse(options.allowedOrigins));
  const limits = limitsSchema.parse(options.limits ?? {});
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const tables = new Map<string, Table>();
  const connections = new Set<Connection>();
  let closed = false;

  function disconnect(connection: Connection) {
    const session = connection.session;
    connection.session = undefined;
    clearTimeout(connection.expiryTimer);
    if (!session || session.viewer === 'spectator' || session.viewer === 'guest' || closed) return;
    const table = tables.get(session.matchId);
    if (table) void table.actor.setConnected(session.viewer, false).catch(options.onError);
  }
  function send(connection: Connection, message: unknown) {
    const { socket } = connection;
    if (socket.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(message);
    if (socket.bufferedAmount + Buffer.byteLength(data) > limits.maxBufferedBytes) {
      socket.close(1013, 'Slow consumer');
      return;
    }
    socket.send(data, error => { if (error) socket.terminate(); });
  }
  function error(connection: Connection, code: string) { send(connection, { type: 'ERROR', code }); }
  function allow(rate: Rate) {
    const now = Date.now();
    if (now - rate.since >= limits.rateWindowMs) { rate.since = now; rate.count = 0; }
    return ++rate.count <= limits.messagesPerWindow;
  }
  function snapshot(connection: Connection, table: Table, viewer: Viewer) {
    send(connection, { type: 'SNAPSHOT', matchId: connection.session!.matchId,
      seq: table.actor.getSequence(viewer), snapshot: table.actor.getView(viewer) });
  }
  function lobbyView(connection: Connection, matchId: string, force = true) {
    if (!options.lobby) throw new Error('Invite lobby unavailable');
    const parsed = lobbyViewSchema.safeParse(options.lobby.getView(matchId));
    if (!parsed.success) throw new Error('Invalid lobby projection');
    const fingerprint = JSON.stringify(parsed.data);
    if (force || connection.lobbyFingerprint !== fingerprint) send(connection, { type: 'LOBBY', matchId, lobby: parsed.data });
    connection.lobbyFingerprint = fingerprint;
  }
  function broadcastLobby(matchId: string) {
    for (const connection of connections) {
      if (connection.session?.matchId === matchId && connection.session.viewer === 'guest') lobbyView(connection, matchId, false);
    }
  }
  function installExpiry(connection: Connection, session: Session) {
    clearTimeout(connection.expiryTimer);
    if (session.expiresAt === undefined) return;
    const expire = () => {
      if (connection.session !== session) return;
      const remaining = session.expiresAt! - Date.now();
      if (remaining > 0) connection.expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      else { disconnect(connection); connection.socket.close(1008, 'Session expired'); }
    };
    expire();
  }
  async function activate(connection: Connection, session: Session) {
    if (session.viewer === 'guest') throw new Error('Expected a bound seat session');
    const table = tables.get(session.matchId);
    if (!table) throw new Error('Match unavailable');
    table.actor.getView(session.viewer);
    for (const previous of connections) {
      if (previous !== connection && previous.session?.matchId === session.matchId && previous.session.viewer === session.viewer) {
        previous.session = undefined; clearTimeout(previous.expiryTimer);
        previous.socket.close(1008, 'Session replaced');
      }
    }
    connection.session = session;
    if (session.viewer !== 'spectator') await table.actor.setConnected(session.viewer, true);
    if (connection.socket.readyState !== WebSocket.OPEN || connection.session !== session) return false;
    installExpiry(connection, session); return connection.session === session;
  }
  async function receive(connection: Connection, raw: unknown, request: IncomingMessage) {
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) { error(connection, 'INVALID_MESSAGE'); return; }
    const message = parsed.data;
    if (!connection.session) {
      if (message.type !== 'HELLO') { error(connection, 'HELLO_REQUIRED'); return; }
      if (message.protocolVersion !== 1) {
        error(connection, 'UPGRADE_REQUIRED'); connection.socket.close(1008, 'Unsupported protocol'); return;
      }
      const session = sessionSchema.safeParse(await options.authenticate(message.token, request));
      if (connection.socket.readyState !== WebSocket.OPEN) return;
      if (!session.success || !tables.has(session.data.matchId) || (session.data.viewer === 'guest' && !options.lobby) ||
          (session.data.expiresAt !== undefined && session.data.expiresAt <= Date.now())) {
        error(connection, 'UNAUTHORIZED'); connection.socket.close(1008, 'Unauthorized'); return;
      }
      if (session.data.viewer === 'guest') { connection.session = session.data; installExpiry(connection, session.data); }
      else if (!await activate(connection, session.data)) return;
      send(connection, { type: 'WELCOME', protocolVersion: 1, matchId: session.data.matchId, viewer: session.data.viewer });
      return;
    }
    const { matchId, viewer } = connection.session;
    if (connection.session.expiresAt !== undefined && connection.session.expiresAt <= Date.now()) {
      disconnect(connection);
      error(connection, 'UNAUTHORIZED'); connection.socket.close(1008, 'Session expired'); return;
    }
    const table = tables.get(matchId);
    if (!table) { error(connection, 'MATCH_UNAVAILABLE'); return; }
    if (viewer === 'guest') {
      if (message.type === 'GET_LOBBY') { lobbyView(connection, matchId); return; }
      if (message.type === 'TAKE_SEAT' && options.lobby) {
        const previous = connection.session;
        const claimed = seatClaimResultSchema.safeParse(await options.lobby.claim(matchId,
          { requestId: message.requestId, seat: message.seat, token: message.token }));
        if (!claimed.success) throw new Error('Invalid seat-claim result');
        if (claimed.data.ok) broadcastLobby(matchId);
        if (connection.socket.readyState !== WebSocket.OPEN || connection.session !== previous) return;
        if (!claimed.data.ok) {
          send(connection, { type: 'SEAT_RESULT', matchId, requestId: message.requestId, result: claimed.data }); return;
        }
        if (claimed.data.expiresAt <= Date.now()) { disconnect(connection); connection.socket.close(1008, 'Session expired'); return; }
        if (await activate(connection, { matchId, viewer: claimed.data.seat, expiresAt: claimed.data.expiresAt })) {
          send(connection, { type: 'SEAT_RESULT', matchId, requestId: message.requestId, result: claimed.data });
        }
        broadcastLobby(matchId); return;
      }
      error(connection, 'UNAUTHORIZED'); return;
    }
    const rate = table.rates.get(viewer) ?? { since: Date.now(), count: 0 };
    table.rates.set(viewer, rate);
    if (!allow(rate)) { error(connection, 'RATE_LIMITED'); return; }
    switch (message.type) {
      case 'HELLO': error(connection, 'ALREADY_AUTHENTICATED'); return;
      case 'GET_VIEW': snapshot(connection, table, viewer); return;
      case 'GET_LOBBY': case 'TAKE_SEAT': error(connection, 'UNAUTHORIZED'); return;
      case 'GET_HISTORY':
        send(connection, { type: 'HISTORY', matchId, requestId: message.requestId,
          page: table.actor.getHistory(viewer, { before: message.before, limit: message.limit }) });
        return;
      case 'LEAVE_TABLE':
        if (viewer === 'spectator') { error(connection, 'UNAUTHORIZED'); return; }
        await table.actor.leave(viewer);
        connection.session = undefined;
        clearTimeout(connection.expiryTimer);
        send(connection, { type: 'LEFT_TABLE', matchId });
        connection.socket.close(1000, 'Left table');
        return;
      case 'RESUME': {
        if (message.matchId !== matchId) { error(connection, 'UNAUTHORIZED'); return; }
        const latest = table.actor.getSequence(viewer);
        const buffer = table.buffers.get(viewer) ?? [];
        const first = buffer[0]?.seq ?? latest + 1;
        if (message.seq > latest || message.seq < first - 1) { snapshot(connection, table, viewer); return; }
        send(connection, { type: 'REPLAY', matchId, seq: latest, events: buffer.filter(event => event.seq > message.seq) });
        return;
      }
      case 'COMMAND': {
        if (viewer === 'spectator' || message.command.matchId !== matchId) { error(connection, 'UNAUTHORIZED'); return; }
        if (table.commands >= limits.maxCommandsPerMatch) { error(connection, 'MATCH_COMMAND_LIMIT'); return; }
        table.commands++;
        const response = await table.actor.dispatch(viewer, message.command);
        send(connection, { type: 'RESULT', ...response });
      }
    }
  }
  wss.on('connection', (socket, request) => {
    const connection: Connection = { socket, pending: 0, missed: 0, rate: { since: Date.now(), count: 0 } };
    connections.add(connection);
    const helloTimer = setTimeout(() => { if (!connection.session) socket.close(1008, 'HELLO timeout'); }, limits.helloTimeoutMs);
    let tail = Promise.resolve();
    socket.on('pong', () => { connection.missed = 0; });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => { clearTimeout(helloTimer); disconnect(connection); connections.delete(connection); });
    socket.on('message', (data, binary) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!allow(connection.rate) || connection.pending >= limits.maxPendingMessages) {
        error(connection, 'RATE_LIMITED'); socket.close(1008, 'Rate limited'); return;
      }
      if (binary) { error(connection, 'INVALID_MESSAGE'); return; }
      let raw: unknown;
      try { raw = JSON.parse(data.toString()); }
      catch { error(connection, 'INVALID_MESSAGE'); return; }
      connection.pending++;
      tail = tail.then(async () => {
        if (socket.readyState === WebSocket.OPEN) await receive(connection, raw, request);
      }).catch(cause => {
        options.onError(cause);
        error(connection, 'SERVICE_UNAVAILABLE');
        socket.close(1011, 'Service unavailable');
      }).finally(() => { connection.pending--; });
    });
  });
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (connection.missed++ >= 2) connection.socket.terminate();
      else if (connection.socket.readyState === WebSocket.OPEN) connection.socket.ping();
    }
  }, limits.heartbeatMs);
  heartbeat.unref();
  const upgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (closed || request.url !== '/29-card/ws' || !request.headers.origin || !origins.has(request.headers.origin) ||
        connections.size >= limits.maxConnections) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  };
  options.server.on('upgrade', upgrade);
  return {
    registerMatch(matchId: string, actor: Actor) {
      matchIdSchema.parse(matchId);
      if (closed || tables.has(matchId)) throw new Error('Gateway closed or match already registered');
      tables.set(matchId, { actor, buffers: new Map(), rates: new Map(), commands: 0 });
    },
    publish(matchId: string, viewer: Viewer, events: readonly RuntimeEvent[]) {
      const table = tables.get(matchId);
      if (!table || events.length === 0) return;
      let buffer = table.buffers.get(viewer) ?? [];
      for (const event of events) {
        if (event.event.type === 'HAND_STARTED') buffer = [];
        buffer.push(structuredClone(event));
      }
      table.buffers.set(viewer, buffer.slice(-limits.maxBufferedEvents));
      for (const connection of connections) {
        if (connection.session?.matchId === matchId && connection.session.viewer === viewer) {
          if (connection.session.expiresAt !== undefined && connection.session.expiresAt <= Date.now()) continue;
          send(connection, { type: 'EVENTS', matchId, events });
          if (events.some(entry => entry.event.type === 'READY_FAILED' &&
              entry.event.seats.some(seat => seat === connection.session?.viewer))) {
            disconnect(connection);
            connection.socket.close(1008, 'Ready check expired');
          }
        }
      }
      if (viewer === 'spectator' && events.some(entry => entry.event.type === 'TABLE_UPDATED' || entry.event.type === 'HAND_STARTED')) {
        broadcastLobby(matchId);
      }
    },
    unregisterMatch(matchId: string) {
      for (const connection of connections) {
        if (connection.session?.matchId === matchId) {
          disconnect(connection);
          connection.socket.close(1001, 'Match removed');
        }
      }
      tables.delete(matchId);
    },
    async close() {
      closed = true;
      clearInterval(heartbeat);
      options.server.off('upgrade', upgrade);
      for (const connection of connections) {
        connection.session = undefined; clearTimeout(connection.expiryTimer); connection.socket.terminate();
      }
      tables.clear();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    },
  };
}
