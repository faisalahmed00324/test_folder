import type { PlayerAction, PlayerCommand } from '../protocol/player-command';
import { parseServerMessage, validEndpoint, type TableSnapshot } from './protocol';
import type { HistoryPage } from '../protocol/history';
import { CHAT_COOLDOWN_MS } from '../protocol/quick-chat';
import { seatTokenSchema, type LobbyView, type SeatClaim } from '../protocol/invitations';
import type { Seat } from '../domain/seats';

export type ClientState = {
  status: 'disconnected' | 'connecting' | 'seating' | 'syncing' | 'connected' | 'reconnecting' | 'left' | 'error';
  snapshot: TableSnapshot | null; lastSummary: TableSnapshot['summary']; pending: boolean; error: string | null;
  history: HistoryPage | null; historyPending: boolean; historyError: string | null;
  lobby: LobbyView | null; seatToken: string | null; selectedSeat: Seat | null; seatingPending: boolean; seatError: string | null;
};
export function initialClientState(): ClientState {
  return { status: 'disconnected', snapshot: null, lastSummary: null, pending: false, error: null,
    history: null, historyPending: false, historyError: null,
    lobby: null, seatToken: null, selectedSeat: null, seatingPending: false, seatError: null };
}
export type ClientSocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror'>;
export interface ClientPorts {
  socket(url: string): ClientSocket;
  schedule(delay: number, callback: () => void): () => void;
  commandId(): string;
  seatToken?(): string;
  changed(state: ClientState): void;
}

