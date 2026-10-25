import type { PlayerAction } from '../protocol/player-command';
import type { CardId, Suit } from '../domain/cards';
import { QUICK_CHAT_PHRASES } from '../protocol/quick-chat';

const suits: Record<Suit, string> = { C: 'Clubs', D: 'Diamonds', H: 'Hearts', S: 'Spades' };
export function cardLabel(card: CardId): string {
  const rank = ({ J: 'Jack', A: 'Ace', T: 'Ten', K: 'King', Q: 'Queen' } as Record<string, string>)[card[0]] ?? card[0];
  return `${rank} of ${suits[card[1] as Suit]}`;
}
export function actionLabel(action: PlayerAction): string {
  switch (action.type) {
    case 'QUICK_CHAT': return `Say ${QUICK_CHAT_PHRASES[action.phraseId]}`;
    case 'READY': return 'Ready';
    case 'REMATCH_VOTE': return action.accept ? 'Accept rematch' : 'Decline rematch';
    case 'BID': return `Bid ${action.amount}`;
    case 'SELECT_TRUMP': return 'cardId' in action.payload ? `Conceal ${cardLabel(action.payload.cardId)}`
      : 'suit' in action.payload ? `Choose ${suits[action.payload.suit]} trump` : 'Use seventh card as trump';
    case 'PLAY_CARD': return `Play ${cardLabel(action.cardId)}`;
    case 'HOLD': return 'Hold bid';
    case 'PASS': return 'Pass';
    case 'DOUBLE': return 'Double';
    case 'REDOUBLE': return 'Redouble';
    case 'PASS_DOUBLE': return 'Pass double';
    case 'CALL_TRUMP': return 'Call trump';
    case 'REVEAL_TRUMP': return 'Reveal trump';
    case 'DECLARE_PAIR': return 'Declare pair';
    case 'REQUEST_REDEAL': return 'Request redeal';
  }
}
export function seatLabel(seat: number): string { return `Seat ${seat + 1}`; }
export const suitLabel = (suit: Suit) => suits[suit];
