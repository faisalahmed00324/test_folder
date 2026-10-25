const { describe, test, expect, afterEach } = require('@jest/globals');
const { mkdtemp, chmod, writeFile, rm, stat, readFile, unlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { privateServerConfigSchema, readPrivateServerConfig, startPrivateServer } = require('../../src/adapters/private-server.ts');

const resources = [];
afterEach(async () => { for (const cleanup of resources.splice(0).reverse()) await cleanup(); });
async function configuration() {
  const directory = await mkdtemp(join(tmpdir(), '29-host-'));
  await chmod(directory, 0o700);
  resources.push(() => rm(directory, { recursive: true, force: true }));
  const tokens = Array.from({ length: 4 }, () => randomBytes(32).toString('base64url'));
  const config = { matchId: 'private-table', port: 0, table: false, allowedOrigins: ['https://game.example'],
    journalPath: join(directory, 'table.journal'), members: tokens.map((token, viewer) => ({
      viewer, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000,
    })) };
  return { config, tokens, directory, key: 'ab'.repeat(32) };
}
async function host(config, key) {
  const errors = [];
  const server = await startPrivateServer(config, key, error => errors.push(error));
  resources.push(() => server.close());
  return { ...server, errors };
}
async function client(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/29-card/ws`, { origin: 'https://game.example' });
  const buffered = [], waiters = [];
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex(waiter => waiter.type === value.type);
    if (index < 0) buffered.push(value); else waiters.splice(index, 1)[0].resolve(value);
  });
  await once(socket, 'open');
  return { socket, send: value => socket.send(JSON.stringify(value)), next: type => {
    const index = buffered.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
    return new Promise(resolve => waiters.push({ type, resolve }));
  } };
}
async function authenticate(port, token) {
  const connection = await client(port);
  connection.send({ type: 'HELLO', protocolVersion: 1, token });
  expect(await connection.next('WELCOME')).toMatchObject({ matchId: 'private-table' });
  return connection;
}

describe('private table server host', () => {
  test('invitation guests cannot read/play, race for one seat atomically, and reconnect only with the winning credential', async () => {
    const h = await configuration();
    const invite = randomBytes(32).toString('base64url');
    const expiresAt = h.config.members[0].expiresAt;
    delete h.config.members; delete h.config.table;
    h.config.invitation = { tokenHash: createHash('sha256').update(invite).digest('hex'), expiresAt,
      journalPath: join(h.directory, 'memberships.journal') };
    const first = await host(h.config, h.key);
    const guests = [await authenticate(first.port, invite), await authenticate(first.port, invite)];
    expect(guests[0].socket.readyState).toBe(WebSocket.OPEN);
    guests[0].send({ type: 'GET_LOBBY' });
    const lobby = await guests[0].next('LOBBY');
    expect(lobby.lobby.seats).toEqual([0, 1, 2, 3].map(seat => ({ seat, occupied: false })));
    for (const message of [{ type: 'GET_VIEW' }, { type: 'GET_HISTORY', requestId: '00000000-0000-4000-8000-000000000099' },
      { type: 'COMMAND', command: { commandId: '00000000-0000-4000-8000-000000000098', matchId: h.config.matchId, expectedVersion: 0, action: { type: 'BID', amount: 16 } } }]) {
      guests[0].send(message); expect(await guests[0].next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    }
    for (const [index, guest] of guests.entries()) guest.send({ type: 'TAKE_SEAT', seat: 0, token: h.tokens[index],
      requestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` });
    const results = await Promise.all(guests.map(guest => guest.next('SEAT_RESULT')));
    expect(results.filter(value => value.result.ok)).toHaveLength(1);
    expect(results.find(value => !value.result.ok).result.code).toBe('SEAT_TAKEN');
    const winner = results.findIndex(value => value.result.ok), loser = 1 - winner;
    guests[winner].send({ type: 'GET_VIEW' });
    expect((await guests[winner].next('SNAPSHOT')).snapshot).toMatchObject({ viewer: 0, myHand: [], table: { phase: 'WAITING' } });
    guests[winner].send({ type: 'TAKE_SEAT', seat: 1, token: h.tokens[2], requestId: '00000000-0000-4000-8000-000000000009' });
    expect(await guests[winner].next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    await first.close();
    const encrypted = await readFile(h.config.invitation.journalPath, 'utf8');
    expect(encrypted).not.toContain(h.tokens[winner]); expect(encrypted).not.toContain('tokenHash');
    await expect(startPrivateServer({ ...h.config, journalPath: join(h.directory, 'lost-game.journal') }, h.key, () => {})).rejects.toThrow('Game journal missing');
    const recovered = await host(h.config, h.key);
    const seated = await authenticate(recovered.port, h.tokens[winner]);
    seated.send({ type: 'GET_VIEW' }); expect((await seated.next('SNAPSHOT')).snapshot.viewer).toBe(0);
    const failed = await client(recovered.port);
    failed.send({ type: 'HELLO', protocolVersion: 1, token: h.tokens[loser] });
    expect(await failed.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    const guest = await authenticate(recovered.port, invite);
    guest.send({ type: 'GET_LOBBY' }); expect((await guest.next('LOBBY')).lobby.seats[0].occupied).toBe(true);
    expect(recovered.errors).toEqual([]);
  });

  test('membership authority is bound to its game journal and cannot be silently reset or changed', async () => {
    const h = await configuration();
    const staticConfig = structuredClone(h.config);
    const invitation = { tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      expiresAt: h.config.members[0].expiresAt, journalPath: join(h.directory, 'memberships.journal') };
    delete h.config.members; delete h.config.table; h.config.invitation = invitation;
    const server = await host(h.config, h.key); await server.close();
    await expect(startPrivateServer({ ...h.config, invitation: { ...invitation, tokenHash: 'a'.repeat(64) } }, h.key, () => {})).rejects.toThrow('configuration mismatch');
    await expect(startPrivateServer({ ...staticConfig, table: {} }, h.key, () => {})).rejects.toThrow('membership authority');
    await unlink(invitation.journalPath);
    await expect(startPrivateServer(h.config, h.key, () => {})).rejects.toThrow('Membership journal missing');
  });

  test('invite configuration is explicit, private, separate from game storage, and requires readiness', async () => {
    const h = await configuration();
    const invitation = { tokenHash: 'a'.repeat(64), expiresAt: Date.now() + 60000, journalPath: h.config.journalPath };
    expect(privateServerConfigSchema.safeParse({ ...h.config, invitation }).success).toBe(false);
    const config = { ...h.config }; delete config.members;
    expect(privateServerConfigSchema.safeParse({ ...config, invitation }).success).toBe(false);
    delete config.table;
    await expect(startPrivateServer({ ...config, invitation }, h.key, () => {})).rejects.toThrow('separate paths');
    expect(privateServerConfigSchema.safeParse({ ...config, invitation: { ...invitation, journalPath: 'relative' } }).success).toBe(false);
  });

  test('encrypted host recovery restores fixed chat and its original idempotency receipt', async () => {
    const h = await configuration();
    const first = await host(h.config, h.key);
    const player = await authenticate(first.port, h.tokens[0]);
    const command = { type: 'COMMAND', command: { matchId: h.config.matchId, expectedVersion: 1,
      commandId: '00000000-0000-4000-8000-000000000001', action: { type: 'QUICK_CHAT', phraseId: 'THANKS' } } };
    player.send(command); const receipt = await player.next('RESULT');
    expect(receipt.ok).toBe(true);
    await first.close();
    const recovered = await host(h.config, h.key);
    const returned = await authenticate(recovered.port, h.tokens[0]);
    returned.send({ type: 'GET_VIEW' });
    expect((await returned.next('SNAPSHOT')).snapshot.chat.messages).toEqual([expect.objectContaining({ seat: 0, phraseId: 'THANKS' })]);
    returned.send(command); expect(await returned.next('RESULT')).toEqual(receipt);
    returned.send({ type: 'GET_HISTORY', requestId: '00000000-0000-4000-8000-000000000099', limit: 10 });
    expect((await returned.next('HISTORY')).page.entries).toEqual([]);
    expect(recovered.errors).toEqual([]);
  });

  test('new hosts require ready consent by default, recover play, and reject changed coordination settings', async () => {
    const h = await configuration(); delete h.config.table;
    const first = await host(h.config, h.key);
    const players = [];
    for (const token of h.tokens) players.push(await authenticate(first.port, token));
    players[0].send({ type: 'GET_VIEW' });
    const waiting = await players[0].next('SNAPSHOT');
    expect(waiting.snapshot).toMatchObject({ version: 0, myHand: [], table: { phase: 'READY_CHECK', matchNumber: 1 } });
    for (const [seat, player] of players.entries()) {
      player.send({ type: 'COMMAND', command: { matchId: h.config.matchId, expectedVersion: 0,
        expectedCheckId: waiting.snapshot.table.checkId, action: { type: 'READY' },
        commandId: `00000000-0000-4000-8000-${String(seat).padStart(12, '0')}` } });
      expect(await player.next('RESULT')).toMatchObject({ ok: true });
    }
    players[0].send({ type: 'GET_VIEW' });
    expect((await players[0].next('SNAPSHOT')).snapshot).toMatchObject({ version: 1, table: { phase: 'PLAYING' }, myHand: expect.any(Array) });
    await first.close();
    await expect(startPrivateServer({ ...h.config, table: { readyMs: 1000 } }, h.key, () => {})).rejects.toThrow('table coordination');
    const recovered = await host(h.config, h.key);
    const player = await authenticate(recovered.port, h.tokens[0]);
    player.send({ type: 'GET_VIEW' });
    expect((await player.next('SNAPSHOT')).snapshot).toMatchObject({ version: 1, table: { phase: 'PLAYING' } });
    expect(recovered.errors).toEqual([]);
  });

  test('serves health only, authenticates hashed seat tokens, persists and recovers commands', async () => {
    const h = await configuration();
    const first = await host(h.config, h.key);
    expect(await (await fetch(`http://127.0.0.1:${first.port}/healthz`)).json()).toEqual({ ok: true });
    expect((await fetch(`http://127.0.0.1:${first.port}/table.journal`)).status).toBe(404);
    const connection = await authenticate(first.port, h.tokens[0]);
    connection.send({ type: 'GET_VIEW' });
    const initial = await connection.next('SNAPSHOT');
    expect(initial.snapshot.myHand).toHaveLength(4);
    const opener = initial.snapshot.toAct;
    const bidder = opener === 0 ? connection : await authenticate(first.port, h.tokens[opener]);
    const command = { type: 'COMMAND', command: { matchId: h.config.matchId,
      commandId: '00000000-0000-4000-8000-000000000001', expectedVersion: 1, action: { type: 'BID', amount: 16 } } };
    bidder.send(command);
    const receipt = await bidder.next('RESULT');
    expect(receipt).toMatchObject({ ok: true, version: 2 });
    connection.send({ type: 'GET_VIEW' });
    const before = await connection.next('SNAPSHOT');
    await first.close();
    const second = await host(h.config, h.key);
    const resumed = await authenticate(second.port, h.tokens[0]);
    resumed.send({ type: 'RESUME', matchId: h.config.matchId, seq: 0 });
    const recovered = await resumed.next('SNAPSHOT');
    expect(recovered.seq).toBeGreaterThan(before.seq);
    expect(recovered.snapshot).toMatchObject({ version: 2, myHand: before.snapshot.myHand,
      deadline: before.snapshot.deadline, auction: before.snapshot.auction });
    const retry = opener === 0 ? resumed : await authenticate(second.port, h.tokens[opener]);
    retry.send(command);
    expect(await retry.next('RESULT')).toEqual(receipt);
    expect(first.errors).toEqual([]); expect(second.errors).toEqual([]);
    expect((await stat(h.config.journalPath)).mode & 0o777).toBe(0o600);
  });

  test('fails closed for forged credentials and expires active sessions', async () => {
    const h = await configuration();
    h.config.members[0].expiresAt = Date.now() + 500;
    const server = await host(h.config, h.key);
    const denied = await client(server.port);
    denied.send({ type: 'HELLO', protocolVersion: 1, token: 'forged' });
    expect(await denied.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
    const allowed = await authenticate(server.port, h.tokens[0]);
    expect((await once(allowed.socket, 'close'))[0]).toBe(1008);
    const expired = await client(server.port);
    expired.send({ type: 'HELLO', protocolVersion: 1, token: h.tokens[0] });
    expect(await expired.next('ERROR')).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('validates unique complete membership, origins, key, expiry and private paths', async () => {
    const h = await configuration();
    for (const config of [
      { ...h.config, members: h.config.members.slice(1) },
      { ...h.config, members: [...h.config.members.slice(0, 3), h.config.members[0]] },
      { ...h.config, allowedOrigins: ['https://game.example/path'] },
      { ...h.config, allowedOrigins: ['file://example'] },
      { ...h.config, journalPath: 'relative.journal' },
      { ...h.config, unexpected: true },
    ]) expect(privateServerConfigSchema.safeParse(config).success).toBe(false);
    await expect(startPrivateServer(h.config, 'bad-key', () => {})).rejects.toThrow();
    await expect(startPrivateServer({ ...h.config, members: h.config.members.map(member => ({ ...member, expiresAt: 1 })) },
      h.key, () => {})).rejects.toThrow('expired');
    await chmod(h.directory, 0o755);
    await expect(startPrivateServer(h.config, h.key, () => {})).rejects.toThrow('private');
  });

  test('loads only private configuration files', async () => {
    const h = await configuration();
    const path = join(h.directory, 'config.json');
    await writeFile(path, JSON.stringify(h.config), { mode: 0o600 });
    expect(await readPrivateServerConfig(path)).toEqual(h.config);
    await chmod(path, 0o644);
    await expect(readPrivateServerConfig(path)).rejects.toThrow('private');
  });

  test('refuses preset changes on recovery and releases resources after failed startup', async () => {
    const h = await configuration();
    const server = await host(h.config, h.key);
    await server.close();
    await expect(startPrivateServer({ ...h.config, preset: '28-standard' }, h.key, () => {})).rejects.toThrow('configured table');
    const recovered = await host(h.config, h.key);
    expect(recovered.port).toBeGreaterThan(0);
    await recovered.close(); await recovered.close();
  });

  test('refuses lifecycle deadline changes against the durable table configuration', async () => {
    const h = await configuration();
    const server = await host(h.config, h.key);
    await server.close();
    await expect(startPrivateServer({ ...h.config, lifecycle: { disconnectGraceMs: 1000 } },
      h.key, () => {})).rejects.toThrow('configured lifecycle');
    const recovered = await host(h.config, h.key);
    const connection = await authenticate(recovered.port, h.tokens[0]);
    connection.send({ type: 'GET_VIEW' });
    expect((await connection.next('SNAPSHOT')).snapshot.seats[0]).toMatchObject({ connected: true, controller: 'human' });
  });
});
