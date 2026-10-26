import type { Seat } from '../domain/seats';
import type { TableCredentials } from '../protocol/private-tables';

export type TableFailure = { status: 404 | 409 | 503; error: string };
export type TableResult = { ok: true; credentials: TableCredentials } | { ok: false; failure: TableFailure };
export type PinTableRuntime = {
  hasConnections(): boolean;
  isClosed(): boolean;
  close(): Promise<void>;
};
type Table = { pin: string; matchId: string; expiresAt: number; lastActiveAt: number;
  runtime: PinTableRuntime; hashes: string[] };
type Membership = { matchId: string; viewer: Seat; expiresAt: number };

export function createPinTables(settings: { maxTables: number; lifetimeMs: number; idleMs: number }, ports: {
  now(): number;
  newPin(): string;
  newToken(): string;
  newId(): string;
  hash(token: string): string;
  open(matchId: string): Promise<PinTableRuntime>;
}) {
  const tables = new Map<string, Table>();
  const members = new Map<string, Membership>();
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const unavailable = (): TableResult => ({ ok: false, failure: { status: 503, error: 'Table capacity unavailable' } });

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  }
  async function remove(table: Table) {
    tables.delete(table.pin);
    for (const hash of table.hashes) members.delete(hash);
    await table.runtime.close();
  }
  async function sweep() {
    const now = ports.now();
    for (const table of tables.values()) {
      if (table.runtime.hasConnections()) table.lastActiveAt = now;
      if (now >= table.expiresAt || now - table.lastActiveAt >= settings.idleMs || table.runtime.isClosed()) await remove(table);
    }
  }
  function claim(table: Table): TableResult {
    for (let attempt = 0; attempt < 32; attempt++) {
      const token = ports.newToken();
      const hash = ports.hash(token);
      if (members.has(hash)) continue;
      const viewer = table.hashes.length as Seat;
      table.hashes.push(hash);
      members.set(hash, { matchId: table.matchId, viewer, expiresAt: table.expiresAt });
      return { ok: true, credentials: { pin: table.pin, token } };
    }
    return unavailable();
  }
  return {
    create(): Promise<TableResult> {
      return serialize(async () => {
        if (closed) return unavailable();
        await sweep();
        if (tables.size >= settings.maxTables) return unavailable();
        let pin: string | undefined;
        for (let attempt = 0; attempt < 32; attempt++) {
          const candidate = ports.newPin();
          if (!tables.has(candidate)) { pin = candidate; break; }
        }
        if (pin === undefined) return unavailable();
        const matchId = ports.newId();
        const runtime = await ports.open(matchId);
        const now = ports.now();
        const table: Table = { pin, matchId, expiresAt: now + settings.lifetimeMs, lastActiveAt: now, runtime, hashes: [] };
        tables.set(pin, table);
        const result = claim(table);
        if (!result.ok) await remove(table);
        return result;
      });
    },
    join(pin: string): Promise<TableResult> {
      return serialize(async () => {
        if (closed) return unavailable();
        await sweep();
        const table = tables.get(pin);
        if (!table) return { ok: false, failure: { status: 404, error: 'Table not found' } };
        if (table.hashes.length >= 4) return { ok: false, failure: { status: 409, error: 'Table is full' } };
        return claim(table);
      });
    },
    authenticate(token: string): Membership | null {
      if (closed) return null;
      const member = members.get(ports.hash(token));
      return member && member.expiresAt > ports.now() ? { ...member } : null;
    },
    sweep: () => serialize(sweep),
    close(): Promise<void> {
      closed = true;
      return serialize(async () => {
        const pending = [...tables.values()];
        tables.clear(); members.clear();
        await Promise.all(pending.map(table => table.runtime.close()));
      });
    },
  };
}
