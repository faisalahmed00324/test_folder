import { z } from 'zod';
import { directionSchema } from './seats';

const secondRoundSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({ enabled: z.literal(true), minBid: z.number().int().positive() }),
]);
const doublingSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    timing: z.enum(['afterFullDeal', 'beforeSecondDeal']),
    stakes: z.tuple([z.literal(1), z.literal(2), z.literal(4)]),
  }),
]);
const pairSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    adjustment: z.number().int().positive(),
    floor: z.number().int().positive(),
    ceiling: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  }),
]);

export const rulesetSchema = z.strictObject({
  rulesetId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  direction: directionSchema,
  lastTrickBonus: z.union([z.literal(0), z.literal(1)]),
  minBid: z.number().int().positive(),
  auctionStyle: z.enum(['priorityDuel', 'openAscending']),
  openingBidForced: z.boolean(),
  allPassPolicy: z.literal('redealSameDealer'),
  partnerOverbidMin: z.number().int().positive().nullable(),
  secondRound: secondRoundSchema,
  trumpIndicator: z.enum(['faceDownCard', 'external']),
  seventhCardTrump: z.boolean(),
  revealPolicy: z.enum(['optionalOnVoid', 'mandatoryOnFirstVoid']),
  callerMustTrump: z.boolean(),
  declarerRevealPlay: z.enum(['anyTrump', 'anyCard', 'indicatorCard']),
  declarerMayLeadHiddenTrump: z.boolean(),
  revealTrickSemantics: z.enum(['fromRevealPosition', 'wholeTrick']),
  doubling: doublingSchema,
  pair: pairSchema,
  scoreBands: z.array(z.strictObject({
    from: z.number().int().positive(),
    to: z.number().int().positive(),
    win: z.number().int().positive(),
    loss: z.number().int().positive(),
  })).min(1),
  matchEnd: z.strictObject({
    winAt: z.number().int().positive(),
    loseAt: z.number().int().negative(),
  }),
  redealOnPointlessFour: z.boolean(),
  redealDealer: z.enum(['sameDealer', 'rotate']),
}).superRefine((cfg, ctx) => {
  const maxBid = 28 + cfg.lastTrickBonus;
  const reject = (path: string[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

  if (cfg.minBid > maxBid) reject(['minBid'], 'Minimum bid exceeds total points');
  if (cfg.partnerOverbidMin !== null &&
      (cfg.partnerOverbidMin < cfg.minBid || cfg.partnerOverbidMin > maxBid)) {
    reject(['partnerOverbidMin'], 'Partner overbid minimum must be within the bid range');
  }
  if ((cfg.declarerRevealPlay === 'indicatorCard' || cfg.seventhCardTrump) &&
      cfg.trumpIndicator !== 'faceDownCard') {
    reject(['trumpIndicator'], 'Indicator-card play and seventh-card trump require a face-down card');
  }
  if (cfg.declarerRevealPlay === 'anyTrump' && cfg.trumpIndicator === 'external') {
    reject(['declarerRevealPlay'], 'Any-trump play requires a face-down card to guarantee a legal trump');
  }
  if (cfg.secondRound.enabled) {
    if (cfg.secondRound.minBid <= cfg.minBid || cfg.secondRound.minBid > maxBid) {
      reject(['secondRound', 'minBid'], 'Second-round minimum must exceed minBid and not exceed maxBid');
    }
    if (cfg.auctionStyle !== 'openAscending' || cfg.trumpIndicator !== 'faceDownCard' ||
        cfg.seventhCardTrump || cfg.doubling.enabled) {
      reject(['secondRound'], 'Second round currently supports ascending, face-down, non-seventh-card, undoubled rules only');
    }
  }
  if (cfg.pair.enabled && (cfg.pair.floor < cfg.minBid || cfg.pair.ceiling > maxBid ||
      cfg.pair.floor > cfg.pair.ceiling)) {
    reject(['pair'], 'Pair bounds must be ordered and within the bid range');
  }

  const coverage = new Array<number>(maxBid + 1).fill(0);
  for (const band of cfg.scoreBands) {
    if (band.from < cfg.minBid || band.to > maxBid || band.from > band.to) {
      reject(['scoreBands'], 'Score band must be ordered and within the bid range');
      continue;
    }
    for (let bid = band.from; bid <= band.to; bid++) coverage[bid]++;
  }
  if (coverage.slice(cfg.minBid).some(count => count !== 1)) {
    reject(['scoreBands'], 'Score bands must cover every legal bid exactly once');
  }
}).transform(cfg => Object.freeze({
  ...cfg,
  secondRound: Object.freeze(cfg.secondRound),
  doubling: Object.freeze(cfg.doubling.enabled
    ? { ...cfg.doubling, stakes: Object.freeze(cfg.doubling.stakes) }
    : cfg.doubling),
  pair: Object.freeze(cfg.pair),
  scoreBands: Object.freeze(cfg.scoreBands.map(band => Object.freeze(band))),
  matchEnd: Object.freeze(cfg.matchEnd),
  totalPoints: 28 + cfg.lastTrickBonus,
  maxBid: 28 + cfg.lastTrickBonus,
}));

export type RulesetConfig = z.infer<typeof rulesetSchema>;
