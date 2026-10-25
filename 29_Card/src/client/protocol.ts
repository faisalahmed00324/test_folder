import { z } from 'zod';
import { cardIdSchema, suitSchema } from '../domain/cards';
import { seatSchema } from '../domain/seats';
import { playerActionSchema } from '../protocol/player-command';
import { tableStateSchema } from '../application/table-session';
import { publicHandSummarySchema, historyPageSchema } from '../protocol/history';
import { chatViewSchema, chatMessageSchema } from '../protocol/quick-chat';
import { lobbyViewSchema, seatClaimResultSchema } from '../protocol/invitations';
export { validEndpoint } from '../protocol/connection';

const natural = z.number().int().nonnegative().safe();
const scores = z.object({ A: z.number().int(), B: z.number().int() });
const viewerSchema = z.union([seatSchema, z.literal('spectator')]);
const trickSchema = z.object({ index: z.number().int().min(1).max(8), leader: seatSchema,
  plays: z.array(z.object({ seat: seatSchema, card: cardIdSchema })).max(4) });
const completedTrickSchema = trickSchema.extend({ winner: seatSchema, points: natural.optional() });
// Intentionally project only fields rendered by this client. Unused protocol
// fields are stripped at this boundary; no server state or event reducer is used.
export const snapshotSchema = z.object({
  viewer: viewerSchema, version: natural,
  phase: z.enum(['AWAITING_DEAL', 'REDEAL_WINDOW', 'AUCTION', 'SECOND_ROUND', 'TRUMP_SELECTION',
    'TRUMP_RESELECTION', 'DOUBLING', 'PLAY', 'PAIR_WINDOW', 'FINISHED', 'ABANDONED']),
  status: z.enum(['IN_PROGRESS', 'FINISHED', 'ABANDONED']),
  ruleset: z.object({ rulesetId: z.string().max(128), direction: z.enum(['clockwise', 'counterclockwise']) }),
  dealer: seatSchema, handNumber: natural, dealNumber: natural, gameScores: scores,
  winner: z.enum(['A', 'B']).nullable(), myHand: z.array(cardIdSchema).max(8),
  handCounts: z.object({ '0': natural, '1': natural, '2': natural, '3': natural }),
  concealedOwner: seatSchema.nullable(), trumpSuit: suitSchema.optional(), myConcealedCard: cardIdSchema.optional(),
  declarer: seatSchema.nullable(), stakeMultiplier: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  contract: z.object({ originalContract: natural, effectiveContract: natural }).nullable(),
  auction: z.object({ round: z.union([z.literal(1), z.literal(2)]), current: z.number().int().nullable(),
    history: z.array(z.object({ seat: seatSchema, action: z.enum(['BID', 'HOLD', 'PASS']),
      amount: z.number().int().optional(), auto: z.boolean() })).max(512) }).nullable(),
  toAct: seatSchema.nullable(), legalActions: z.array(playerActionSchema).max(64),
  deadline: natural.nullable(), remainingMs: natural, timeBankMs: natural.nullable(),
  currentTrick: trickSchema.nullable(), completedTricks: z.array(completedTrickSchema).max(8),
  capturedPoints: scores.optional(), reveal: z.object({ by: z.union([seatSchema, z.literal('system')]),
    trickIndex: natural, position: natural }).nullable(),
  summary: publicHandSummarySchema.nullable(),
  seats: z.array(z.object({ connected: z.boolean(), controller: z.enum(['human', 'bot']), reclaimPending: z.boolean() })).length(4).optional(),
  table: tableStateSchema.optional(),
  chat: chatViewSchema.optional(),
});
const matchId = z.string().min(1).max(128);
const eventSchema = z.object({ matchId, seq: natural, version: natural, eventId: z.string().max(512),
  timestamp: natural, event: z.object({ type: z.string().min(1).max(64), summary: publicHandSummarySchema.optional(), message: chatMessageSchema.optional() }) })
  .refine(entry => (entry.event.type !== 'HAND_SCORED' || entry.event.summary !== undefined) &&
    (entry.event.type !== 'CHAT_MESSAGE' || entry.event.message !== undefined), 'Missing public event payload');
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('WELCOME'), protocolVersion: z.literal(1), matchId, viewer: z.union([viewerSchema, z.literal('guest')]) }),
  z.object({ type: z.literal('SNAPSHOT'), matchId, seq: natural, snapshot: snapshotSchema }),
  z.object({ type: z.literal('EVENTS'), matchId, events: z.array(eventSchema).max(1024) }),
  z.object({ type: z.literal('REPLAY'), matchId, seq: natural, events: z.array(eventSchema).max(1024) }),
  z.object({ type: z.literal('RESULT'), commandId: z.string().uuid().nullable(), ok: z.boolean(), version: natural,
    code: z.string().max(128).optional(), snapshot: snapshotSchema.optional(), chatMessageId: z.string().max(256).optional() }),
  z.object({ type: z.literal('ERROR'), code: z.string().max(128) }),
  z.object({ type: z.literal('LEFT_TABLE'), matchId }),
  z.object({ type: z.literal('HISTORY'), matchId, requestId: z.string().uuid(), page: historyPageSchema }),
  z.object({ type: z.literal('LOBBY'), matchId, lobby: lobbyViewSchema }),
  z.object({ type: z.literal('SEAT_RESULT'), matchId, requestId: z.string().uuid(), result: seatClaimResultSchema }),
]);
export type TableSnapshot = z.infer<typeof snapshotSchema>;

export function parseServerMessage(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 256 * 1024) return null;
  try {
    const result = serverMessageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch { return null; }
}
