import { parseInvitationFragment } from '../protocol/invitations';

// Consume once into component state. Fragments never reach the HTTP server;
// remove the bearer token from the visible URL before any user interaction.
export function initialJoinForm() {
  const endpoint = location.protocol === 'https:' ? `wss://${location.host}/29-card/ws` : 'ws://127.0.0.1:8766/29-card/ws';
  const fragment = location.hash;
  if (!fragment) return { endpoint, token: '', inviteError: false };
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  const invite = parseInvitationFragment(fragment);
  return invite ? { endpoint: invite.server, token: invite.invite, inviteError: false } : { endpoint, token: '', inviteError: true };
}
export function browserSeatToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
