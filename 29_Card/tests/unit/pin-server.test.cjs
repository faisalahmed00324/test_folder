const { describe, test, expect, afterEach, jest: mocks } = require('@jest/globals');
const { once } = require('node:events');
const { request, createServer } = require('node:http');
const { WebSocket } = require('ws');
const { startPinServer, pinServerConfigSchema, createPinTableService } = require('../../src/adapters/pin-server.ts');
const { createWebSocketGateway } = require('../../src/adapters/websocket-gateway.ts');
const { tableCredentialsSchema } = require('../../src/protocol/private-tables.ts');

const resources = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
async function host(config = {}) {
  const errors = [];
  const server = await startPinServer({ port: 0, ...config }, error => errors.push(error));
  resources.push(server.close);
  return { ...server, errors };
}
function post(port, path = '/29-card/tables', body = {}, headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject); req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
async function client(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/29-card/ws`, { origin: 'http://127.0.0.1:8765' });
  const buffered = [], waiters = [];
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex(waiter => waiter.type === value.type);
    if (index < 0) buffered.push(value); else waiters.splice(index, 1)[0].resolve(value);
  });
  resources.push(async () => { socket.terminate(); });
  await once(socket, 'open');
  const connection = { socket, send: value => socket.send(JSON.stringify(value)), next: type => {
    const index = buffered.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
    return new Promise(resolve => waiters.push({ type, resolve }));
  } };
  connection.send({ type: 'HELLO', protocolVersion: 1, token });
  return connection;
}

describe('PIN HTTP/WebSocket integration without keys or persistence', () => {
  test('embedding on a shared gateway exposes authentication without conflicting upgrade handlers', async () => {
    let service;
    const errors = [];
    const server = createServer((req, res) => service.handle(req, res));
    const gateway = createWebSocketGateway({ server, allowedOrigins: ['http://127.0.0.1:8765'],
      authenticate: async token => service.authenticate(token), onError: error => errors.push(error) });
    service = createPinTableService(server, {}, error => errors.push(error), gateway);
    resources.push(async () => {
      await gateway.close(); await service.close();
      const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closing;
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const created = await post(port);
    expect(created.status).toBe(200);
    expect(service.authenticate(created.body.token)).toMatchObject({ viewer: 0 });
    const player = await client(port, created.body.token);
    expect(await player.next('WELCOME')).toMatchObject({ viewer: 0 });
    player.send({ type: 'GET_VIEW' });
    expect((await player.next('SNAPSHOT')).snapshot.table.phase).toBe('WAITING');
    expect(errors).toEqual([]);
  });

  test('creates isolated tables, assigns four seats, protects cross-table commands, and exposes no history', async () => {
    const h = await host();
    const first = await post(h.port), second = await post(h.port);
    expect(first.status).toBe(200);
    expect(tableCredentialsSchema.safeParse(first.body).success).toBe(true);
    expect(first.body.pin).not.toBe(second.body.pin);
    expect(first.body.token).not.toBe(second.body.token);
    const credentials = [first.body];
    for (let i = 0; i < 3; i++) {
      const result = await post(h.port, '/29-card/tables/join', { pin: first.body.pin });
      expect(result.status).toBe(200); credentials.push(result.body);
    }
    expect((await post(h.port, '/29-card/tables/join', { pin: first.body.pin })).status).toBe(409);
    const players = [];
    let matchId;
    for (const [viewer, entry] of credentials.entries()) {
      const connection = await client(h.port, entry.token);
      const welcome = await connection.next('WELCOME');
      expect(welcome.viewer).toBe(viewer);
      matchId ??= welcome.matchId; expect(welcome.matchId).toBe(matchId);
      players.push(connection);
    }
    players[0].send({ type: 'GET_VIEW' });
    const snapshot = await players[0].next('SNAPSHOT');
    expect(snapshot.snapshot).toMatchObject({ viewer: 0, myHand: [], table: { phase: 'READY_CHECK' } });
    for (const [seat, player] of players.entries()) {
      player.send({ type: 'GET_VIEW' });
      const view = await player.next('SNAPSHOT');
      player.send({ type: 'COMMAND', command: { commandId: `00000000-0000-4000-8000-${String(seat + 10).padStart(12, '0')}`,
        matchId, expectedVersion: view.snapshot.version, expectedCheckId: view.snapshot.table.checkId, action: { type: 'READY' } } });
      expect((await player.next('RESULT')).ok).toBe(true);
    }
    players[0].send({ type: 'GET_VIEW' });
    expect((await players[0].next('SNAPSHOT')).snapshot).toMatchObject({ table: { phase: 'PLAYING' }, myHand: expect.any(Array) });
    const other = await client(h.port, second.body.token);
    const otherWelcome = await other.next('WELCOME');
    expect(otherWelcome.matchId).not.toBe(matchId);
    other.send({ type: 'GET_VIEW' });
    expect((await other.next('SNAPSHOT')).snapshot).toMatchObject({ viewer: 0, myHand: [], table: { phase: 'WAITING' } });
    other.send({ type: 'COMMAND', command: { commandId: '00000000-0000-4000-8000-000000000001',
      matchId, expectedVersion: 0, expectedCheckId: 1, action: { type: 'READY' } } });
    expect(await other.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    players[0].send({ type: 'GET_HISTORY', requestId: '00000000-0000-4000-8000-000000000002' });
    expect((await players[0].next('HISTORY')).page).toEqual({
      entries: [], nextBefore: null, earliestAvailable: null, total: 0, truncated: false,
    });
    const invalid = await client(h.port, first.body.pin);
    expect(await invalid.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(h.errors).toEqual([]);
    await h.close(); await h.close();
  });

  test('strict HTTP boundaries reject malformed JSON, PINs, seat choices, large bodies, and unknown paths', async () => {
    const h = await host();
    for (const body of ['{', 'null', '[]', { seat: 0 }]) expect((await post(h.port, undefined, body)).status).toBe(400);
    for (const body of [{}, { pin: 123456 }, { pin: '12345' }, { pin: '123456', seat: 1 }]) {
      expect((await post(h.port, '/29-card/tables/join', body)).status).toBe(400);
    }
    expect((await post(h.port, undefined, { padding: 'x'.repeat(2048) })).status).toBe(400);
    expect((await post(h.port, undefined, {}, { 'Content-Type': 'text/plain' })).status).toBe(400);
    expect((await post(h.port, undefined, {}, {}, 'GET')).status).toBe(400);
    expect((await post(h.port, '/unknown')).status).toBe(404);
    expect((await post(h.port, '/29-card/tables/join', { pin: '999999' })).status).toBe(404);
    expect(h.errors).toEqual([]);
  });

  test('CORS is explicit, preflights are bounded, and origin rejection creates no table', async () => {
    const h = await host({ maxTables: 1 });
    const denied = await post(h.port, undefined, {}, { Origin: 'https://evil.example' });
    expect(denied.status).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    const options = await post(h.port, undefined, '', { Origin: 'http://localhost:8765',
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }, 'OPTIONS');
    expect(options.status).toBe(204);
    expect(options.headers['access-control-allow-origin']).toBe('http://localhost:8765');
    expect((await post(h.port, undefined, '', { 'Access-Control-Request-Method': 'DELETE' }, 'OPTIONS')).status).toBe(400);
    const created = await post(h.port, undefined, {}, { Origin: 'http://127.0.0.1:8765' });
    expect(created.status).toBe(200);
    expect(created.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8765');
    expect(created.headers['cache-control']).toBe('no-store');
    expect((await post(h.port)).status).toBe(503);
    expect(h.errors).toEqual([]);
  });

  test('IP rate windows bound requests including failed PIN guesses; configuration is validated', async () => {
    const h = await host({ requestsPerWindow: 2, maxRateEntries: 1 });
    expect((await post(h.port, '/29-card/tables/join', { pin: '999999' })).status).toBe(404);
    expect((await post(h.port)).status).toBe(200);
    const limited = await post(h.port);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(h.errors).toEqual([]);
    for (const config of [{ maxTables: 0 }, { port: -1 }, { allowedOrigins: ['*'] },
      { allowedOrigins: ['https://example.com/path'] }, { lifetimeMs: Infinity }]) {
      expect(pinServerConfigSchema.safeParse(config).success).toBe(false);
    }
    expect(pinServerConfigSchema.parse({}).port).toBe(8766);
  });

  test('expired IP windows release entries and allow requests again', async () => {
    const h = await host({ maxRateEntries: 1, requestsPerWindow: 1 });
    let now = Date.now();
    mocks.spyOn(Date, 'now').mockImplementation(() => now);
    const guess = () => post(h.port, '/29-card/tables/join', { pin: '999999' });
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(429);
    now += 60_001;
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(429);
    expect(h.errors).toEqual([]);
  });

  test('WebSocket upgrade rejects disallowed origins before authentication', async () => {
    const h = await host();
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${h.port}/29-card/ws`, { origin: 'https://evil.example' });
      socket.on('error', () => {});
      socket.on('open', () => { socket.terminate(); reject(new Error('Unexpected accepted socket')); });
      socket.on('unexpected-response', (_request, response) => {
        expect(response.statusCode).toBe(403); response.resume(); socket.terminate(); resolve();
      });
    });
    expect(h.errors).toEqual([]);
  });
});
