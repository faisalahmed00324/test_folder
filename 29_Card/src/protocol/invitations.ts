import { z } from 'zod';
import { seatSchema } from '../domain/seats';
import { validEndpoint } from './connection';

export const seatTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const inviteConfigSchema = z.strictObject({ tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive().safe(), journalPath: z.string().min(1) });
export const seatClaimSchema = z.strictObject({ requestId: z.string().uuid(), seat: seatSchema, token: seatTokenSchema });
export type SeatClaim = z.infer<typeof seatClaimSchema>;
export const seatClaimResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), seat: seatSchema, expiresAt: z.number().int().positive().safe() }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['SEAT_TAKEN', 'CLAIM_CONFLICT', 'TABLE_LOCKED', 'INVITE_EXPIRED']) }),
]);
export type SeatClaimResult = z.infer<typeof seatClaimResultSchema>;
export const lobbyViewSchema = z.object({ canClaim: z.boolean(), expiresAt: z.number().int().positive().safe(),
  seats: z.array(z.object({ seat: seatSchema, occupied: z.boolean() })).length(4)
    .refine(seats => seats.every((slot, index) => slot.seat === index), 'Expected four ordered seats') });
export type LobbyView = z.infer<typeof lobbyViewSchema>;
const linkSchema = z.strictObject({ invite: seatTokenSchema, server: z.string().max(2048).refine(validEndpoint) });
export type InvitationLink = z.infer<typeof linkSchema>;

export function parseInvitationFragment(fragment: string): InvitationLink | null {
  if (fragment.length > 8192) return null;
  const parameters = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  if ([...parameters.keys()].some(key => !['invite', 'server'].includes(key)) ||
      parameters.getAll('invite').length !== 1 || parameters.getAll('server').length !== 1) return null;
  const parsed = linkSchema.safeParse({ invite: parameters.get('invite'), server: parameters.get('server') });
  return parsed.success ? parsed.data : null;
}
export function invitationURL(page: string, server: string, invite: string): string {
  const parsed = linkSchema.parse({ invite, server });
  const url = new URL(page);
  if (url.pathname !== '/29_Card/index.html' || url.search || url.hash || url.username || url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Expected a secure card-table page URL');
  }
  url.hash = new URLSearchParams(parsed).toString();
  return url.toString();
}
