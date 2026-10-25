import { z } from 'zod';
import { seatSchema, type Seat } from '../domain/seats';

export const lifecycleSettingsSchema = z.strictObject({
  disconnectGraceMs: z.number().int().positive().max(2_147_483_647).default(60_000),
  abandonAfterMs: z.number().int().positive().max(2_147_483_647).default(600_000),
});
export const lifecycleOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('CONNECTION'), seat: seatSchema, connected: z.boolean() }),
  z.strictObject({ type: z.literal('LEAVE'), seat: seatSchema }),
  z.strictObject({ type: z.literal('TAKEOVER'), seat: seatSchema }),
  z.strictObject({ type: z.literal('RECLAIM'), seat: seatSchema }),
  z.strictObject({ type: z.literal('RESTART_DISCONNECT') }),
]);
export type LifecycleOperation = z.infer<typeof lifecycleOperationSchema>;
export type LifecycleSettings = z.infer<typeof lifecycleSettingsSchema>;
export type SeatPresence = {
  connected: boolean;
  disconnectedAt: number | null;
  controller: 'human' | 'bot';
  reclaimAfter: number | null;
};
export type LifecycleState = {
  seats: SeatPresence[];
  decision: number;
  bot: { seat: Seat; version: number; deadline: number } | null;
};
export type PresenceEvent =
  | { type: 'PLAYER_DISCONNECTED' | 'PLAYER_RECONNECTED' | 'BOT_TOOK_OVER' | 'PLAYER_RECLAIMED'; seat: Seat };

export const SEATS: readonly Seat[] = [0, 1, 2, 3];
