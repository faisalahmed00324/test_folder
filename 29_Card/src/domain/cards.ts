import { z } from 'zod';

export const suitSchema = z.enum(['C', 'D', 'H', 'S']);
const RANKS = ['J', '9', 'A', 'T', 'K', 'Q', '8', '7'] as const;
export const rankSchema = z.enum(RANKS);
export const cardIdSchema = z.templateLiteral([rankSchema, suitSchema]);

export type Suit = z.infer<typeof suitSchema>;
export type Rank = z.infer<typeof rankSchema>;
export type CardId = z.infer<typeof cardIdSchema>;

export const deckSchema = z.array(cardIdSchema).length(32)
  .refine(cards => new Set(cards).size === 32, 'Deck must contain 32 unique cards')
  .readonly().brand<'Deck'>();
export type Deck = z.infer<typeof deckSchema>;

const STRENGTH: Readonly<Record<Rank, number>> = {
  J: 8, '9': 7, A: 6, T: 5, K: 4, Q: 3, '8': 2, '7': 1,
};
const POINTS: Readonly<Record<Rank, number>> = {
  J: 3, '9': 2, A: 1, T: 1, K: 0, Q: 0, '8': 0, '7': 0,
};

export function createDeck(): Deck {
  return deckSchema.parse(suitSchema.options.flatMap(suit =>
    RANKS.map(rank => `${rank}${suit}`)));
}

export function cardSuit(card: CardId): Suit {
  return card[1] as Suit;
}

export function cardStrength(card: CardId): number {
  return STRENGTH[card[0] as Rank];
}

export function cardPoints(card: CardId): number {
  return POINTS[card[0] as Rank];
}
