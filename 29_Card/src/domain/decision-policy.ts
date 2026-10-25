import { cardPoints, cardStrength, cardSuit, suitSchema, type CardId } from './cards';
import type { PlayAction } from './play';

export function weakestPlayAction(legal: readonly PlayAction[]): PlayAction {
  const cards = legal.filter((action): action is Extract<PlayAction, { type: 'PLAY_CARD' }> => action.type === 'PLAY_CARD');
  cards.sort((a, b) => cardStrength(a.cardId) - cardStrength(b.cardId) ||
    'CDHS'.indexOf(cardSuit(a.cardId)) - 'CDHS'.indexOf(cardSuit(b.cardId)));
  const action = cards[0] ?? legal[0];
  if (!action) throw new Error('No legal play decision');
  return action;
}

export function defaultTrumpSelection(hand: readonly CardId[], indicator: 'external' | 'faceDownCard') {
  if (hand.length === 0) throw new Error('Trump selection requires cards');
  const suits = suitSchema.options.map(suit => {
    const cards = hand.filter(card => cardSuit(card) === suit);
    return { suit, cards, points: cards.reduce((sum, card) => sum + cardPoints(card), 0),
      highest: Math.max(0, ...cards.map(cardStrength)) };
  });
  suits.sort((a, b) => b.points - a.points || b.cards.length - a.cards.length || b.highest - a.highest);
  const best = suits[0];
  const cardId = [...best.cards].sort((a, b) => cardStrength(a) - cardStrength(b))[0];
  return indicator === 'external' ? { suit: best.suit } : { cardId };
}
