import { cardPoints, type CardId } from './cards';
import type { HandContract } from './pair';
import type { PlayState, CompletedTrick } from './play';
import { teamForSeat, type Team } from './seats';

export interface HandSummary extends HandContract {
  readonly declarer: PlayState['declarer'];
  readonly declaringTeam: Team;
  readonly declaringPoints: number;
  readonly defendingPoints: number;
  readonly capturedPoints: Readonly<Record<Team, number>>;
  readonly trumpSuit: PlayState['trumpSuit'];
  readonly indicatorCard: CardId | null;
  readonly tricks: readonly CompletedTrick[];
  readonly stakeMultiplier: 1 | 2 | 4;
  readonly made: boolean;
  readonly delta: number;
}

export function scoreHand(play: PlayState, contract: HandContract, stakeMultiplier: 1 | 2 | 4): HandSummary {
  if (play.phase !== 'COMPLETE' || play.completedTricks.length !== 8 || play.concealed !== null ||
      play.currentTrick.plays.length !== 0 || Object.values(play.hands).some(hand => hand.length !== 0)) {
    throw new RangeError('Only a fully played hand can be scored');
  }
  const cards = play.completedTricks.flatMap(trick => trick.plays.map(play => play.card));
  if (cards.length !== 32 || new Set(cards).size !== 32 ||
      play.capturedPoints.A + play.capturedPoints.B !== play.ruleset.totalPoints) {
    throw new RangeError('Scored hand must conserve cards and points');
  }
  const captured = { A: 0, B: 0 };
  for (const [index, trick] of play.completedTricks.entries()) {
    const expectedPoints = trick.plays.reduce((sum, entry) => sum + cardPoints(entry.card), 0) +
      (index === 7 ? play.ruleset.lastTrickBonus : 0);
    if (trick.index !== index + 1 || trick.plays.length !== 4 ||
        new Set(trick.plays.map(entry => entry.seat)).size !== 4 || trick.points !== expectedPoints) {
      throw new RangeError('Completed trick invariants failed');
    }
    captured[teamForSeat(trick.winner)] += trick.points;
  }
  if (captured.A !== play.capturedPoints.A || captured.B !== play.capturedPoints.B) {
    throw new RangeError('Captured totals do not match trick history');
  }
  if (![1, 2, 4].includes(stakeMultiplier) || (!play.ruleset.doubling.enabled && stakeMultiplier !== 1)) {
    throw new RangeError('Stake multiplier is not supported');
  }
  const band = play.ruleset.scoreBands.find(band => contract.originalContract >= band.from && contract.originalContract <= band.to);
  if (!band || !Number.isInteger(contract.originalContract) || contract.effectiveContract < play.ruleset.minBid || contract.effectiveContract > play.ruleset.maxBid ||
      !Number.isInteger(contract.effectiveContract) || (!play.ruleset.pair.enabled && contract.effectiveContract !== contract.originalContract)) {
    throw new RangeError('Contract is outside the supported range');
  }
  const declaringTeam = teamForSeat(play.declarer);
  const declaringPoints = play.capturedPoints[declaringTeam];
  const made = declaringPoints >= contract.effectiveContract;
  return { ...contract, declarer: play.declarer, declaringTeam, declaringPoints,
    defendingPoints: play.ruleset.totalPoints - declaringPoints, capturedPoints: play.capturedPoints,
    trumpSuit: play.trumpSuit, indicatorCard: play.initialIndicatorCard, tricks: play.completedTricks,
    stakeMultiplier, made, delta: made ? band.win * stakeMultiplier : -band.loss * stakeMultiplier };
}
