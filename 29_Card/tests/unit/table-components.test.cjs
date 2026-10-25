/** @jest-environment jsdom */
const { describe, test, expect, afterEach } = require('@jest/globals');
// jsdom omits structuredClone, although the supported real browsers provide it.
const { serialize, deserialize } = require('node:v8');
globalThis.structuredClone ??= value => deserialize(serialize(value));
require('@testing-library/jest-dom');
const React = require('react');
const { render, screen, fireEvent, cleanup, act } = require('@testing-library/react');
const { Table } = require('../../src/client/Table.tsx');
const { App } = require('../../src/client/App.tsx');
const { clientSnapshot, completedSummary } = require('../support/client-fixture.cjs');
const { actionLabel } = require('../../src/client/presentation.ts');
const { QuickChat } = require('../../src/client/QuickChat.tsx');
const { History } = require('../../src/client/History.tsx');
const { createHistoryState, recordHistory, historyPage } = require('../../src/application/table-history.ts');
const { InviteLobby } = require('../../src/client/InviteLobby.tsx');
const { browserSeatToken } = require('../../src/client/invitation-form.ts');

afterEach(() => { cleanup(); jest.useRealTimers(); history.replaceState(null, '', '/'); });
describe('accessible private-table React controls', () => {
  test('invitation fragments prefill a password field, are scrubbed, and never auto-connect', () => {
    const token = 'I'.repeat(43);
    history.replaceState(null, '', `/29_Card/index.html#${new URLSearchParams({ invite: token, server: 'ws://127.0.0.1:8766/29-card/ws' })}`);
    const sockets = jest.spyOn(window, 'WebSocket');
    render(React.createElement(App));
    expect(location.hash).toBe('');
    expect(screen.getByLabelText('Seat access token')).toHaveValue(token);
    expect(screen.getByLabelText('Seat access token')).toHaveAttribute('type', 'password');
    expect(sockets).not.toHaveBeenCalled();
  });
  test('the credential adapter uses 32 cryptographic random bytes', () => {
    const random = jest.spyOn(crypto, 'getRandomValues').mockImplementation(array => { array.fill(7); return array; });
    expect(browserSeatToken()).toBe(Buffer.alloc(32, 7).toString('base64url'));
    expect(random.mock.calls[0][0]).toHaveLength(32);
  });
  test('invitation seating requires an explicit save confirmation and never enables occupied seats', () => {
    const lobby = { canClaim: true, expiresAt: 10000, seats: [0, 1, 2, 3].map(seat => ({ seat, occupied: seat === 1 })) };
    const onChoose = jest.fn(), onConfirm = jest.fn();
    const { rerender } = render(React.createElement(InviteLobby, { lobby, token: null, selected: null, pending: false, error: null, onChoose, onConfirm }));
    expect(screen.getByRole('button', { name: /Seat 2 occupied/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Choose Seat 1/ })); expect(onChoose).toHaveBeenCalledWith(0);
    expect(onConfirm).not.toHaveBeenCalled();
    rerender(React.createElement(InviteLobby, { lobby, token: 'S'.repeat(43), selected: 0, pending: false, error: null, onChoose, onConfirm }));
    expect(screen.getByLabelText('Your reconnect token')).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByLabelText('Reveal reconnect token'));
    expect(screen.getByLabelText('Your reconnect token')).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: 'I saved this token — claim Seat 1' })); expect(onConfirm).toHaveBeenCalledTimes(1);
  });
  test('failed clipboard access provides a manual fallback without revealing a masked token automatically', async () => {
    const lobby = { canClaim: true, expiresAt: 10000, seats: [0, 1, 2, 3].map(seat => ({ seat, occupied: false })) };
    render(React.createElement(InviteLobby, { lobby, token: 'S'.repeat(43), selected: 0, pending: false,
      error: null, onChoose: jest.fn(), onConfirm: jest.fn() }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy reconnect token' }));
    expect(await screen.findByText('Copy unavailable. Reveal the token and copy it manually.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your reconnect token')).toHaveAttribute('type', 'password');
  });
  test('renders own hand and legal bidding controls, with pending actions locked', () => {
    const onAction = jest.fn();
    const view = clientSnapshot();
    const { rerender } = render(React.createElement(Table, { view, disabled: false, onAction }));
    expect(screen.getByRole('region', { name: 'Your hand' }).querySelectorAll('button')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Bid 16', exact: true }));
    expect(onAction).toHaveBeenCalledWith({ type: 'BID', amount: 16 });
    rerender(React.createElement(Table, { view, disabled: true, onAction }));
    expect(screen.getByRole('button', { name: 'Bid 16', exact: true })).toBeDisabled();
    expect(screen.getByText('Trump: Hidden')).toBeInTheDocument();
  });
  test('enables only server-approved cards and disables control during bot reclaim', () => {
    const view = clientSnapshot();
    view.phase = 'PLAY'; view.myHand = ['JS', '7C']; view.legalActions = [{ type: 'PLAY_CARD', cardId: '7C' }];
    const onAction = jest.fn();
    const { rerender } = render(React.createElement(Table, { view, disabled: false, onAction }));
    expect(screen.getByRole('button', { name: 'Play Jack of Spades' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Play 7 of Clubs' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'PLAY_CARD', cardId: '7C' });
    view.seats[3] = { connected: true, controller: 'bot', reclaimPending: true };
    rerender(React.createElement(Table, { view, disabled: false, onAction }));
    expect(screen.getByText(/Bot is finishing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play 7 of Clubs' })).toBeDisabled();
  });
  test('spectator projection does not render a hand', () => {
    render(React.createElement(Table, { view: clientSnapshot('spectator'), disabled: false, onAction: jest.fn() }));
    expect(screen.queryByRole('region', { name: 'Your hand' })).not.toBeInTheDocument();
    expect(screen.getByText('Spectator · read only · Hand 1 · Deal 1')).toBeInTheDocument();
  });
  test('join form uses labeled password input and describes the ready check', () => {
    render(React.createElement(App));
    expect(screen.getByLabelText('Seat access token')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Join private table' })).toBeEnabled();
    expect(screen.getByText(/All human players confirm readiness/)).toBeInTheDocument();
  });
  test('every supported action has an explicit accessible label', () => {
    for (const action of [{ type: 'HOLD' }, { type: 'PASS' }, { type: 'DOUBLE' }, { type: 'REDOUBLE' },
      { type: 'PASS_DOUBLE' }, { type: 'CALL_TRUMP' }, { type: 'REVEAL_TRUMP' }, { type: 'DECLARE_PAIR' },
      { type: 'REQUEST_REDEAL' }, { type: 'SELECT_TRUMP', payload: { cardId: 'TH' } },
      { type: 'SELECT_TRUMP', payload: { suit: 'S' } }, { type: 'SELECT_TRUMP', payload: { seventhCard: true } }]) {
      expect(actionLabel(action)).toEqual(expect.any(String));
    }
  });

  test('shows terminal results and a retained eight-trick hand summary', () => {
    const view = clientSnapshot(); view.status = 'FINISHED'; view.phase = 'FINISHED'; view.winner = 'A';
    render(React.createElement(Table, { view, disabled: false, onAction: jest.fn(), lastSummary: completedSummary() }));
    expect(screen.getByText(/Match finished — Team A wins/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Hand summary' }).querySelectorAll('li')).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Bid 16', exact: true })).toBeDisabled();
  });

  test('ready and rematch buttons represent real server consent, including a human returning from bot control', () => {
    const view = clientSnapshot(); view.myHand = []; view.phase = 'AWAITING_DEAL';
    view.table = { phase: 'READY_CHECK', checkId: 1, matchNumber: 1, deadline: 16000,
      ready: [true, false, false, false], votes: [null, null, null, null] };
    view.legalActions = [{ type: 'READY' }];
    const onAction = jest.fn();
    const { rerender } = render(React.createElement(Table, { view, disabled: false, onAction }));
    expect(screen.queryByRole('region', { name: 'Your hand' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ready', exact: true }));
    expect(onAction).toHaveBeenCalledWith({ type: 'READY' });
    view.table.phase = 'REMATCH'; view.status = 'FINISHED'; view.seats[3].controller = 'bot';
    view.legalActions = [{ type: 'REMATCH_VOTE', accept: true }, { type: 'REMATCH_VOTE', accept: false }];
    rerender(React.createElement(Table, { view, disabled: false, onAction }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept rematch' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'REMATCH_VOTE', accept: true });
    expect(screen.getByRole('button', { name: 'Decline rematch' })).toBeEnabled();
  });

  test('quick chat offers only fixed phrases, respects cooldown and lets the viewer mute a seat locally', () => {
    jest.useFakeTimers();
    const chat = { canSend: true, remainingMs: 2000, cooldownStartedAt: 0, messages: [
      { id: 'a', seat: 0, phraseId: 'GOOD_LUCK', timestamp: 0 },
      { id: 'b', seat: 1, phraseId: 'THANKS', timestamp: 0 },
    ] };
    const onSend = jest.fn();
    const { rerender } = render(React.createElement(QuickChat, { chat, disabled: false, onSend }));
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Say Thanks' })).toBeDisabled();
    act(() => jest.advanceTimersByTime(2000));
    fireEvent.click(screen.getByRole('button', { name: 'Say Thanks' }));
    expect(onSend).toHaveBeenCalledWith('THANKS');
    rerender(React.createElement(QuickChat, { chat: { ...chat, cooldownStartedAt: 2000 }, disabled: false, onSend }));
    expect(screen.getByRole('button', { name: 'Say Thanks' })).toBeDisabled();
    fireEvent.click(screen.getByText('Mute messages from seats'));
    fireEvent.click(screen.getByLabelText('Mute Seat 1'));
    expect(screen.getByRole('log', { name: 'Table messages' })).not.toHaveTextContent('Good luck');
    expect(screen.getByRole('log', { name: 'Table messages' })).toHaveTextContent('Seat 2: Thanks');
  });

  test('spectators can read/mute quick chat but have no send controls', () => {
    render(React.createElement(QuickChat, { chat: { canSend: false, remainingMs: 0, messages: [] }, disabled: false, onSend: jest.fn() }));
    expect(screen.queryByRole('button', { name: /^Say / })).not.toBeInTheDocument();
    expect(screen.getByText('No messages yet.')).toBeInTheDocument();
  });

  test('history displays completed summaries and uses explicit bounded pagination controls', () => {
    const summary = completedSummary();
    const state = recordHistory(createHistoryState(), 1, 1000, { A: 1, B: 0 }, [
      { type: 'HAND_SCORED', handNumber: 1, dealNumber: 1, summary },
      { type: 'HAND_SCORED', handNumber: 2, dealNumber: 2, summary },
      { type: 'MATCH_ENDED', winner: 'A', gameScores: { A: 1, B: 0 }, abandoned: false },
    ]);
    const onLoad = jest.fn();
    const page = historyPage(state, { limit: 2 });
    const { rerender } = render(React.createElement(History, { page, loading: false, error: null, disabled: false, onLoad }));
    expect(screen.getByRole('article', { name: 'Match 1 result' })).toHaveTextContent('Winner: Team A');
    expect(screen.getByRole('article', { name: 'Match 1 hand 2' }).querySelectorAll('li')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Older results' }));
    expect(onLoad).toHaveBeenCalledWith(2);
    rerender(React.createElement(History, { page, loading: true, error: null, disabled: false, onLoad }));
    expect(screen.getByRole('button', { name: 'Latest results' })).toBeDisabled();
    rerender(React.createElement(History, { page: null, loading: false, error: 'HISTORY_TIMEOUT', disabled: false, onLoad }));
    expect(screen.getByRole('alert')).toHaveTextContent('History unavailable');
  });
});
