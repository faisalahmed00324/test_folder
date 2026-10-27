import type { Seat } from '../domain/seats';
import type { TableCredentials } from '../protocol/private-tables';

export type TableFailure = { status: 404 | 409 | 503; error: string };
export type TableResult = { ok: true; credentials: TableCredentials } | { ok: false; failure: TableFailure };
export type PinTableRuntime = {
  hasConnections(): boolean;
  lastDisconnectedAt(): number;
  isClosed(): boolean;
  close(): Promise<void>;
};
type Table = { pin: string; matchId: string; expiresAt: number;
  runtime: PinTableRuntime; hashes: string[]; attemptHashes: string[] };
type Membership = { matchId: string; viewer: Seat; expiresAt: number };
type JoinAttempt = { pin: string };

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
  const attempts = new Map<string, JoinAttempt>();
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
    for (const hash of table.attemptHashes) attempts.delete(hash);
    await table.runtime.close();
  }
  async function sweep() {
    const now = ports.now();
    for (const table of tables.values()) {
      const connected = table.runtime.hasConnections();
      if (now >= table.expiresAt || (!connected &&
          now - table.runtime.lastDisconnectedAt() >= settings.idleMs) || table.runtime.isClosed()) await remove(table);
    }
  }
  function claim(table: Table, retainedToken?: string): TableResult {
    for (let attempt = 0; attempt < (retainedToken ? 1 : 32); attempt++) {
      const token = retainedToken ?? ports.newToken();
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
        const table: Table = { pin, matchId, expiresAt: now + settings.lifetimeMs,
          runtime, hashes: [], attemptHashes: [] };
        tables.set(pin, table);
        const result = claim(table);
        if (!result.ok) await remove(table);
        return result;
      });
    },
    join(pin: string, attemptId: string): Promise<TableResult> {
      return serialize(async () => {
        if (closed) return unavailable();
        await sweep();
        const table = tables.get(pin);
        if (!table) return { ok: false, failure: { status: 404, error: 'Table not found' } };
        const attemptHash = ports.hash(attemptId);
        const previous = attempts.get(attemptHash);
        if (previous) {
          if (previous.pin !== pin) return { ok: false, failure: { status: 409, error: 'Join attempt already used' } };
          return { ok: true, credentials: { pin, token: attemptId } };
        }
        if (table.hashes.length >= 4) return { ok: false, failure: { status: 409, error: 'Table is full' } };
        const result = claim(table, attemptId);
        if (result.ok) {
          attempts.set(attemptHash, { pin });
          table.attemptHashes.push(attemptHash);
        }
        return result;
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
        tables.clear(); members.clear(); attempts.clear();
        await Promise.all(pending.map(table => table.runtime.close()));
      });
    },
  };
}
