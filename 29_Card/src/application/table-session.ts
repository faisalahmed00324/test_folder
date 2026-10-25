import { z } from 'zod';
import { SEATS } from './seat-lifecycle';
import type { Seat } from '../domain/seats';
import type { TableAction } from '../protocol/player-command';

export const tableSettingsSchema = z.strictObject({
  readyMs: z.number().int().positive().max(2_147_483_647).default(15_000),
  rematchMs: z.number().int().positive().max(2_147_483_647).default(20_000),
});
export const tableStateSchema = z.strictObject({
  phase: z.enum(['WAITING', 'READY_CHECK', 'PLAYING', 'REMATCH', 'CLOSED']),
  checkId: z.number().int().nonnegative().safe(), matchNumber: z.number().int().positive().safe(),
  ready: z.tuple([z.boolean(), z.boolean(), z.boolean(), z.boolean()]),
  votes: z.tuple([z.boolean().nullable(), z.boolean().nullable(), z.boolean().nullable(), z.boolean().nullable()]),
  deadline: z.number().int().nonnegative().safe().nullable(),
});
export type TableState = z.infer<typeof tableStateSchema>;
export type TableSettings = z.infer<typeof tableSettingsSchema>;
export const emptyReady = (): TableState['ready'] => [false, false, false, false];
const emptyVotes = (): TableState['votes'] => [null, null, null, null];
export function createTableSession(): TableState {
  return { phase: 'WAITING', checkId: 0, matchNumber: 1, ready: emptyReady(), votes: emptyVotes(), deadline: null };
}

// Only originally provisioned bots count as ready by default. A disconnect bot
// cannot cast consent on behalf of the human who owns that seat.
export function reconcileTable(table: TableState, connected: readonly boolean[], bots: readonly boolean[],
  finished: boolean, now: number, settings: TableSettings): TableState {
  const next = structuredClone(table);
  const filled = SEATS.every(seat => bots[seat] || connected[seat]);
  if (next.phase === 'PLAYING' && finished) {
    next.phase = 'REMATCH'; next.checkId++; next.deadline = now + settings.rematchMs;
    next.votes = emptyVotes();
    for (const seat of SEATS) if (bots[seat]) next.votes[seat] = true;
  } else if (next.phase === 'READY_CHECK' && !filled) {
    next.phase = 'WAITING'; next.deadline = null; next.ready = emptyReady();
  } else if (next.phase === 'WAITING' && filled) {
    next.phase = 'READY_CHECK'; next.checkId++; next.deadline = now + settings.readyMs;
    next.ready = bots.map(Boolean) as TableState['ready'];
  }
  if (next.phase === 'REMATCH') for (const seat of SEATS) if (!bots[seat] && !connected[seat]) next.votes[seat] = null;
  return next;
}

export function applyTableAction(table: TableState, seat: Seat, action: TableAction, checkId: number,
  connected: readonly boolean[], bots: readonly boolean[], now: number):
  { ok: true; table: TableState } | { ok: false; code: string } {
  if (checkId !== table.checkId) return { ok: false, code: 'STALE_CHECK' };
  if (bots[seat] || !connected[seat]) return { ok: false, code: 'SEAT_NOT_CONNECTED' };
  if (table.deadline !== null && now >= table.deadline) return { ok: false, code: 'CHECK_EXPIRED' };
  const next = structuredClone(table);
  if (action.type === 'READY') {
    if (next.phase !== 'READY_CHECK') return { ok: false, code: 'WRONG_PHASE' };
    next.ready[seat] = true;
    if (SEATS.every(seat => bots[seat] || (connected[seat] && next.ready[seat]))) {
      next.phase = 'PLAYING'; next.deadline = null;
    }
  } else {
    if (next.phase !== 'REMATCH') return { ok: false, code: 'WRONG_PHASE' };
    next.votes[seat] = action.accept;
    if (!action.accept) { next.phase = 'CLOSED'; next.deadline = null; }
    else if (SEATS.every(seat => bots[seat] || (connected[seat] && next.votes[seat] === true))) {
      next.phase = 'PLAYING'; next.matchNumber++; next.deadline = null; next.ready = emptyReady();
    }
  }
  return { ok: true, table: next };
}

export function expireTable(table: TableState, now: number): { table: TableState; removed: Seat[] } {
  if (table.deadline === null || now < table.deadline) throw new Error('Table deadline not due');
  const next = structuredClone(table);
  const removed = table.phase === 'READY_CHECK' ? SEATS.filter(seat => !table.ready[seat]) : [];
  if (table.phase === 'READY_CHECK') { next.phase = 'WAITING'; next.ready = emptyReady(); }
  else if (table.phase === 'REMATCH') next.phase = 'CLOSED';
  else throw new Error('No table window to expire');
  next.deadline = null;
  return { table: next, removed };
}
