import type { Seat } from '../domain/seats';
import { CHAT_COOLDOWN_MS, type ChatMessage, type PhraseId } from '../protocol/quick-chat';

export type ChatState = { lastSent: readonly (number | null)[]; messages: readonly ChatMessage[]; nextId: number };
export function createChatState(): ChatState { return { lastSent: [null, null, null, null], messages: [], nextId: 1 }; }
export function chatRemainingMs(state: ChatState, seat: Seat, now: number) {
  return state.lastSent[seat] === null ? 0 : Math.max(0, state.lastSent[seat]! + CHAT_COOLDOWN_MS - now);
}
export function acceptQuickChat(state: ChatState, seat: Seat, phraseId: PhraseId, id: string, now: number):
  { ok: false; code: 'CHAT_RATE_LIMITED' } | { ok: true; state: ChatState; message: ChatMessage } {
  if (chatRemainingMs(state, seat, now) > 0) return { ok: false, code: 'CHAT_RATE_LIMITED' };
  const message: ChatMessage = { id, seat, phraseId, timestamp: now };
  const lastSent = [...state.lastSent]; lastSent[seat] = now;
  return { ok: true, state: { lastSent, messages: [...state.messages, message].slice(-20), nextId: state.nextId + 1 }, message };
}
