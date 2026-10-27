const { describe, test, expect, jest: mocks } = require('@jest/globals');
const { createPinTables } = require('../../src/application/pin-tables.ts');
const { createTableRequestSchema, joinTableRequestSchema, tableCredentialsSchema } = require('../../src/protocol/private-tables.ts');

function fixture(overrides = {}, effects = {}) {
  let now = 1000, nextPin = 0, nextToken = 0, nextId = 0;
  const runtimes = [];
  const ports = {
    now: () => now, newPin: () => String(nextPin++).padStart(6, '0'),
    newToken: () => String(nextToken++).padStart(43, 'a'), newId: () => `table-${nextId++}`, hash: value => `hash:${value}`,
    open: mocks.fn(async () => {
      let lastDisconnectedAt = now;
      const runtime = { hasConnections: mocks.fn(() => false), lastDisconnectedAt: () => lastDisconnectedAt,
        markDisconnected: () => { lastDisconnectedAt = now; }, isClosed: mocks.fn(() => false), close: mocks.fn(async () => {}) };
      runtimes.push(runtime); return runtime;
    }), ...effects,
  };
  return { tables: createPinTables({ maxTables: 3, lifetimeMs: 10000, idleMs: 1000, ...overrides }, ports),
    ports, runtimes, advance: value => { now += value; } };
}

