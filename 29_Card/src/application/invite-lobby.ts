import { z } from 'zod';
import { SEATS } from './seat-lifecycle';
import { seatSchema } from '../domain/seats';
import type { LobbyView, SeatClaim, SeatClaimResult } from '../protocol/invitations';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const openingSchema = z.strictObject({ format: z.literal(1), type: z.literal('OPEN'), membershipId: z.string().uuid(),
  matchId: z.string().min(1).max(128), inviteHash: hashSchema, expiresAt: z.number().int().positive().safe(),
  createdAt: z.number().int().nonnegative().safe() });
const claimRecordSchema = z.strictObject({ format: z.literal(1), type: z.literal('CLAIM'), requestId: z.string().uuid(),
  seat: seatSchema, tokenHash: hashSchema, claimedAt: z.number().int().nonnegative().safe() });
const recordSchema = z.discriminatedUnion('type', [openingSchema, claimRecordSchema]);
export type MembershipRecord = z.infer<typeof recordSchema>;
type ClaimRecord = z.infer<typeof claimRecordSchema>;

// Anonymous invite possession grants only lobby access. A successful durable
// claim binds a separate credential hash to a physical seat for this table.
export function createInviteLobby(config: { matchId: string; tokenHash: string; expiresAt: number }, ports: {
  now(): number; newId(): string; hash(token: string): string; equalHash(a: string, b: string): boolean;
  canClaim(): boolean; append(record: MembershipRecord): Promise<void>;
}, archive: unknown = []) {
  const parsed = z.array(recordSchema).max(5).safeParse(archive);
  if (!parsed.success) throw new Error('Invalid membership journal');
  const claims: ClaimRecord[] = [];
  let opening: z.infer<typeof openingSchema> | undefined;
  let lastTime = 0;
  let started = false, failed = false, stopped = false;
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(work: () => Promise<T>) {
    const result = tail.then(async () => {
      if (failed || stopped) throw new Error('Invite lobby unavailable');
      try { return await work(); } catch (error) { failed = true; throw error; }
    });
    tail = result.catch(() => undefined); return result;
  }
  function now() {
    const value = ports.now();
    if (!Number.isSafeInteger(value) || value < lastTime) throw new Error('Invalid membership clock');
    return value;
  }
  function verifyClaim(record: ClaimRecord) {
    if (!opening || record.claimedAt < lastTime || record.claimedAt >= opening.expiresAt ||
        ports.equalHash(record.tokenHash, opening.inviteHash) || claims.some(claim => claim.seat === record.seat ||
          claim.requestId === record.requestId || ports.equalHash(claim.tokenHash, record.tokenHash))) {
      throw new Error('Invalid membership claim');
    }
  }
  return {
    start: () => enqueue(async () => {
      if (started) return;
      if (parsed.data.length === 0) {
        const record = openingSchema.parse({ format: 1, type: 'OPEN', membershipId: ports.newId(), matchId: config.matchId,
          inviteHash: config.tokenHash, expiresAt: config.expiresAt, createdAt: now() });
        if (record.createdAt >= record.expiresAt) throw new Error('Invitation expired');
        await ports.append(structuredClone(record)); opening = record; lastTime = record.createdAt;
      } else {
        for (const record of parsed.data) {
          if (record.type === 'OPEN') {
            if (opening || record.matchId !== config.matchId || record.inviteHash !== config.tokenHash || record.expiresAt !== config.expiresAt ||
                record.createdAt >= record.expiresAt) throw new Error('Membership configuration mismatch');
            opening = record; lastTime = record.createdAt;
          } else { verifyClaim(record); claims.push(record); lastTime = record.claimedAt; }
        }
      }
      if (!opening) throw new Error('Missing membership opening');
      started = true;
    }),
    get membershipId() {
      if (!started || !opening || failed || stopped) throw new Error('Invite lobby unavailable');
      return opening.membershipId;
    },
    authenticate(token: string) {
      const timestamp = ports.now();
      if (!started || !opening || failed || stopped || !Number.isSafeInteger(timestamp) || timestamp < lastTime || timestamp >= opening.expiresAt) return null;
      const hash = ports.hash(token);
      if (ports.equalHash(hash, opening.inviteHash)) return { matchId: config.matchId, viewer: 'guest' as const, expiresAt: opening.expiresAt };
      const claim = claims.find(claim => ports.equalHash(hash, claim.tokenHash));
      return claim ? { matchId: config.matchId, viewer: claim.seat, expiresAt: opening.expiresAt } : null;
    },
    getView(): LobbyView {
      if (!started || !opening || failed || stopped) throw new Error('Invite lobby unavailable');
      return { canClaim: now() < opening.expiresAt && claims.length < 4 && ports.canClaim(), expiresAt: opening.expiresAt,
        seats: SEATS.map(seat => ({ seat, occupied: claims.some(claim => claim.seat === seat) })) };
    },
    claim: (request: SeatClaim): Promise<SeatClaimResult> => enqueue(async () => {
      if (!started || !opening) throw new Error('Invite lobby unavailable');
      const timestamp = now();
      if (timestamp >= opening.expiresAt) return { ok: false, code: 'INVITE_EXPIRED' };
      const tokenHash = ports.hash(request.token);
      const duplicate = claims.find(claim => claim.requestId === request.requestId);
      if (duplicate) return duplicate.seat === request.seat && ports.equalHash(duplicate.tokenHash, tokenHash)
        ? { ok: true, seat: duplicate.seat, expiresAt: opening.expiresAt } : { ok: false, code: 'CLAIM_CONFLICT' };
      if (!ports.canClaim()) return { ok: false, code: 'TABLE_LOCKED' };
      if (claims.some(claim => claim.seat === request.seat)) return { ok: false, code: 'SEAT_TAKEN' };
      if (ports.equalHash(tokenHash, opening.inviteHash) || claims.some(claim => ports.equalHash(claim.tokenHash, tokenHash))) {
        return { ok: false, code: 'CLAIM_CONFLICT' };
      }
      const record: ClaimRecord = { format: 1, type: 'CLAIM', requestId: request.requestId, seat: request.seat, tokenHash, claimedAt: timestamp };
      verifyClaim(record);
      await ports.append(structuredClone(record));
      claims.push(record); lastTime = timestamp;
      return { ok: true, seat: record.seat, expiresAt: opening.expiresAt };
    }),
    async shutdown() { stopped = true; await tail; },
  };
}
