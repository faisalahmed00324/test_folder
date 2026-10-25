import { cardPoints, createDeck } from './cards';
import type { EngineState } from './engine';
import { nextSeat, teamForSeat, type Seat } from './seats';

const CARD_IDS = createDeck();

// Throws on trusted-state defects. The future actor must log an incident and void
// the deal before broadcasting; never turn this into a player-visible error dump.
export function assertEngineInvariants(state: EngineState): void {
  const require = (condition: boolean, message: string) => { if (!condition) throw new Error(`Invariant: ${message}`); };
  const progress = state.progress;
  require(Number.isInteger(state.version) && state.version >= 0, 'version');
  require(Number.isFinite(state.lastCommandTime) && state.lastCommandTime >= 0, 'time');
  require(progress.handNumber >= 1 && progress.dealNumber >= progress.handNumber, 'hand/deal numbers');
  require(Number.isInteger(progress.gameScores.A) && Number.isInteger(progress.gameScores.B), 'game scores');
  require((progress.status === 'FINISHED') === (progress.winner !== null), 'winner/status');
  if (progress.status !== 'IN_PROGRESS' || state.phase === 'AWAITING_DEAL') {
    require(state.auction === null && state.trump === null && state.play === null && state.contract === null &&
      state.doubling === null && state.pairWindow === null && progress.firstPacket === null, 'inactive hand cleared');
    require(state.phase === (progress.status === 'IN_PROGRESS' ? 'AWAITING_DEAL' : progress.status), 'terminal phase');
    return;
  }
  require(progress.firstPacket !== null, 'active deal');
  const play = state.play;
  const deal = state.trump?.deal ?? progress.firstPacket!;
  const hands = play?.hands ?? deal.hands;
  const concealed = play ? play.concealed : state.trump?.concealed;
  const undealt = play ? [] : deal.deck.slice(deal.dealtCount);
  const history = play?.completedTricks ?? [];
  const current = play?.currentTrick.plays ?? [];
  const cards = [...Object.values(hands).flat(), ...undealt,
    ...(concealed?.card ? [concealed.card] : []), ...current.map(entry => entry.card),
    ...history.flatMap(trick => trick.plays.map(entry => entry.card))];
  require(cards.length === 32 && new Set(cards).size === 32 && CARD_IDS.every(card => cards.includes(card)), 'card locations');
  for (const seat of [0, 1, 2, 3] as const) {
    const played = [...current, ...history.flatMap(trick => trick.plays)].filter(entry => entry.seat === seat).length;
    const held = hands[seat].length + (concealed?.owner === seat && concealed.card !== null ? 1 : 0);
    require(held + played === (deal.dealtCount === 16 ? 4 : 8), 'cards per seat');
  }
  if (state.contract !== null) {
    const { originalContract, effectiveContract, pair } = state.contract;
    require(Number.isInteger(originalContract) && originalContract >= progress.ruleset.minBid && originalContract <= progress.ruleset.maxBid, 'original contract');
    require(Number.isInteger(effectiveContract) && effectiveContract >= progress.ruleset.minBid && effectiveContract <= progress.ruleset.maxBid, 'effective contract');
    if (pair === null || !progress.ruleset.pair.enabled) require(effectiveContract === originalContract, 'unadjusted contract');
  }
  if (play !== null) {
    require(state.phase === 'PLAY' || state.phase === 'PAIR_WINDOW', 'play phase');
    require(play.phase !== 'COMPLETE', 'completed play must score');
    require(play.reveal === null || play.concealed === null, 'revealed concealed card returned');
    const captured = { A: 0, B: 0 };
    for (const [index, trick] of history.entries()) {
      require(trick.index === index + 1 && trick.plays.length === 4, 'trick size/index');
      require(trick.points === trick.plays.reduce((sum, entry) => sum + cardPoints(entry.card), 0), 'trick points');
      captured[teamForSeat(trick.winner)] += trick.points;
      let seat: Seat = trick.leader;
      for (const entry of trick.plays) { require(entry.seat === seat, 'trick order'); seat = nextSeat(seat, progress.ruleset.direction); }
      if (index > 0) require(trick.leader === history[index - 1].winner, 'winner leads');
    }
    require(captured.A === play.capturedPoints.A && captured.B === play.capturedPoints.B, 'captured points');
    let seat: Seat = play.currentTrick.leader;
    for (const entry of current) { require(entry.seat === seat, 'current order'); seat = nextSeat(seat, progress.ruleset.direction); }
    if (play.phase === 'PLAY') require(play.toAct === seat, 'player to act');
    require(captured.A + captured.B + [...Object.values(hands).flat(), ...current.map(entry => entry.card),
      ...(concealed?.card ? [concealed.card] : [])].reduce((sum, card) => sum + cardPoints(card), 0) === 28, 'point conservation');
  }
  if (state.phase === 'PAIR_WINDOW') require(state.pairWindow?.status === 'OPEN' && play?.phase === 'TRICK_COMPLETE' &&
    JSON.stringify(state.pairWindow.play) === JSON.stringify(play), 'pair window');
  if (state.phase === 'AUCTION' || state.phase === 'SECOND_ROUND') require(state.auction?.status === 'BIDDING' && state.auction.toAct !== null, 'auction decision');
  if (state.phase === 'DOUBLING') require(state.doubling !== null && state.doubling.stage !== 'DONE', 'doubling decision');
  if (state.phase === 'TRUMP_SELECTION' || state.phase === 'TRUMP_RESELECTION') require(state.trump?.phase === state.phase, 'trump selection decision');
}
