import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { commandSchema, type TableAction } from '../protocol/player-command';
export { commandSchema } from '../protocol/player-command';
import { applyEngineCommand, createEngine, engineToAct, engineView, recipientEvents,
  engineInputSchema, engineSettingsSchema, type EngineInput, type EngineSettings, type EngineState, type Viewer } from '../domain/engine';
import type { Deck } from '../domain/cards';
import { rulesetSchema, type RulesetConfig } from '../domain/ruleset';
import { seatSchema, type Seat } from '../domain/seats';
import { baselineBotAction } from './baseline-bot';
import { lifecycleOperationSchema, lifecycleSettingsSchema, SEATS,
  type LifecycleOperation, type LifecycleState, type PresenceEvent } from './seat-lifecycle';
import { applyTableAction, createTableSession, expireTable, reconcileTable, tableSettingsSchema,
  type TableState } from './table-session';
import { acceptQuickChat, chatRemainingMs, createChatState } from './quick-chat';
import { createHistoryState, historyPage, recordHistory } from './table-history';
import type { ChatMessage, ChatView } from '../protocol/quick-chat';
import type { HistoryQuery } from '../protocol/history';

const timersSchema = z.strictObject({
  turnMs: z.number().int().positive().default(20_000),
  doubleMs: z.number().int().positive().default(10_000),
  timeBankMs: z.number().int().nonnegative().default(30_000),
});
const metadataSchema = z.strictObject({
  engineVersion: z.literal('1.0.0'), matchId: z.string().min(1).max(128),
  dealer: seatSchema, ruleset: rulesetSchema, settings: engineSettingsSchema, timers: timersSchema,
  lifecycle: lifecycleSettingsSchema.optional(),
  table: tableSettingsSchema.optional(),
  membershipId: z.string().uuid().optional(),
});
const recordSchema = z.strictObject({
  metadata: z.unknown(), recordedAt: z.number().finite().nonnegative(),
  input: engineInputSchema.nullable(), state: z.unknown(), timing: z.unknown(),
  banks: z.unknown(), deliveries: z.unknown(),
  lifecycle: z.unknown().optional(), lifecycleOperation: lifecycleOperationSchema.optional(),
  botDelayMs: z.number().int().min(600).max(1500).optional(),
  table: z.unknown().optional(), tableOperation: z.enum(['INIT', 'EXPIRE']).optional(), rematchDealer: seatSchema.optional(),
  receipt: z.strictObject({ seat: seatSchema, command: commandSchema, response: z.unknown() }).optional(),
});
type Timing = { seat: Seat | null; deadline: number; bankUsed: boolean; version: number } | null;
type ProjectedEvent = ReturnType<typeof recipientEvents>[number];
export type RuntimeEvent = { version: number; seq: number; eventId: string; matchId: string; timestamp: number;
  event: ProjectedEvent['event'] | PresenceEvent | { type: 'TABLE_UPDATED'; table: TableState } |
    { type: 'CHAT_MESSAGE'; message: ChatMessage } |
    { type: 'READY_FAILED'; seats: readonly Seat[] } |
    { type: 'TURN'; seat: Seat | null; deadline: number | null; remainingMs: number } };
export type ActorView = Omit<ReturnType<typeof engineView>, 'legalActions'> & {
  legalActions: readonly (ReturnType<typeof engineView>['legalActions'][number] | TableAction)[];
  deadline: number | null; remainingMs: number; timeBankMs: number | null; table?: TableState;
  chat?: ChatView;
  seats?: readonly { connected: boolean; controller: 'human' | 'bot'; reclaimPending: boolean }[] };
export type CommandResponse = { commandId: string | null; ok: boolean; version: number; code?: string; snapshot?: ActorView; chatMessageId?: string };
export interface JournalRecord {
  metadata: {
    engineVersion: '1.0.0'; matchId: string; dealer: Seat;
    ruleset: Omit<RulesetConfig, 'maxBid' | 'totalPoints'>;
    settings: EngineSettings; timers: z.infer<typeof timersSchema>;
    lifecycle?: z.infer<typeof lifecycleSettingsSchema>;
    table?: z.infer<typeof tableSettingsSchema>;
    membershipId?: string;
  };
  recordedAt: number;
  input: EngineInput | null;
  state: EngineState;
  timing: Timing;
  banks: readonly number[];
  deliveries: readonly { viewer: Viewer; events: readonly RuntimeEvent[] }[];
  lifecycle?: LifecycleState;
  lifecycleOperation?: LifecycleOperation;
  botDelayMs?: number;
  table?: TableState;
  tableOperation?: 'INIT' | 'EXPIRE';
  rematchDealer?: Seat;
  receipt?: { seat: Seat; command: z.infer<typeof commandSchema>; response: CommandResponse };
}
export interface ActorPorts {
  now(): number;
  firstDealer(): Seat;
  shuffle(): Deck;
  botDelayMs?(): number;
  schedule(deadline: number, callback: () => void): () => void;
  append(record: JournalRecord): Promise<void>;
  publish(viewer: Viewer, events: readonly RuntimeEvent[]): void;
  onError(error: unknown): void;
}

