const { describe, test, expect } = require('@jest/globals');
const { createMatchActor, restoreMatchActor } = require('../../src/application/match-actor.ts');
const { createChatState, acceptQuickChat, chatRemainingMs } = require('../../src/application/quick-chat.ts');
const { createHistoryState, recordHistory, historyPage, HISTORY_CAPACITY } = require('../../src/application/table-history.ts');
const { commandSchema } = require('../../src/protocol/player-command.ts');
const { historyQuerySchema, historyPageSchema } = require('../../src/protocol/history.ts');
const { baselineBotAction } = require('../../src/application/baseline-bot.ts');
const { PRESETS } = require('../../src/domain/presets.ts');
const { rulesetSchema } = require('../../src/domain/ruleset.ts');
const { createDeck } = require('../../src/domain/cards.ts');
const { completedSummary } = require('../support/client-fixture.cjs');

function harness() {
  let clock = 1000, id = 0;
  const records = [], published = [];
  const { maxBid, totalPoints, ...raw } = PRESETS['29-standard'];
  const ports = { now: () => clock, firstDealer: jest.fn(() => 0), shuffle: jest.fn(createDeck), botDelayMs: () => 600,
    schedule: jest.fn(() => () => {}), append: jest.fn(async record => { records.push(record); }),
    publish: jest.fn((viewer, events) => published.push({ viewer, events })), onError: jest.fn() };
  const actor = createMatchActor({ matchId: 'social', ruleset: rulesetSchema.parse({ ...raw, matchEnd: { winAt: 1, loseAt: -1 } }),
    lifecycle: {}, table: {} }, ports);
  function command(action, seat = 0, target = actor, overrides = {}) {
    const view = target.getView(seat);
    return { matchId: 'social', commandId: `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      expectedVersion: view.version, ...(['READY', 'REMATCH_VOTE'].includes(action.type) ? { expectedCheckId: view.table.checkId } : {}), action, ...overrides };
  }
  async function startGame() {
    for (const seat of [0, 1, 2, 3]) await actor.setConnected(seat, true);
    for (const seat of [0, 1, 2, 3]) await actor.dispatch(seat, command({ type: 'READY' }, seat));
  }
  async function finish() {
    for (let count = 0; actor.getView(0).status === 'IN_PROGRESS'; count++) {
      expect(count).toBeLessThan(150);
      const seat = actor.getView(0).toAct;
      expect(await actor.dispatch(seat, command(baselineBotAction(actor.getView(seat)), seat))).toMatchObject({ ok: true });
    }
  }
  return { actor, ports, records, published, command, startGame, finish, setTime: value => { clock = value; } };
}

describe('fixed-phrase chat policy', () => {
  test('enforces a per-seat two-second boundary including timestamp zero and keeps state immutable', () => {
    const state = createChatState();
    const first = acceptQuickChat(state, 0, 'GOOD_LUCK', 'first', 0);
    expect(first.ok).toBe(true); expect(state).toEqual(createChatState());
    expect(chatRemainingMs(first.state, 0, 1999)).toBe(1);
    expect(acceptQuickChat(first.state, 0, 'THANKS', 'too-soon', 1999)).toEqual({ ok: false, code: 'CHAT_RATE_LIMITED' });
    expect(acceptQuickChat(first.state, 0, 'THANKS', 'boundary', 2000).ok).toBe(true);
    expect(acceptQuickChat(first.state, 1, 'THANKS', 'other-seat', 1).ok).toBe(true);
  });
  test('bounds the chat transcript and rejects arbitrary text, card hints, actors and unknown phrase IDs at the boundary', () => {
    let state = createChatState();
    for (let i = 0; i < 25; i++) state = acceptQuickChat(state, 0, 'THANKS', String(i), i * 2000).state;
    expect(state.messages).toHaveLength(20); expect(state.messages[0].id).toBe('5');
    const base = { commandId: '00000000-0000-4000-8000-000000000001', matchId: 'x', expectedVersion: 0 };
    for (const action of [{ type: 'QUICK_CHAT', phraseId: 'I_HAVE_JS' }, { type: 'QUICK_CHAT', phraseId: 'THANKS', text: 'JS' },
      { type: 'QUICK_CHAT', phraseId: 'THANKS', seat: 3 }, { type: 'QUICK_CHAT', text: 'anything' }]) {
      expect(commandSchema.safeParse({ ...base, action }).success).toBe(false);
    }
  });
});

describe('completed-result projection and pagination', () => {
  test('keeps full completed tricks but no trump-power flags, hidden state, or mutable references', () => {
    const summary = completedSummary();
    const original = structuredClone(summary);
    const state = createHistoryState();
    const next = recordHistory(state, 1, 1000, { A: 1, B: 0 }, [
      { type: 'HAND_SCORED', handNumber: 1, dealNumber: 1, summary },
      { type: 'MATCH_ENDED', winner: 'A', gameScores: { A: 1, B: 0 }, abandoned: false },
    ]);
    const page = historyPage(next, { limit: 10 });
    expect(historyPageSchema.safeParse(page).success).toBe(true);
    expect(page.entries.map(entry => entry.kind)).toEqual(['MATCH', 'HAND']);
    expect(page.entries[0].handsPlayed).toBe(1);
    expect(page.entries[1].summary.tricks.flatMap(trick => trick.plays)).toHaveLength(32);
    expect(JSON.stringify(page)).not.toContain('trumpPower'); expect(JSON.stringify(page)).not.toContain('deck');
    page.entries[1].summary.tricks[0].plays.pop();
    expect(historyPage(next, { limit: 10 }).entries[1].summary.tricks[0].plays).toHaveLength(4);
    expect(state).toEqual(createHistoryState()); expect(summary).toEqual(original);
  });
  test('bounds retention, uses exclusive stable cursors, and counts abandoned matches without hands', () => {
    let state = createHistoryState();
    for (let i = 1; i <= HISTORY_CAPACITY + 5; i++) state = recordHistory(state, i, i * 1000, { A: 0, B: 0 }, [
      { type: 'MATCH_ENDED', winner: null, gameScores: { A: 0, B: 0 }, abandoned: true },
    ]);
    const latest = historyPage(state, { limit: 10 });
    expect(latest).toMatchObject({ total: 105, truncated: true, earliestAvailable: 6, nextBefore: 96 });
    expect(latest.entries[0]).toMatchObject({ index: 105, matchNumber: 105, abandoned: true, handsPlayed: 0 });
    expect(historyPage(state, { limit: 10, before: 96 }).entries.map(entry => entry.index)).toEqual([95, 94, 93, 92, 91, 90, 89, 88, 87, 86]);
    expect(historyPage(state, { limit: 20, before: 6 }).entries).toEqual([]);
    for (const query of [{ limit: 0 }, { limit: 21 }, { before: 0 }, { before: '5' }, { seat: 0 }]) expect(historyQuerySchema.safeParse(query).success).toBe(false);
    expect(historyPage(createHistoryState(), { limit: 10 })).toMatchObject({ entries: [], total: 0, nextBefore: null, earliestAvailable: null, truncated: false });
  });
});

describe('serialized, journaled social features', () => {
  test('chat is committed before publication, has seat-scoped idempotency and never changes game timing/version', async () => {
    const h = harness(); await h.actor.start(); await h.startGame();
    const before = h.actor.getView(0);
    const command = h.command({ type: 'QUICK_CHAT', phraseId: 'GOOD_LUCK' });
    h.ports.publish.mockImplementation((viewer, events) => {
      expect(h.records.at(-1).receipt.command.commandId).toBe(command.commandId);
      expect(h.actor.getView(viewer).chat.messages).toHaveLength(1);
    });
    const accepted = await h.actor.dispatch(0, command);
    expect(accepted).toMatchObject({ ok: true, version: before.version });
    expect(h.actor.getView(0).chat.messages[0].id).toBe('social:chat:1');
    expect(JSON.stringify(h.actor.getView('spectator').chat)).not.toContain(command.commandId);
    const count = h.records.length;
    expect(await h.actor.dispatch(0, command)).toEqual(accepted); expect(h.records).toHaveLength(count);
    expect(h.actor.getView(0)).toMatchObject({ version: before.version, deadline: before.deadline, timeBankMs: before.timeBankMs });
    const rejected = h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' });
    expect(await h.actor.dispatch(0, rejected)).toMatchObject({ code: 'CHAT_RATE_LIMITED' });
    h.setTime(3000);
    expect(await h.actor.dispatch(0, rejected)).toMatchObject({ code: 'CHAT_RATE_LIMITED' });
    h.ports.publish.mockReset();
    expect(await h.actor.dispatch(0, h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' }))).toMatchObject({ ok: true });
    expect(h.actor.getView('spectator').chat).toMatchObject({ canSend: false, messages: expect.any(Array) });
    expect(h.actor.getView('spectator').chat.messages).toHaveLength(2);
    h.actor.stop();
  });
  test('offline owners and spoofed seats cannot send; accepted/rejected cooldown receipts survive replay', async () => {
    const h = harness(); await h.actor.start(); await h.actor.setConnected(0, true);
    expect(await h.actor.dispatch(1, h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' }, 1))).toMatchObject({ code: 'SEAT_NOT_CONNECTED' });
    expect(await h.actor.dispatch(9, h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' }))).toMatchObject({ code: 'INVALID_COMMAND' });
    const command = h.command({ type: 'QUICK_CHAT', phraseId: 'GOOD_LUCK' });
    const accepted = await h.actor.dispatch(0, command);
    const rejected = h.command({ type: 'QUICK_CHAT', phraseId: 'OOPS' });
    await h.actor.dispatch(0, rejected);
    const archive = JSON.parse(JSON.stringify(h.records)); h.actor.stop();
    const restored = await restoreMatchActor(archive, h.ports);
    expect(restored.getView(0).chat).toMatchObject({ messages: [{ phraseId: 'GOOD_LUCK', seat: 0 }], remainingMs: 2000 });
    expect(await restored.dispatch(0, command)).toEqual(accepted);
    expect(await restored.dispatch(0, rejected)).toMatchObject({ code: 'CHAT_RATE_LIMITED' });
    await restored.setConnected(0, true);
    h.setTime(2999);
    expect(await restored.dispatch(0, h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' }, 0, restored))).toMatchObject({ code: 'CHAT_RATE_LIMITED' });
    h.setTime(3000);
    expect(await restored.dispatch(0, h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' }, 0, restored))).toMatchObject({ ok: true });
    restored.stop();
  });
  test('history contains only completed outcomes, stays identical across replay and survives rematches', async () => {
    const h = harness(); await h.actor.start(); await h.startGame();
    expect(h.actor.getHistory(0, { limit: 10 }).entries).toEqual([]);
    const seq = h.actor.getSequence(0), count = h.records.length;
    expect(h.actor.getHistory('spectator', { limit: 10 }).entries).toEqual([]);
    expect(h.actor.getSequence(0)).toBe(seq); expect(h.records).toHaveLength(count);
    await h.finish();
    const completed = h.actor.getHistory(0, { limit: 10 });
    expect(completed.entries.map(entry => entry.kind)).toEqual(['MATCH', 'HAND']);
    for (const seat of [0, 1, 2, 3]) await h.actor.dispatch(seat, h.command({ type: 'REMATCH_VOTE', accept: true }, seat));
    expect(h.actor.getHistory(0, { limit: 10 })).toEqual(completed);
    await h.finish();
    const before = h.actor.getHistory(0, { limit: 10 });
    expect(before.entries.map(entry => entry.matchNumber)).toEqual([2, 2, 1, 1]);
    const archive = JSON.parse(JSON.stringify(h.records)); h.actor.stop();
    const restored = await restoreMatchActor(archive, h.ports);
    expect(restored.getHistory('spectator', { limit: 10 })).toEqual(before);
    expect(() => restored.getHistory(9, { limit: 10 })).toThrow();
    restored.stop();
    const tampered = structuredClone(archive);
    tampered.find(record => record.deliveries.some(delivery => delivery.events.some(event => event.event.type === 'HAND_SCORED')))
      .deliveries.find(delivery => delivery.viewer === 'spectator').events.find(event => event.event.type === 'HAND_SCORED').event.summary.delta = 99;
    await expect(restoreMatchActor(tampered, h.ports)).rejects.toThrow('replay mismatch');
  });
  test('append failure publishes no chat and exposes no uncommitted result', async () => {
    const h = harness(); await h.actor.start(); await h.actor.setConnected(0, true);
    const count = h.published.length;
    h.ports.append.mockRejectedValueOnce(new Error('disk failed'));
    await expect(h.actor.dispatch(0, h.command({ type: 'QUICK_CHAT', phraseId: 'THANKS' }))).rejects.toThrow('disk failed');
    expect(h.published).toHaveLength(count);
    expect(() => h.actor.getView(0)).toThrow('unavailable');
    expect(() => h.actor.getHistory(0, { limit: 10 })).toThrow('unavailable'); h.actor.stop();
  });
});