describe('ephemeral PIN tables', () => {
  test('shared schemas reject seat selection, coercion, unknown fields, and malformed credentials', () => {
    expect(joinTableRequestSchema.safeParse({ pin: '012345', attemptId: 'A'.repeat(43) }).success).toBe(true);
    expect(createTableRequestSchema.safeParse({}).success).toBe(true);
    expect(createTableRequestSchema.safeParse({ seat: 0 }).success).toBe(false);
    for (const input of [{ pin: 123456 }, { pin: '012345' }, { pin: '12345', attemptId: 'A'.repeat(43) },
      { pin: '1234567', attemptId: 'A'.repeat(43) }, { pin: ' 123456', attemptId: 'A'.repeat(43) },
      { pin: '123456', attemptId: 'short' }, { pin: '123456', attemptId: 'A'.repeat(43), seat: 0 }]) {
      expect(joinTableRequestSchema.safeParse(input).success).toBe(false);
    }
    expect(joinTableRequestSchema.safeParse({ pin: '000001', attemptId: 'B'.repeat(43) }).success).toBe(true);
    expect(tableCredentialsSchema.safeParse({ pin: '000001', token: 'a'.repeat(43) }).success).toBe(true);
    expect(tableCredentialsSchema.safeParse({ pin: '000001', token: 'short' }).success).toBe(false);
  });

  test('creator gets seat zero; concurrent joiners get exactly the other three seats', async () => {
    const { tables } = fixture();
    const created = await tables.create();
    expect(created.ok).toBe(true);
    const { pin, token } = created.credentials;
    expect(tables.authenticate(token)).toMatchObject({ matchId: 'table-0', viewer: 0 });
    const joins = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      tables.join(pin, String(index).padStart(43, 'A'))));
    expect(joins.filter(result => result.ok)).toHaveLength(3);
    expect(joins[3]).toEqual({ ok: false, failure: { status: 409, error: 'Table is full' } });
    expect(joins.slice(0, 3).map(result => tables.authenticate(result.credentials.token).viewer)).toEqual([1, 2, 3]);
    expect(tables.authenticate('unknown')).toBeNull();
    await tables.close();
    expect(tables.authenticate(token)).toBeNull();
  });

  test('lost join responses retry the same reservation without consuming another seat', async () => {
    const { tables } = fixture();
    const created = await tables.create(), second = await tables.create();
    const attemptId = 'A'.repeat(43);
    const lostResponse = await tables.join(created.credentials.pin, attemptId);
    const retry = await tables.join(created.credentials.pin, attemptId);
    expect(retry).toEqual(lostResponse);
    expect(tables.authenticate(retry.credentials.token)).toMatchObject({ matchId: 'table-0', viewer: 1 });
    expect(await tables.join(second.credentials.pin, attemptId)).toMatchObject({ ok: false, failure: { status: 409 } });
    const seats = await Promise.all(['B', 'C'].map(value => tables.join(created.credentials.pin, value.repeat(43))));
    expect(seats.every(result => result.ok)).toBe(true);
    expect(await tables.join(created.credentials.pin, 'D'.repeat(43))).toMatchObject({ ok: false, failure: { status: 409 } });
    await tables.close();
  });

  test('tables and hidden credentials are isolated; PIN collisions retry without replacing a table', async () => {
    const pins = ['000001', '000001', '000002'];
    const { tables } = fixture({}, { newPin: () => pins.shift() });
    const first = await tables.create(), second = await tables.create();
    expect(first.credentials.pin).toBe('000001');
    expect(second.credentials.pin).toBe('000002');
    expect(tables.authenticate(first.credentials.token).matchId).not.toBe(tables.authenticate(second.credentials.token).matchId);
    expect(await tables.join('999999', 'Z'.repeat(43))).toMatchObject({ ok: false, failure: { status: 404 } });
    await tables.close();
  });

  test('capacity and exhausted PIN/credential collision retries fail without leaking runtimes', async () => {
    const limited = fixture({ maxTables: 1 });
    await limited.tables.create();
    expect(await limited.tables.create()).toMatchObject({ ok: false, failure: { status: 503 } });
    await limited.tables.close();
    const colliding = fixture({}, { newPin: () => '000000' });
    await colliding.tables.create();
    expect(await colliding.tables.create()).toMatchObject({ ok: false, failure: { status: 503 } });
    await colliding.tables.close();
    const tokens = fixture({}, { newToken: () => 'a'.repeat(43) });
    await tokens.tables.create();
    expect(await tokens.tables.create()).toMatchObject({ ok: false, failure: { status: 503 } });
    expect(tokens.runtimes[1].close).toHaveBeenCalledTimes(1);
    expect(await tokens.tables.join('000000', 'a'.repeat(43))).toMatchObject({ ok: false, failure: { status: 503 } });
    await tokens.tables.close();
  });

  test('idle, closed, and expired tables revoke credentials, stop actors, and release capacity', async () => {
    const f = fixture({ maxTables: 1 });
    const first = await f.tables.create();
    f.advance(1000);
    await f.tables.sweep();
    expect(f.runtimes[0].close).toHaveBeenCalledTimes(1);
    expect(f.tables.authenticate(first.credentials.token)).toBeNull();
    expect(await f.tables.join(first.credentials.pin, 'A'.repeat(43))).toMatchObject({ ok: false, failure: { status: 404 } });
    const second = await f.tables.create();
    f.runtimes[1].hasConnections.mockReturnValue(true);
    f.advance(9999); await f.tables.sweep();
    expect(f.tables.authenticate(second.credentials.token)).not.toBeNull();
    f.advance(1);
    expect(f.tables.authenticate(second.credentials.token)).toBeNull();
    await f.tables.sweep();
    expect(f.runtimes[1].close).toHaveBeenCalledTimes(1);
    await f.tables.create(); f.runtimes[2].isClosed.mockReturnValue(true);
    await f.tables.sweep();
    expect(f.runtimes[2].close).toHaveBeenCalledTimes(1);
    await f.tables.close();
    expect(await f.tables.create()).toMatchObject({ ok: false, failure: { status: 503 } });
    expect(await f.tables.join('000001', 'A'.repeat(43))).toMatchObject({ ok: false, failure: { status: 503 } });
  });

  test('idle expiry starts at the actual final disconnect between sweeps', async () => {
    const f = fixture();
    const created = await f.tables.create();
    f.runtimes[0].hasConnections.mockReturnValue(true);
    f.advance(900);
    f.runtimes[0].hasConnections.mockReturnValue(false);
    f.runtimes[0].markDisconnected();
    await f.tables.sweep();
    expect(f.runtimes[0].close).not.toHaveBeenCalled();
    f.advance(999);
    await f.tables.sweep();
    expect(f.runtimes[0].close).not.toHaveBeenCalled();
    f.advance(1);
    await f.tables.sweep();
    expect(f.runtimes[0].close).toHaveBeenCalledTimes(1);
    expect(f.tables.authenticate(created.credentials.token)).toBeNull();
    await f.tables.close();
  });

  test('startup failure does not poison serialized operations and shutdown waits for in-flight startup', async () => {
    const f = fixture();
    f.ports.open.mockRejectedValueOnce(new Error('startup failed'));
    await expect(f.tables.create()).rejects.toThrow('startup failed');
    expect((await f.tables.create()).ok).toBe(true);
    await Promise.all([f.tables.close(), f.tables.close()]);
    expect(f.runtimes[0].close).toHaveBeenCalledTimes(1);
    const pending = fixture();
    const creating = pending.tables.create();
    const closing = pending.tables.close();
    expect(await creating).toMatchObject({ ok: false, failure: { status: 503 } });
    await closing;
    expect(pending.ports.open).not.toHaveBeenCalled();
  });
});