// Callers authenticate the session and derive the seat before invoking dispatch.
// Journal records contain secrets and must never be sent to clients.
export function createMatchActor(options: {
  matchId: string; ruleset: RulesetConfig; settings?: Partial<EngineSettings>; timers?: unknown; lifecycle?: unknown; table?: unknown; membershipId?: string;
}, ports: ActorPorts) {
  return buildMatchActor(options, ports);
}

// All stored state, events, and responses are compared against regenerated output.
// No persisted engine state or client snapshot is trusted during recovery.
export async function restoreMatchActor(archive: unknown, ports: ActorPorts) {
  const records = z.array(recordSchema).min(1).parse(archive);
  const metadata = metadataSchema.parse(records[0].metadata);
  const actor = buildMatchActor(metadata, { ...ports, firstDealer: () => metadata.dealer }, records);
  await actor.start();
  return actor;
}

function buildMatchActor(options: {
  matchId: string; ruleset: RulesetConfig; settings?: Partial<EngineSettings>; timers?: unknown; lifecycle?: unknown; table?: unknown; membershipId?: string;
}, ports: ActorPorts, history: z.infer<typeof recordSchema>[] = []) {
  const matchId = z.string().min(1).max(128).parse(options.matchId);
  const timers = timersSchema.parse(options.timers ?? {});
  const lifecycleSettings = options.lifecycle === undefined ? undefined : lifecycleSettingsSchema.parse(options.lifecycle);
  const tableSettings = options.table === undefined ? undefined : tableSettingsSchema.parse(options.table);
  if (tableSettings && !lifecycleSettings) throw new Error('Table coordination requires seat lifecycle');
  if (lifecycleSettings && !ports.botDelayMs) throw new Error('Lifecycle requires a bot-delay source');
  let state = createEngine(options.ruleset, seatSchema.parse(ports.firstDealer()), options.settings);
  if (tableSettings && state.settings.preferences.every(seat => seat.isBot)) throw new Error('Table coordination requires a human seat');
  const { maxBid: _maxBid, totalPoints: _totalPoints, ...rawRuleset } = options.ruleset;
  const metadata: JournalRecord['metadata'] = { engineVersion: '1.0.0', matchId,
    dealer: state.progress.dealer, ruleset: rawRuleset, settings: state.settings, timers,
    ...(lifecycleSettings ? { lifecycle: lifecycleSettings } : {}), ...(tableSettings ? { table: tableSettings } : {}),
    ...(options.membershipId === undefined ? {} : { membershipId: z.string().uuid().parse(options.membershipId) }) };
  let table: TableState | undefined;
  let lifecycle: LifecycleState | undefined;
  let timing: Timing = null;
  let banks = [timers.timeBankMs, timers.timeBankMs, timers.timeBankMs, timers.timeBankMs];
  const viewers: Viewer[] = [0, 1, 2, 3, 'spectator'];
  const sequences = new Map<Viewer, number>(viewers.map(viewer => [viewer, 0]));
  const receipts = new Map<string, CommandResponse>();
  let chat = createChatState();
  let results = createHistoryState();
  let tail: Promise<unknown> = Promise.resolve();
  let cancel: (() => void) | undefined;
  let started = false;
  let stopped = false;
  let failed = false;
  let replaying: z.infer<typeof recordSchema> | undefined;
  let replayVerified = false;
  let lastRuntimeTime = 0;

  function now() {
    const value = replaying?.recordedAt ?? ports.now();
    if (!Number.isFinite(value) || value < Math.max(state.lastCommandTime, lastRuntimeTime)) throw new Error('Invalid runtime clock');
    return value;
  }
  function view(viewer: Viewer): ActorView {
    const snapshot = engineView(state, viewer);
    const deadline = table && table.phase !== 'PLAYING' ? table.deadline : timing?.deadline ?? null;
    const tableActions: TableAction[] = viewer === 'spectator' || !lifecycle?.seats[viewer].connected ||
      metadata.settings.preferences[viewer].isBot ? []
      : table?.phase === 'READY_CHECK' && !table.ready[viewer] ? [{ type: 'READY' }]
      : table?.phase === 'REMATCH' && table.votes[viewer] === null
        ? [{ type: 'REMATCH_VOTE', accept: true }, { type: 'REMATCH_VOTE', accept: false }] : [];
    return { ...snapshot, legalActions: table && table.phase !== 'PLAYING' ? tableActions : snapshot.legalActions,
      ...(table ? { table: structuredClone(table) } : {}), deadline,
      remainingMs: deadline === null ? 0 : Math.max(0, deadline - now()),
      timeBankMs: viewer === 'spectator' ? null : banks[viewer],
      ...(lifecycle ? { seats: lifecycle.seats.map(seat => ({ connected: seat.connected,
        controller: seat.controller, reclaimPending: seat.reclaimAfter !== null })) } : {}) };
  }
  function canChat(viewer: Viewer) {
    return viewer !== 'spectator' && !metadata.settings.preferences[viewer].isBot &&
      (!lifecycle || lifecycle.seats[viewer].connected);
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      if (failed || stopped) throw new Error('Match actor unavailable');
      try { return await work(); }
      catch (error) { failed = true; cancel?.(); throw error; }
    });
    tail = result.catch(() => undefined);
    return result;
  }
  function botToAct(engine: EngineState, presence: LifecycleState): Seat | null {
    if (engine.progress.status !== 'IN_PROGRESS') return null;
    const actor = engineToAct(engine);
    const candidates = actor === null && engine.phase === 'PAIR_WINDOW' ? SEATS : actor === null ? [] : [actor];
    return candidates.find(seat => presence.seats[seat].controller === 'bot' &&
      !(presence.seats[seat].connected && presence.seats[seat].reclaimAfter !== null &&
        presence.decision > presence.seats[seat].reclaimAfter!) &&
      baselineBotAction(engineView(engine, seat)) !== null) ?? null;
  }
  function abandonmentDeadline() {
    if (!lifecycle || !lifecycleSettings) return Infinity;
    const humans = SEATS.filter(seat => !metadata.settings.preferences[seat].isBot);
    if (humans.length === 0 || humans.some(seat => lifecycle!.seats[seat].connected)) return Infinity;
    return Math.max(...humans.map(seat => lifecycle!.seats[seat].disconnectedAt!)) + lifecycleSettings.abandonAfterMs;
  }
  function lifecycleDeadline() {
    if (!lifecycle || !lifecycleSettings) return Infinity;
    const grace = lifecycle.seats.filter(seat => !seat.connected && seat.controller === 'human')
      .map(seat => seat.disconnectedAt! + lifecycleSettings.disconnectGraceMs);
    return Math.min(...grace, abandonmentDeadline(), lifecycle.bot?.deadline ?? Infinity);
  }
  function presenceDeliveries(events: readonly RuntimeEvent['event'][], timestamp: number): JournalRecord['deliveries'] {
    return viewers.map(viewer => ({ viewer, events: events.map((event, index) => {
      const seq = sequences.get(viewer)! + index + 1;
      return { eventId: `${matchId}:${state.version}:${viewer}:${seq}`, matchId, timestamp, version: state.version, seq, event };
    }) }));
  }
  async function lifecycleOperation(operation: LifecycleOperation) {
    if (!lifecycle || !lifecycleSettings || (state.progress.status !== 'IN_PROGRESS' && !table)) return;
    if (table && table.phase !== 'PLAYING' && !['CONNECTION', 'RESTART_DISCONNECT', 'LEAVE'].includes(operation.type)) return;
    const next = structuredClone(lifecycle);
    const timestamp = now();
    const events: PresenceEvent[] = [];
    if (operation.type === 'RESTART_DISCONNECT') {
      for (const seat of SEATS) {
        if (!next.seats[seat].connected) continue;
        next.seats[seat].connected = false;
        next.seats[seat].disconnectedAt = timestamp;
        next.seats[seat].reclaimAfter = null;
        events.push({ type: 'PLAYER_DISCONNECTED', seat });
      }
      if (events.length === 0) return;
    } else {
      const seat = next.seats[operation.seat];
      if (metadata.settings.preferences[operation.seat].isBot) throw new Error('Seat is provisioned as a bot');
      if (operation.type === 'CONNECTION') {
        if (seat.connected === operation.connected) return;
        seat.connected = operation.connected;
        seat.disconnectedAt = operation.connected ? null : timestamp;
        seat.reclaimAfter = operation.connected && seat.controller === 'bot' ? next.decision : null;
        events.push({ type: operation.connected ? 'PLAYER_RECONNECTED' : 'PLAYER_DISCONNECTED', seat: operation.seat });
      } else if (operation.type === 'LEAVE') {
        if (!seat.connected) return;
        seat.connected = false; seat.disconnectedAt = timestamp; seat.reclaimAfter = null;
        events.push({ type: 'PLAYER_DISCONNECTED', seat: operation.seat });
        if (!table || table.phase === 'PLAYING') {
          if (seat.controller === 'human') events.push({ type: 'BOT_TOOK_OVER', seat: operation.seat });
          seat.controller = 'bot';
        }
      } else if (operation.type === 'TAKEOVER') {
        if (seat.connected || seat.controller !== 'human' || seat.disconnectedAt === null ||
            timestamp < seat.disconnectedAt + lifecycleSettings.disconnectGraceMs) throw new Error('Invalid takeover');
        seat.controller = 'bot';
        events.push({ type: 'BOT_TOOK_OVER', seat: operation.seat });
      } else {
        if (!seat.connected || seat.controller !== 'bot' || seat.reclaimAfter === null ||
            next.decision <= seat.reclaimAfter) throw new Error('Invalid reclaim');
        seat.controller = 'human'; seat.reclaimAfter = null;
        events.push({ type: 'PLAYER_RECLAIMED', seat: operation.seat });
      }
      if (operation.type !== 'CONNECTION' && (!table || table.phase === 'PLAYING')) {
        const result = await apply({ actor: 'system', now: timestamp, expectedVersion: state.version,
          action: { type: 'SET_BOT', seat: operation.seat, isBot: seat.controller === 'bot' } },
        undefined, { lifecycle: next, lifecycleOperation: operation, events });
        if (!result.ok) throw new Error('Controller transition rejected');
        return;
      }
    }
    await persist({ recordedAt: timestamp, input: null, state, timing, banks, lifecycle: next, lifecycleOperation: operation,
      deliveries: presenceDeliveries(events, timestamp) });
    arm();
  }
  async function settleReclaims() {
    if (!lifecycle || state.progress.status !== 'IN_PROGRESS' || (table && table.phase !== 'PLAYING')) return;
    for (const seat of SEATS) {
      const presence = lifecycle.seats[seat];
      if (presence.connected && presence.reclaimAfter !== null && lifecycle.decision > presence.reclaimAfter) {
        await lifecycleOperation({ type: 'RECLAIM', seat });
      }
    }
  }
  async function lifecycleTimeout(timestamp: number) {
    if (!lifecycle || !lifecycleSettings || state.progress.status !== 'IN_PROGRESS') return false;
    if (timestamp >= abandonmentDeadline()) {
      await apply({ actor: 'system', now: timestamp, expectedVersion: state.version, action: { type: 'ABANDON' } });
      return true;
    }
    const seat = SEATS.find(candidate => {
      const presence = lifecycle!.seats[candidate];
      return !presence.connected && presence.controller === 'human' && presence.disconnectedAt !== null &&
        timestamp >= presence.disconnectedAt + lifecycleSettings.disconnectGraceMs;
    });
    if (seat !== undefined) {
      await lifecycleOperation({ type: 'TAKEOVER', seat }); return true;
    }
    if (lifecycle.bot && timestamp >= lifecycle.bot.deadline && (!timing || timestamp < timing.deadline)) {
      const actor = lifecycle.bot.seat;
      const action = baselineBotAction(engineView(state, actor));
      if (!action) throw new Error('Scheduled bot has no legal action');
      const result = await apply({ actor, now: timestamp, expectedVersion: state.version, action });
      if (!result.ok) throw new Error('Bot decision rejected');
      await nextDeal();
      return true;
    }
    return false;
  }
  function arm() {
    if (replaying) return;
    cancel?.();
    if (stopped || (state.progress.status !== 'IN_PROGRESS' && !table)) return;
    const deadline = table && table.phase !== 'PLAYING' ? table.deadline ?? Infinity
      : Math.min(timing?.deadline ?? Infinity, lifecycleDeadline());
    if (!Number.isFinite(deadline)) return;
    const scheduledLifecycle = lifecycle;
    const scheduledTable = table;
    const version = state.version;
    cancel = ports.schedule(deadline, () => {
      void enqueue(async () => {
        if (state.version !== version || lifecycle !== scheduledLifecycle || table !== scheduledTable) return;
        const timestamp = now();
        if (timestamp < deadline) { arm(); return; }
        if (table && table.phase !== 'PLAYING') { await expireTableWindow(); return; }
        // Seats can share a grace deadline. Commit all due lifecycle work in this
        // queue turn instead of leaving other seats to zero-delay callbacks.
        while (await lifecycleTimeout(timestamp)) {
          await settleReclaims();
          if (state.progress.status !== 'IN_PROGRESS') return;
        }
        if (!timing || timestamp < timing.deadline) { arm(); return; }
        if (await extendBank(timestamp)) {
          arm();
          return;
        }
        await apply({ actor: 'system', now: timestamp, expectedVersion: state.version,
          action: { type: 'TIMEOUT', decisionVersion: state.version } });
        await nextDeal();
        await settleReclaims();
      }).catch(ports.onError);
    });
  }
  async function extendBank(timestamp: number) {
    if (timing === null || timestamp < timing.deadline || timing.seat === null || timing.bankUsed || banks[timing.seat] === 0) return false;
    const nextBanks = [...banks];
    const extension = nextBanks[timing.seat];
    nextBanks[timing.seat] = 0;
    const nextTiming = { ...timing, bankUsed: true, deadline: timing.deadline + extension };
    const deliveries = viewers.map(viewer => ({ viewer, events: [{
      eventId: `${matchId}:${state.version}:bank:${viewer}`, matchId, timestamp,
      version: state.version, seq: sequences.get(viewer)! + 1,
      event: { type: 'TURN' as const, seat: timing!.seat, deadline: nextTiming.deadline,
        remainingMs: Math.max(0, nextTiming.deadline - timestamp) },
    }] }));
    await persist({ recordedAt: timestamp, input: null, state, timing: nextTiming, banks: nextBanks, deliveries });
    return true;
  }
  async function persist(entry: Omit<JournalRecord, 'metadata' | 'recordedAt'> & { recordedAt?: number }) {
    const timestamp = entry.recordedAt ?? entry.input?.now ?? now();
    const record: JournalRecord = { metadata, ...entry, recordedAt: timestamp };
    if (lifecycleSettings) {
      const next = structuredClone(entry.lifecycle ?? lifecycle ?? {
        seats: SEATS.map(seat => ({ connected: false, disconnectedAt: timestamp,
          controller: metadata.settings.preferences[seat].isBot ? 'bot' as const : 'human' as const, reclaimAfter: null })),
        decision: 0, bot: null,
      });
      if (entry.state.version !== state.version && entry.input &&
          !['SET_BOT', 'CALL_TRUMP', 'REVEAL_TRUMP'].includes(entry.input.action.type)) next.decision++;
      const botSeat = botToAct(entry.state, next);
      if (botSeat === null) next.bot = null;
      else if (next.bot?.seat !== botSeat || next.bot.version !== entry.state.version) {
        const delay = z.number().int().min(600).max(1500).parse(replaying ? replaying.botDelayMs : ports.botDelayMs!());
        record.botDelayMs = delay;
        next.bot = { seat: botSeat, version: entry.state.version, deadline: timestamp + delay };
      }
      record.lifecycle = next;
    }
    if (tableSettings) {
      record.table = reconcileTable(entry.table ?? table ?? createTableSession(),
        record.lifecycle!.seats.map(seat => seat.connected), metadata.settings.preferences.map(seat => seat.isBot),
        entry.state.progress.status !== 'IN_PROGRESS', timestamp, tableSettings);
      if (!isDeepStrictEqual(record.table, table)) {
        record.deliveries = viewers.map(viewer => {
          const events = [...(entry.deliveries.find(delivery => delivery.viewer === viewer)?.events ?? [])];
          const seq = (events.at(-1)?.seq ?? sequences.get(viewer)!) + 1;
          events.push({ eventId: `${matchId}:${entry.state.version}:${viewer}:${seq}`, matchId,
            timestamp, version: entry.state.version, seq, event: { type: 'TABLE_UPDATED', table: record.table! } });
          return { viewer, events };
        });
      }
    }
    if (replaying) {
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(record)), replaying)) throw new Error('Journal replay mismatch');
      replayVerified = true;
    } else await ports.append(structuredClone(record));
    state = record.state; timing = record.timing; banks = [...record.banks]; lastRuntimeTime = timestamp;
    lifecycle = record.lifecycle;
    table = record.table;
    if (record.receipt) receipts.set(`${record.receipt.seat}:${record.receipt.command.commandId}`, structuredClone(record.receipt.response));
    if (record.receipt?.response.ok && record.receipt.command.action.type === 'QUICK_CHAT') {
      const { seat } = record.receipt;
      const accepted = acceptQuickChat(chat, seat, record.receipt.command.action.phraseId,
        `${matchId}:chat:${chat.nextId}`, timestamp);
      if (!accepted.ok) throw new Error('Committed chat violates cooldown');
      chat = accepted.state;
    }
    results = recordHistory(results, table?.matchNumber ?? 1, timestamp, state.progress.gameScores,
      record.deliveries.find(delivery => delivery.viewer === 'spectator')?.events.map(entry => entry.event) ?? []);
    for (const { viewer, events } of record.deliveries) {
      if (events.length > 0) sequences.set(viewer, events[events.length - 1].seq);
      try { if (!replaying) ports.publish(viewer, structuredClone(events)); }
      catch (error) { ports.onError(error); }
    }
  }
  async function apply(input: EngineInput, receipt?: { seat: Seat; command: z.infer<typeof commandSchema> },
    presence?: { lifecycle: LifecycleState; lifecycleOperation: LifecycleOperation; events: PresenceEvent[] }) {
    const previous = state;
    const result = applyEngineCommand(state, input);
    const response: CommandResponse = { commandId: receipt?.command.commandId ?? null,
      ok: result.ok, version: result.state.version,
      ...(!result.ok ? { code: result.code,
        ...(result.code === 'STALE_STATE' && receipt ? { snapshot: view(receipt.seat) } : {}) } : {}) };
    let nextTiming = timing;
    if (result.ok) {
      const seat = engineToAct(result.state);
      const fixed = result.state.pairWindow?.deadline ?? result.state.progress.redealDeadline;
      const revealContinues = input.action.type === 'CALL_TRUMP' || input.action.type === 'REVEAL_TRUMP';
      nextTiming = fixed !== null ? { seat: null, deadline: fixed, bankUsed: true, version: result.state.version }
        : seat === null ? null
        : input.action.type === 'SET_BOT' && timing !== null
          ? { ...timing, version: result.state.version }
        : revealContinues && timing !== null && previous.phase === 'PLAY' && seat === timing.seat
          ? { ...timing, version: result.state.version }
          : { seat, deadline: input.now + (result.state.phase === 'DOUBLING' ? timers.doubleMs : timers.turnMs),
            bankUsed: false, version: result.state.version };
    }
    const deliveries: JournalRecord['deliveries'] = viewers.map(viewer => ({ viewer,
      events: recipientEvents(result.events, viewer, result.state.version, sequences.get(viewer), state.settings.showCapturedPoints)
        .map(entry => ({ ...entry, eventId: `${matchId}:${entry.version}:${viewer}:${entry.seq}`, matchId, timestamp: input.now,
          event: entry.event.type === 'TURN' ? { ...entry.event, deadline: nextTiming?.deadline ?? null,
            remainingMs: nextTiming ? Math.max(0, nextTiming.deadline - input.now) : 0 } : entry.event })),
    }));
    if (presence) {
      for (const delivery of deliveries) {
        const events = delivery.events as RuntimeEvent[];
        for (const event of presence.events) {
          const seq = (events[events.length - 1]?.seq ?? sequences.get(delivery.viewer)!) + 1;
          events.push({ eventId: `${matchId}:${result.state.version}:${delivery.viewer}:${seq}`, matchId,
            timestamp: input.now, version: result.state.version, seq, event });
        }
      }
    }
    await persist({ input, state: result.state, timing: nextTiming, banks, deliveries,
      ...(receipt ? { receipt: { ...receipt, response } } : {}),
      ...(presence ? { lifecycle: presence.lifecycle, lifecycleOperation: presence.lifecycleOperation } : {}) });
    arm();
    return response;
  }
  async function nextDeal() {
    if (state.phase === 'AWAITING_DEAL' && (!tableSettings || table?.phase === 'PLAYING')) {
      await apply({ actor: 'system', now: now(), expectedVersion: state.version,
        action: { type: 'START_DEAL', deck: ports.shuffle() } });
    }
  }
  async function initializeTable() {
    if (!tableSettings || table || state.version !== 0) throw new Error('Invalid table initialization');
    await persist({ input: null, state, timing, banks, deliveries: [], table: createTableSession(), tableOperation: 'INIT' });
  }
  async function expireTableWindow() {
    if (!table || !lifecycle) throw new Error('Table coordination unavailable');
    const timestamp = now();
    const result = expireTable(table, timestamp);
    const nextLifecycle = structuredClone(lifecycle);
    for (const seat of result.removed) {
      nextLifecycle.seats[seat] = { ...nextLifecycle.seats[seat], connected: false, disconnectedAt: timestamp, reclaimAfter: null };
    }
    await persist({ recordedAt: timestamp, input: null, state, timing, banks, lifecycle: nextLifecycle,
      table: result.table, tableOperation: 'EXPIRE', deliveries: result.removed.length === 0 ? []
        : presenceDeliveries([{ type: 'READY_FAILED', seats: result.removed }], timestamp) });
    arm();
  }
  async function dispatchTable(seat: Seat, command: Extract<z.infer<typeof commandSchema>, { expectedCheckId: number }>) {
    const timestamp = now();
    const result = !table || !lifecycle ? { ok: false as const, code: 'TABLE_COORDINATION_DISABLED' }
      : command.expectedVersion !== state.version ? { ok: false as const, code: 'STALE_STATE' }
      : applyTableAction(table, seat, command.action, command.expectedCheckId,
        lifecycle.seats.map(seat => seat.connected), metadata.settings.preferences.map(seat => seat.isBot), timestamp);
    let nextState = state;
    let nextBanks = banks;
    let nextLifecycle = lifecycle;
    let rematchDealer: Seat | undefined;
    if (result.ok && result.table.matchNumber !== table!.matchNumber) {
      rematchDealer = seatSchema.parse(replaying ? replaying.rematchDealer : ports.firstDealer());
      const fresh = createEngine(options.ruleset, rematchDealer, metadata.settings);
      // Engine versions, recipient cursors, and receipts remain table-scoped so
      // delayed commands from an earlier match can never acquire fresh authority.
      nextState = { ...fresh, version: state.version + 1, lastCommandTime: timestamp };
      nextBanks = [timers.timeBankMs, timers.timeBankMs, timers.timeBankMs, timers.timeBankMs];
      nextLifecycle = { seats: lifecycle!.seats.map((seat, index) => ({ connected: seat.connected,
        disconnectedAt: seat.connected ? null : timestamp, reclaimAfter: null,
        controller: metadata.settings.preferences[index].isBot ? 'bot' as const : 'human' as const })), decision: 0, bot: null };
    }
    const response: CommandResponse = { commandId: command.commandId, ok: result.ok, version: nextState.version,
      ...(!result.ok ? { code: result.code } : {}) };
    await persist({ recordedAt: timestamp, input: null, state: nextState, timing: result.ok && rematchDealer !== undefined ? null : timing,
      banks: nextBanks, deliveries: [], ...(nextLifecycle ? { lifecycle: nextLifecycle } : {}),
      ...(result.ok ? { table: result.table } : {}), ...(rematchDealer !== undefined ? { rematchDealer } : {}),
      receipt: { seat, command, response } });
    if (!replaying) await nextDeal();
    arm(); return structuredClone(response);
  }
  async function dispatchChat(seat: Seat, command: z.infer<typeof commandSchema>, phraseId: ChatMessage['phraseId']) {
    const timestamp = now();
    const accepted = !canChat(seat) ? { ok: false as const, code: 'SEAT_NOT_CONNECTED' }
      : command.expectedVersion !== state.version ? { ok: false as const, code: 'STALE_STATE' }
      : acceptQuickChat(chat, seat, phraseId, `${matchId}:chat:${chat.nextId}`, timestamp);
    const response: CommandResponse = { commandId: command.commandId, ok: accepted.ok, version: state.version,
      ...(accepted.ok ? { chatMessageId: accepted.message.id } : { code: accepted.code }) };
    await persist({ recordedAt: timestamp, input: null, state, timing, banks,
      deliveries: accepted.ok ? presenceDeliveries([{ type: 'CHAT_MESSAGE', message: accepted.message }], timestamp) : [],
      receipt: { seat, command, response } });
    arm(); return structuredClone(response);
  }
  async function dispatch(seat: Seat, raw: unknown): Promise<CommandResponse> {
    if (!started && !replaying) throw new Error('Match actor not started');
    const parsed = commandSchema.safeParse(raw);
    if (!seatSchema.safeParse(seat).success || !parsed.success || parsed.data.matchId !== matchId) {
      return { commandId: null, ok: false, version: state.version, code: 'INVALID_COMMAND' };
    }
    const command = parsed.data;
    const duplicate = receipts.get(`${seat}:${command.commandId}`);
    if (duplicate) return structuredClone(duplicate);
    const timestamp = now();
    if (table?.deadline !== null && table?.deadline !== undefined && timestamp >= table.deadline && !replaying) await expireTableWindow();
    if ('expectedCheckId' in command) return dispatchTable(seat, command);
    if (command.action.type === 'QUICK_CHAT') return dispatchChat(seat, command, command.action.phraseId);
    if (table && table.phase !== 'PLAYING') {
      const response: CommandResponse = { commandId: command.commandId, ok: false, version: state.version, code: 'TABLE_NOT_PLAYING' };
      await persist({ input: null, state, timing, banks, deliveries: [], receipt: { seat, command, response } });
      arm(); return response;
    }
    if (lifecycle && (!lifecycle.seats[seat].connected || lifecycle.seats[seat].controller === 'bot')) {
      const response: CommandResponse = { commandId: command.commandId, ok: false, version: state.version, code: 'SEAT_NOT_CONTROLLED' };
      await persist({ recordedAt: timestamp, input: null, state, timing, banks, deliveries: [], receipt: { seat, command, response } });
      if (lifecycle) arm();
      return response;
    }
    if (timing !== null && timestamp >= timing.deadline && command.expectedVersion === state.version) {
      const response: CommandResponse = { commandId: command.commandId, ok: false, version: state.version, code: 'TURN_EXPIRED' };
      await persist({ recordedAt: timestamp, input: null, state, timing, banks, deliveries: [], receipt: { seat, command, response } });
      if (lifecycle) arm();
      return response;
    }
    const response = await apply({ actor: seat, now: timestamp, expectedVersion: command.expectedVersion, action: command.action }, { seat, command });
    if (!replaying) { await nextDeal(); await settleReclaims(); }
    return structuredClone(response);
  }
  return {
    start: () => enqueue(async () => {
      if (started) return;
      for (const record of history) {
        replaying = record;
        replayVerified = false;
        if (record.tableOperation === 'INIT') await initializeTable();
        else if (record.tableOperation === 'EXPIRE') await expireTableWindow();
        else if (record.lifecycleOperation) await lifecycleOperation(record.lifecycleOperation);
        else if (record.receipt) await dispatch(record.receipt.seat, record.receipt.command);
        else if (record.input) {
          if (record.input.now !== record.recordedAt) throw new Error('Journal time mismatch');
          if (record.input.actor !== 'system') {
            if (!lifecycle?.bot || lifecycle.bot.seat !== record.input.actor) throw new Error('Recorded bot does not control decision');
            if (record.recordedAt < lifecycle.bot.deadline) throw new Error('Recorded bot acted before deadline');
            if (timing && record.recordedAt >= timing.deadline) throw new Error('Recorded bot acted after turn expiry');
            const action = JSON.parse(JSON.stringify(baselineBotAction(engineView(state, record.input.actor))));
            if (!isDeepStrictEqual(record.input.action, action)) {
              throw new Error('Recorded bot policy mismatch');
            }
          }
          await apply(record.input);
        } else if (!await extendBank(record.recordedAt)) throw new Error('Invalid journal timer transition');
        if (!replayVerified) throw new Error('Unverified journal record');
      }
      replaying = undefined;
      if (tableSettings && !table) await initializeTable();
      await nextDeal(); started = true;
      if (history.length > 0) await lifecycleOperation({ type: 'RESTART_DISCONNECT' });
      await settleReclaims();
      arm();
    }),
    dispatch: (seat: Seat, raw: unknown) => enqueue(() => dispatch(seat, raw)),
    setConnected: (seat: Seat, connected: boolean) => enqueue(async () => {
      seatSchema.parse(seat);
      if (!started) throw new Error('Match actor not started');
      if (table?.deadline !== null && table?.deadline !== undefined && now() >= table.deadline) await expireTableWindow();
      if (connected && lifecycle && lifecycleSettings && state.progress.status === 'IN_PROGRESS' && (!table || table.phase === 'PLAYING')) {
        const timestamp = now();
        if (timestamp >= abandonmentDeadline()) {
          await apply({ actor: 'system', now: timestamp, expectedVersion: state.version, action: { type: 'ABANDON' } });
          // The old match is irreversibly abandoned, but this authenticated
          // connection can still participate in the newly opened rematch vote.
          if (table) await lifecycleOperation({ type: 'CONNECTION', seat, connected });
          return;
        }
        const presence = lifecycle.seats[seat];
        if (!presence.connected && presence.controller === 'human' && presence.disconnectedAt !== null &&
            timestamp >= presence.disconnectedAt + lifecycleSettings.disconnectGraceMs) {
          await lifecycleOperation({ type: 'TAKEOVER', seat });
        }
      }
      await lifecycleOperation({ type: 'CONNECTION', seat, connected });
    }),
    leave: (seat: Seat) => enqueue(async () => {
      seatSchema.parse(seat);
      if (!started || !lifecycle) throw new Error('Seat lifecycle unavailable');
      await lifecycleOperation({ type: 'LEAVE', seat });
    }),
    getView: (viewer: Viewer) => {
      if (viewer !== 'spectator') seatSchema.parse(viewer);
      if (failed || stopped || !started) throw new Error('Match actor unavailable');
      // Add chat only to live views. Cached rejection snapshots must retain their
      // original shape so older journal receipts still verify unchanged.
      return { ...view(viewer), chat: { canSend: canChat(viewer),
        remainingMs: viewer === 'spectator' ? 0 : chatRemainingMs(chat, viewer, now()),
        cooldownStartedAt: viewer === 'spectator' ? null : chat.lastSent[viewer], messages: structuredClone(chat.messages) } };
    },
    getHistory: (viewer: Viewer, query: HistoryQuery) => {
      if (viewer !== 'spectator') seatSchema.parse(viewer);
      if (failed || stopped || !started) throw new Error('Match actor unavailable');
      return historyPage(results, query);
    },
    getSequence: (viewer: Viewer) => {
      if (viewer !== 'spectator') seatSchema.parse(viewer);
      return sequences.get(viewer)!;
    },
    stop: () => { stopped = true; cancel?.(); },
    async shutdown() {
      stopped = true; cancel?.();
      await tail;
    },
  };
}
