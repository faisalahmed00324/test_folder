import { z } from 'zod';
import { auctionActionSchema } from '../domain/auction';
import { doublingActionSchema } from '../domain/doubling';
import { playActionSchema } from '../domain/play';
import { trumpSelectionSchema } from '../domain/trump';
import { quickChatActionSchema } from './quick-chat';

const gameActionSchema = z.union([
  auctionActionSchema, doublingActionSchema, playActionSchema,
  z.strictObject({ type: z.literal('SELECT_TRUMP'), payload: trumpSelectionSchema }),
  z.strictObject({ type: z.literal('DECLARE_PAIR') }),
  z.strictObject({ type: z.literal('REQUEST_REDEAL') }),
]);
export const tableActionSchema = z.union([
  z.strictObject({ type: z.literal('READY') }),
  z.strictObject({ type: z.literal('REMATCH_VOTE'), accept: z.boolean() }),
]);
export type TableAction = z.infer<typeof tableActionSchema>;
export const playerActionSchema = z.union([gameActionSchema, tableActionSchema, quickChatActionSchema]);
const gameCommandSchema = z.strictObject({
  commandId: z.string().uuid(), matchId: z.string().min(1).max(128),
  expectedVersion: z.number().int().nonnegative(), action: gameActionSchema,
});
export const commandSchema = z.union([gameCommandSchema,
  gameCommandSchema.extend({ action: quickChatActionSchema }), gameCommandSchema.extend({
  expectedCheckId: z.number().int().nonnegative().safe(), action: tableActionSchema,
})]);
export type PlayerAction = z.infer<typeof playerActionSchema>;
export type PlayerCommand = z.infer<typeof commandSchema>;
