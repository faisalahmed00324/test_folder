import { defaultTrumpSelection, weakestPlayAction } from '../domain/decision-policy';
import type { engineView, EngineAction } from '../domain/engine';
import type { PlayAction } from '../domain/play';

// Only a player-visible snapshot crosses the bot boundary.
export function baselineBotAction(view: ReturnType<typeof engineView>): EngineAction | null {
  const legal = view.legalActions;
  if (legal.length === 0) return null;
  switch (view.phase) {
    case 'AUCTION': case 'SECOND_ROUND':
      return legal.find(action => action.type === 'PASS') ??
        legal.find(action => action.type === 'BID' && action.amount === view.ruleset.minBid) ?? null;
    case 'DOUBLING': return legal.find(action => action.type === 'PASS_DOUBLE') ?? null;
    case 'TRUMP_SELECTION': case 'TRUMP_RESELECTION':
      return { type: 'SELECT_TRUMP', payload: defaultTrumpSelection(view.myHand, view.ruleset.trumpIndicator) };
    case 'PLAY':
      return weakestPlayAction(legal.filter((action): action is PlayAction =>
        action.type === 'PLAY_CARD' || action.type === 'CALL_TRUMP' || action.type === 'REVEAL_TRUMP'));
    case 'PAIR_WINDOW': return legal.find(action => action.type === 'DECLARE_PAIR') ?? null;
    default: return null;
  }
}