// Game events invalidate the view rather than duplicating rules in a reducer.
// Validated chat-only events can update their bounded transcript directly.
export function createTableClient(ports: ClientPorts) {
  let state = initialClientState();
  let socket: ClientSocket | undefined;
  let credentials: { endpoint: string; token: string } | undefined;
  let matchId: string | undefined;
  let viewer: TableSnapshot['viewer'] | 'guest' | undefined;
  let sequence = 0;
  let lastVersion = 0;
  let matchNumber = 0;
  let pending: PlayerCommand | undefined;
  let pendingSent = false;
  let snapshotRequested = false;
  let dirty = false;
  let attempts = 0;
  let cancelRetry: (() => void) | undefined;
  let cancelWait: (() => void) | undefined;
  let cancelCommand: (() => void) | undefined;
  let historyRequest: string | undefined;
  let cancelHistory: (() => void) | undefined;
  let claim: (SeatClaim & { sent: boolean }) | undefined;
  let claimSent = false;

  function update(next: Partial<ClientState>) { state = { ...state, ...next }; ports.changed(structuredClone(state)); }
  function send(message: unknown) { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); }
  function refresh() {
    update({ status: 'syncing' });
    if (snapshotRequested) { dirty = true; return; }
    snapshotRequested = true; send({ type: 'GET_VIEW' });
    cancelWait?.(); cancelWait = ports.schedule(10_000, () => fail('SYNC_TIMEOUT'));
  }
  function detach() {
    cancelRetry?.(); cancelRetry = undefined;
    cancelWait?.(); cancelWait = undefined;
    cancelCommand?.(); cancelCommand = undefined;
    cancelHistory?.(); cancelHistory = undefined; historyRequest = undefined;
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
      socket.close(); socket = undefined;
    }
  }
  function fail(code: string) {
    credentials = undefined; pending = undefined; claim = undefined;
    detach(); update({ ...initialClientState(), status: 'error', error: code });
  }
  function requestLobby() {
    send({ type: 'GET_LOBBY' });
    cancelWait?.(); cancelWait = ports.schedule(10_000, () => fail('LOBBY_TIMEOUT'));
  }
  function sendClaim() {
    if (!claim || claimSent) return;
    claim.sent = true; claimSent = true;
    update({ seatingPending: true, seatError: null });
    send({ type: 'TAKE_SEAT', requestId: claim.requestId, seat: claim.seat, token: claim.token });
    cancelWait?.(); cancelWait = ports.schedule(10_000, () => fail('SEAT_CLAIM_TIMEOUT'));
  }
  function open() {
    if (!credentials) return;
    snapshotRequested = false; dirty = false;
    pendingSent = false;
    claimSent = false;
    try { socket = ports.socket(credentials.endpoint); }
    catch { fail('CONNECTION_FAILED'); return; }
    const current = socket;
    let welcomed = false;
    cancelWait = ports.schedule(10_000, () => fail('CONNECTION_TIMEOUT'));
    current.onopen = () => { if (socket === current && credentials) send({ type: 'HELLO', protocolVersion: 1, token: credentials.token }); };
    current.onerror = () => { /* onclose owns reconnect; never log credentials. */ };
    current.onclose = event => {
      if (socket !== current || !credentials) return;
      detach();
      if ([1000, 1008].includes(event.code)) {
        fail(event.reason === 'Ready check expired' ? 'READY_CHECK_EXPIRED' : event.code === 1008 ? 'SESSION_CLOSED' : 'CONNECTION_CLOSED'); return;
      }
      if (++attempts > 5) { fail('RECONNECT_FAILED'); return; }
      // Clear private cards while offline; pending command/receipt identity stays
      // only in memory and is retried unchanged after a fresh authenticated view.
      update({ status: 'reconnecting', snapshot: null, history: null, historyPending: false, historyError: null,
        lobby: null, seatToken: null, selectedSeat: null });
      cancelRetry = ports.schedule(Math.min(1000 * 2 ** (attempts - 1), 8000), open);
    };
    current.onmessage = event => {
      if (socket !== current) return;
      const message = parseServerMessage(event.data);
      if (!message) { fail('INVALID_SERVER_MESSAGE'); return; }
      if (message.type === 'ERROR') { fail(message.code); return; }
      if (message.type === 'WELCOME') {
        if ((matchId && matchId !== message.matchId) || (viewer !== undefined && viewer !== message.viewer)) {
          fail('SESSION_CHANGED'); return;
        }
        matchId = message.matchId; viewer = message.viewer;
        welcomed = true; cancelWait?.();
        if (viewer === 'guest') { update({ status: 'seating' }); requestLobby(); return; }
        refresh(); return;
      }
      // Presence events can precede WELCOME while the server commits connection
      // status. Ignore them until WELCOME, then request a complete filtered view.
      if (!welcomed || !matchId || viewer === undefined) return;
      if ('matchId' in message && message.matchId !== matchId) { fail('SESSION_CHANGED'); return; }
      if (viewer === 'guest') {
        if (message.type === 'LOBBY') {
          if (!claimSent) cancelWait?.();
          attempts = 0;
          update({ status: 'seating', lobby: message.lobby, seatToken: claim?.token ?? null, selectedSeat: claim?.seat ?? null });
          if (claim?.sent && !claimSent) sendClaim();
        } else if (message.type === 'SEAT_RESULT') {
          if (!claim || message.requestId !== claim.requestId) return;
          cancelWait?.(); claimSent = false;
          if (!message.result.ok) {
            claim = undefined;
            update({ seatingPending: false, seatToken: null, selectedSeat: null, seatError: message.result.code });
            requestLobby(); return;
          }
          if (message.result.seat !== claim.seat || !credentials) { fail('SESSION_CHANGED'); return; }
          credentials = { endpoint: credentials.endpoint, token: claim.token };
          viewer = message.result.seat; claim = undefined;
          update({ lobby: null, seatToken: null, selectedSeat: null, seatingPending: false, seatError: null });
          refresh();
        }
        // A binding may publish presence before its acknowledgement. Do not
        // render any engine traffic until SEAT_RESULT establishes the seat.
        return;
      }
      switch (message.type) {
        case 'HISTORY':
          if (message.requestId !== historyRequest) return;
          historyRequest = undefined; cancelHistory?.();
          update({ history: message.page, historyPending: false, historyError: null }); return;
        case 'SNAPSHOT': {
          if (message.snapshot.viewer !== viewer) { fail('SESSION_CHANGED'); return; }
          if (message.seq < sequence || message.snapshot.version < lastVersion) {
            fail('OUT_OF_ORDER_SNAPSHOT'); return;
          }
          sequence = message.seq; lastVersion = message.snapshot.version; snapshotRequested = false; attempts = 0;
          cancelWait?.();
          const newMatch = matchNumber !== 0 && message.snapshot.table?.matchNumber !== matchNumber;
          matchNumber = message.snapshot.table?.matchNumber ?? 0;
          update({ snapshot: message.snapshot, status: 'connected', lastSummary: newMatch ? null : message.snapshot.summary ?? state.lastSummary });
          if (pending && !pendingSent) {
            pendingSent = true; send({ type: 'COMMAND', command: pending });
            cancelCommand = ports.schedule(10_000, () => fail('MOVE_CONFIRMATION_TIMEOUT'));
          }
          if (dirty) { dirty = false; refresh(); }
          return;
        }
        case 'EVENTS': case 'REPLAY': {
          let cursor = sequence;
          const chatOnly = state.status === 'connected' && state.snapshot?.chat && !snapshotRequested &&
            message.events.length > 0 && message.events.every(entry => entry.event.type === 'CHAT_MESSAGE' && entry.version === lastVersion);
          let transcript = state.snapshot?.chat?.messages ?? [];
          let cooldownStartedAt = state.snapshot?.chat?.cooldownStartedAt;
          let sentByMe = false;
          for (const event of message.events) {
            if (event.matchId !== matchId) { fail('SESSION_CHANGED'); return; }
            if (event.seq <= cursor) continue;
            // Both a contiguous suffix and a gap require an authoritative view.
            if (event.seq !== cursor + 1) { refresh(); return; }
            cursor = event.seq;
            if (chatOnly && event.event.message) {
              const chat = event.event.message;
              if (!transcript.some(message => message.id === chat.id)) transcript = [...transcript, chat].slice(-20);
              if (chat.seat === viewer) { sentByMe = true; cooldownStartedAt = chat.timestamp; }
            }
            if (event.event.type === 'HAND_SCORED' && event.event.summary) update({ lastSummary: event.event.summary });
          }
          if (chatOnly && state.snapshot?.chat && (message.type !== 'REPLAY' || message.seq === cursor)) {
            sequence = cursor;
            update({ snapshot: { ...state.snapshot, chat: { ...state.snapshot.chat, messages: transcript,
              cooldownStartedAt, remainingMs: sentByMe ? CHAT_COOLDOWN_MS : state.snapshot.chat.remainingMs } } });
            return;
          }
          if (cursor > sequence || (message.type === 'REPLAY' && message.seq !== sequence)) refresh();
          return;
        }
        case 'RESULT': {
          if (pending?.commandId !== message.commandId) return;
          const chatConfirmed = pending.action.type === 'QUICK_CHAT' && message.ok && message.chatMessageId &&
            state.snapshot?.chat?.messages.some(chat => chat.id === message.chatMessageId);
          pending = undefined;
          cancelCommand?.();
          update({ pending: false, error: message.ok ? null : message.code ?? 'COMMAND_REJECTED' });
          if (!chatConfirmed) refresh();
          return;
        }
        case 'LEFT_TABLE':
          credentials = undefined; pending = undefined; detach();
          update({ ...initialClientState(), status: 'left' });
      }
    };
  }
  return {
    connect(endpoint: string, token: string) {
      detach(); matchId = undefined; viewer = undefined; sequence = 0; lastVersion = 0; matchNumber = 0; pending = undefined; attempts = 0;
      claim = undefined;
      credentials = undefined;
      if (!validEndpoint(endpoint) || !token || token.length > 4096) { fail('INVALID_CONNECTION'); return; }
      credentials = { endpoint, token };
      update({ ...initialClientState(), status: 'connecting' }); open();
    },
    prepareSeat(seat: Seat) {
      if (state.status !== 'seating' || !state.lobby?.canClaim || state.seatingPending ||
          !state.lobby.seats.some(slot => slot.seat === seat && !slot.occupied)) return;
      try {
        const token = seatTokenSchema.safeParse(ports.seatToken?.());
        if (!token.success) { fail('SECURE_TOKEN_UNAVAILABLE'); return; }
        claim = { requestId: ports.commandId(), seat, token: token.data, sent: false };
        update({ selectedSeat: seat, seatToken: token.data, seatError: null });
      } catch { fail('SECURE_TOKEN_UNAVAILABLE'); }
    },
    confirmSeat() {
      if (state.status !== 'seating' || !claim || claim.sent || !state.lobby) return;
      if (!state.lobby.canClaim || state.lobby.seats[claim.seat].occupied) {
        claim = undefined; update({ selectedSeat: null, seatToken: null, seatError: 'SEAT_TAKEN' }); return;
      }
      sendClaim();
    },
    play(action: PlayerAction) {
      const view = state.snapshot;
      const coordinating = action.type === 'READY' || action.type === 'REMATCH_VOTE';
      const social = action.type === 'QUICK_CHAT';
      if (state.status !== 'connected' || !view || pending || !matchId || view.viewer === 'spectator' ||
          (!coordinating && !social && view.seats && view.seats[view.viewer].controller !== 'human') ||
          (social ? !view.chat?.canSend : !view.legalActions.some(legal => JSON.stringify(legal) === JSON.stringify(action)))) return;
      const envelope = { commandId: ports.commandId(), matchId, expectedVersion: view.version };
      if (action.type === 'READY' || action.type === 'REMATCH_VOTE') {
        if (!view.table) return;
        pending = { ...envelope, expectedCheckId: view.table.checkId, action };
      } else if (action.type === 'QUICK_CHAT') pending = { ...envelope, action };
      else pending = { ...envelope, action };
      pendingSent = true;
      update({ pending: true, error: null }); send({ type: 'COMMAND', command: pending });
      cancelCommand = ports.schedule(10_000, () => fail('MOVE_CONFIRMATION_TIMEOUT'));
    },
    leave() { if (state.status === 'connected' && state.snapshot?.viewer !== 'spectator') send({ type: 'LEAVE_TABLE' }); },
    loadHistory(before?: number) {
      if (!['connected', 'syncing'].includes(state.status) || !state.snapshot || historyRequest) return;
      historyRequest = ports.commandId();
      const requestId = historyRequest;
      update({ historyPending: true, historyError: null });
      send({ type: 'GET_HISTORY', requestId, ...(before === undefined ? {} : { before }), limit: 10 });
      cancelHistory = ports.schedule(10_000, () => {
        if (historyRequest !== requestId) return;
        historyRequest = undefined; update({ historyPending: false, historyError: 'HISTORY_TIMEOUT' });
      });
    },
    disconnect() {
      credentials = undefined; pending = undefined; claim = undefined; detach();
      update(initialClientState());
    },
  };
}
