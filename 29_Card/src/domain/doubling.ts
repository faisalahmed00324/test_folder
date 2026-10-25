import { z } from 'zod';
import type { RulesetConfig } from './ruleset';
import { nextSeat, partnerSeat, type Seat } from './seats';

export const doublingActionSchema = z.strictObject({ type: z.enum(['DOUBLE', 'REDOUBLE', 'PASS_DOUBLE']) });
export type DoublingAction = z.infer<typeof doublingActionSchema>;

export interface DoublingState {
  readonly declarer: Seat;
  readonly stage: 'DOUBLE' | 'REDOUBLE' | 'DONE';
  readonly remaining: readonly Seat[];
  readonly toAct: Seat | null;
  readonly stakeMultiplier: 1 | 2 | 4;
  readonly doubledBy: Seat | null;
  readonly redoubledBy: Seat | null;
}
export interface DoublingEvent {
  readonly type: 'DOUBLED' | 'REDOUBLED' | 'DOUBLE_PASSED';
  readonly seat: Seat;
  readonly stakeMultiplier: 1 | 2 | 4;
  readonly auto: boolean;
}
export type DoublingResult =
  | { readonly ok: true; readonly state: DoublingState; readonly events: readonly DoublingEvent[] }
  | { readonly ok: false; readonly state: DoublingState; readonly events: readonly [];
      readonly code: 'WRONG_PHASE' | 'NOT_YOUR_TURN' | 'DOUBLE_NOT_ALLOWED' };

export function createDoubling(ruleset: RulesetConfig, declarer: Seat): DoublingState {
  const defender = nextSeat(declarer, ruleset.direction);
  const remaining = ruleset.doubling.enabled ? [defender, partnerSeat(defender)] : [];
  return { declarer, stage: ruleset.doubling.enabled ? 'DOUBLE' : 'DONE', remaining,
    toAct: remaining[0] ?? null, stakeMultiplier: 1, doubledBy: null, redoubledBy: null };
}

export function legalDoublingActions(state: DoublingState): readonly DoublingAction[] {
  return state.stage === 'DONE' ? [] : [{ type: state.stage }, { type: 'PASS_DOUBLE' }];
}

export function applyDoublingAction(state: DoublingState, seat: Seat, action: DoublingAction, auto = false): DoublingResult {
  const reject = (code: 'WRONG_PHASE' | 'NOT_YOUR_TURN' | 'DOUBLE_NOT_ALLOWED'): DoublingResult =>
    ({ ok: false, state, events: [], code });
  if (state.stage === 'DONE') return reject('WRONG_PHASE');
  if (seat !== state.toAct) return reject('NOT_YOUR_TURN');
  if (action.type !== 'PASS_DOUBLE' && action.type !== state.stage) return reject('DOUBLE_NOT_ALLOWED');
  const next = { ...state };
  let type: DoublingEvent['type'];
  if (action.type === 'PASS_DOUBLE') {
    type = 'DOUBLE_PASSED';
    next.remaining = state.remaining.slice(1);
  } else if (action.type === 'DOUBLE') {
    type = 'DOUBLED';
    next.stakeMultiplier = 2;
    next.doubledBy = seat;
    next.stage = 'REDOUBLE';
    next.remaining = [state.declarer, partnerSeat(state.declarer)];
  } else {
    type = 'REDOUBLED';
    next.stakeMultiplier = 4;
    next.redoubledBy = seat;
    next.remaining = [];
  }
  next.toAct = next.remaining[0] ?? null;
  if (next.toAct === null) next.stage = 'DONE';
  return { ok: true, state: next, events: [{ type, seat, stakeMultiplier: next.stakeMultiplier, auto }] };
}

export function applyDoublingTimeout(state: DoublingState): DoublingResult {
  if (state.toAct === null) return { ok: false, state, events: [], code: 'WRONG_PHASE' };
  return applyDoublingAction(state, state.toAct, { type: 'PASS_DOUBLE' }, true);
}
