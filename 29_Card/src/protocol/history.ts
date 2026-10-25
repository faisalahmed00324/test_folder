import { z } from 'zod';
import { cardIdSchema, suitSchema } from '../domain/cards';
import { seatSchema } from '../domain/seats';

const natural = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const scores = z.object({ A: z.number().int(), B: z.number().int() });
const team = z.enum(['A', 'B']);
export const publicHandSummarySchema = z.object({
  declarer: seatSchema, declaringTeam: team, declaringPoints: natural, defendingPoints: natural,
  originalContract: natural, effectiveContract: natural, made: z.boolean(), delta: z.number().int(),
  stakeMultiplier: z.union([z.literal(1), z.literal(2), z.literal(4)]),
  pair: z.object({ seat: seatSchema, team }).nullable(),
  trumpSuit: suitSchema, indicatorCard: cardIdSchema.nullable(),
  tricks: z.array(z.object({ index: z.number().int().min(1).max(8), leader: seatSchema, winner: seatSchema, points: natural,
    plays: z.array(z.object({ seat: seatSchema, card: cardIdSchema })).length(4) })).length(8),
});
export type PublicHandSummary = z.infer<typeof publicHandSummarySchema>;
const entry = z.object({ index: positive, matchNumber: positive, timestamp: natural, gameScores: scores });
export const historyEntrySchema = z.discriminatedUnion('kind', [
  entry.extend({ kind: z.literal('HAND'), handNumber: positive, dealNumber: positive, summary: publicHandSummarySchema }),
  entry.extend({ kind: z.literal('MATCH'), winner: team.nullable(), abandoned: z.boolean(), handsPlayed: natural }),
]);
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export const historyQuerySchema = z.strictObject({ before: positive.optional(), limit: z.number().int().min(1).max(20).default(10) });
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export const historyPageSchema = z.object({ entries: z.array(historyEntrySchema).max(20), nextBefore: positive.nullable(),
  earliestAvailable: positive.nullable(), total: natural, truncated: z.boolean() });
export type HistoryPage = z.infer<typeof historyPageSchema>;
export const historyRequestSchema = historyQuerySchema.extend({ type: z.literal('GET_HISTORY'), requestId: z.string().uuid() });
