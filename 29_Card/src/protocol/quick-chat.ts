import { z } from 'zod';
import { seatSchema } from '../domain/seats';

export const QUICK_CHAT_PHRASES = Object.freeze({
  GOOD_LUCK: 'Good luck', WELL_PLAYED: 'Well played', OOPS: 'Oops', THANKS: 'Thanks',
});
export const CHAT_COOLDOWN_MS = 2000;
export const phraseIdSchema = z.enum(['GOOD_LUCK', 'WELL_PLAYED', 'OOPS', 'THANKS']);
export type PhraseId = z.infer<typeof phraseIdSchema>;
export const quickChatActionSchema = z.strictObject({ type: z.literal('QUICK_CHAT'), phraseId: phraseIdSchema });
export const chatMessageSchema = z.object({ id: z.string().min(1).max(256), seat: seatSchema,
  phraseId: phraseIdSchema, timestamp: z.number().int().nonnegative().safe() });
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export const chatViewSchema = z.object({ canSend: z.boolean(), remainingMs: z.number().int().nonnegative().max(CHAT_COOLDOWN_MS),
  cooldownStartedAt: z.number().int().nonnegative().safe().nullable().optional(), messages: z.array(chatMessageSchema).max(20) });
export type ChatView = z.infer<typeof chatViewSchema>;
