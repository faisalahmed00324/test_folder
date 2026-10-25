import { randomInt } from 'node:crypto';
import { createDeck, deckSchema } from '../domain/cards';
import type { Seat } from '../domain/seats';

export function secureShuffle() {
  const cards = [...createDeck()];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return deckSchema.parse(cards);
}

export const nodeRuntime = {
  now: () => Date.now(),
  firstDealer: () => randomInt(4) as Seat,
  shuffle: secureShuffle,
  botDelayMs: () => randomInt(600, 1501),
  schedule(deadline: number, callback: () => void) {
    const timer = setTimeout(callback, Math.max(0, deadline - Date.now()));
    timer.unref();
    return () => clearTimeout(timer);
  },
};
