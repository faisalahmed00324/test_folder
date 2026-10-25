# Twenty-Nine And Twenty-Eight

Mobile-first online card game with a pure rules engine and server-runtime foundations.
The baseline is [the production specification](doc/Twenty-Nine%20%26%20Twenty-Eight%20Production%20Rules%20and%20Engine%20Specification.md).
See [implementation notes](doc/implementation-notes.md) for interpretations and
unresolved decisions.

## Implemented

- A 32-card deck, stable IDs, J > 9 > A > T > K > Q > 8 > 7 ranking, 28 card points.
- Physical seats, opposite partnerships, clockwise/counterclockwise order.
- Pure two-packet dealing, preserving received-card order and seventh-card position.
- Strict Zod validation and deeply frozen `29-standard@1.0.0`,
  `29-simplified@1.0.0`, and `28-standard@1.0.0` presets with derived point limits.
- Pure priority-duel and open-ascending auctions, forced/optional opening, permanent
  passes, automatic passes, partner-overbid limits, and Twenty-Eight second rounds.
- Auction legal actions, immutable transitions, rejection codes, deterministic
  timeout defaults, and trump-selection instructions for the future hand engine.
- TypeScript compilation and Jest tests exercising production modules.
- Face-down/external trump selection, optional seventh-card concealment, private
  second-packet events, declarer-only trump knowledge, and Twenty-Eight reselection.
- Ordered double/redouble decisions, stakes 1/2/4, and deterministic pass defaults.
- Legal play, follow-suit checks, hidden-trump lead restrictions, atomic revelation,
  persistent reveal-turn obligations, and position-aware trick resolution.
- Eight-trick play with card points, optional last-trick bonus, final-trick automatic
  revelation, deterministic play timeouts, and explicit between-trick boundaries.
- Automatic/manual pair declarations, fixed preference-driven windows, clamped
  target adjustments, original-bid scoring bands, and complete hand summaries.
- Match scores, threshold endings, dealer rotation, abandonment, all-pass/fault
  redeals, and fixed pointless-four windows with eligibility/deadline checks.
- A pure coordinator connecting every hand phase, automatic transitions, timeout
  defaults, system-only operations, and versioned command validation.
- Explicit seat/spectator views, recipient-filtered sequential events, per-command
  card/point/lifecycle invariants, and deterministic recorded-command replay.

The application match actor adds serialized commands, seat-scoped command-ID
idempotency (accepted and rejected results), append-before-publish journal hooks,
filtered event envelopes, automatic fresh deals, deadlines, and per-seat time banks.
Node adapters provide crypto Fisher-Yates shuffling, random first-dealer selection,
and cancellable timers. An encrypted local append-only journal persists transitions
before publication. Verified restart replay restores deadlines, banks, receipts,
and recipient sequences. Runtime tests use injected effects and fake time.

An injectable WebSocket gateway now provides authenticated seat routing, strict
protocol validation, private event delivery, bounded current-hand resume buffers,
snapshot fallback, heartbeats, rate limits, and slow-consumer protection.

A runnable single-table private Node host wires authentication, encrypted journal
recovery, crypto randomness, deadlines, and the WebSocket gateway. It supports
pre-provisioned expiring seat tokens or optional invite-only seating with a separate
encrypted membership journal. Only credential hashes are stored by either mode.

Seat lifecycle is persisted by the same actor: disconnect grace periods,
filtered-view baseline bots, turn-boundary reclaim, explicit leave, and all-human
abandonment. Recovery restores lifecycle deadlines and verifies recorded bot moves.

A bundled React/TypeScript private-table preview is available at
`/29_Card/index.html`. It supports authenticated joining, bidding, trump selection,
doubling, legal card play, pair/redeal actions, spectators, reconnects, and leave.
New private tables wait for authenticated ready consent and offer unanimous rematch
votes after match end. Fixed-list quick chat and a recoverable completed-result
browser are available in the same UI. This is not a fully conformant release:
account services, public seating/seat management, quick match/parties, account-wide history,
and public deployment remain unfinished.
Internal deal, trump, and play states contain hidden information and MUST NOT be
serialized to clients.

## Delivery Order

1. Foundation and configuration (implemented).
2. Auctions, trump selection, doubling, legal play, revelation, tricks, pairs,
   contract scoring, and match progress (implemented as standalone rule modules).
3. Full hand-phase coordination, filtered views/events, invariants, and replay
   (implemented for the pure engine; production persistence/runtime remain).
4. Node.js runtime, local encrypted storage/recovery, and injectable WebSocket
   gateway/reconnect adapter, and single-table host with expiring credentials
   and persisted disconnect/bot/reclaim/abandon lifecycle (implemented). Account
   integration, deployment operations, and release gates remain.
5. React/TypeScript private tables, accessible portrait play, baseline bots, and
   durable ready checks/rematches, and invite-only first-claim seating (implemented).
6. Fixed-list chat and bounded completed table history (implemented). Casual quick
   match, parties, public lobby/seat management, and account-wide history remain.
7. Statistical, network, recovery, performance, and conformance release gates.

Ranked play, native packaging, push notifications, and optional fairness commitments
are deferred. Regional defaults still require confirmation before release.

## Development

Run from the root using the pinned Corepack Yarn:

```sh
corepack yarn typecheck
corepack yarn test:unit --coverage
corepack yarn build:engine
corepack yarn build:ui
corepack yarn invite:29
corepack yarn check
```

Jest transforms TypeScript/TSX using the installed compiler; `typecheck` is the
separate semantic gate. Unit tests live in `tests/unit/**/*.test.cjs`. React tests
use Testing Library and jsdom; actual browser tests are in `tests/e2e`. Engine
compilation goes to `.build/29-card/`, never the static `dist/` allowlist. The
esbuild browser bundle goes to `.build/29-ui/`; the production build publishes
only the HTML, bundled JS, and CSS through `server.js`'s asset allowlist. Browser
bundles include no actor, journal, server entry point, source maps, or test driver.
Carrom remains unchanged.

## Play In A Browser

1. Configure and start the private WebSocket host as described below. For local
   play, include `http://127.0.0.1:8765` in its `allowedOrigins`. Origin spelling
   matters: `localhost` and `127.0.0.1` are different origins.
2. From the repository root run `corepack yarn build:ui`, then
   `corepack yarn start` in a separate terminal for the existing static server.
3. Open `http://127.0.0.1:8765/29_Card/index.html`. Enter
   `ws://127.0.0.1:8766/29-card/ws` and the raw seat token provided by the host.
   Use a different browser profile/private window for each player. An explicitly
   provisioned spectator token opens a read-only table. The root URL still opens
   Carrom; this bundled React app does not support opening its HTML as a file.
4. Once all four human seats are connected, each taps **Ready** within 15 seconds.
   No cards are dealt and no gameplay timers run before unanimous consent. Then
   bid, conceal/select trump, double/pass, and play enabled cards using the same
   labeled controls on desktop or portrait mobile. Only server-provided legal
   actions are enabled; the client does not calculate game rules. Your hand stays
   in received order and other seats expose card counts, not private cards.

For a production-origin UI, route `/29-card/ws` to the private host behind your TLS
proxy and use `wss://<your-origin>/29-card/ws`; the HTTPS page defaults to this
address. Remote plaintext WebSockets, URL credentials, query tokens, and alternate
paths are rejected. Seat tokens stay in memory (including an explicit pre-claim
save panel), never app browser storage, query strings, or published assets. Invitation
links use a fragment, which the UI removes before connecting. Explicit disconnect, leave, session
expiry, and protocol failure clear private cards. Reloading requires re-entering
the token. Disconnect has a grace interval; leave immediately yields to a bot.

The client refreshes authoritative filtered snapshots after sequenced game events,
coalescing requests and locking stale controls. It does not duplicate server game
transitions in an event reducer. Unexpected disconnects retry with bounded backoff;
an uncertain in-memory command retains its UUID and expected version across that
reconnect, so the actor's idempotency receipt decides its outcome. Authentication
or schema errors fail closed; missing view/receipt responses surface a timeout
rather than leaving controls stuck. This snapshot-first approach is intentionally
not yet the low-bandwidth or impaired-network release implementation.

Scores, current tricks, permitted history, bot/reclaim status, and a monotonic
countdown are visible. Live `HAND_SCORED` summaries remain visible through the next
automatic deal, including all eight tricks. **Latest results** retrieves completed
hands and match outcomes even after a fresh join, rematch, or verified host restart
(within the retained browsing window described below).
After match end, all connected human owners can accept or decline a rematch within
20 seconds. A successful rematch keeps the table connection and seats, chooses a
fresh random first dealer, and resets scores, hands, controllers, and time banks.

## Invite-Only Seating

Existing `members` configurations continue working unchanged. For a new private
table without individually pre-provisioned seats:

1. Run `corepack yarn invite:29`. It prints a `tokenHash` for private configuration
   and a secret invitation `link`. Defaults use the local page/server ports above.
   For a TLS deployment, pass:

   ```sh
   corepack yarn invite:29 --page=https://cards.example.com/29_Card/index.html --server=wss://cards.example.com/29-card/ws
   ```

2. In your mode-`0600` server configuration, use `invitation` **instead of**
   `members`. Supply two distinct journal paths in a private mode-`0700` directory
   outside the repository. Example (replace the hash, paths, and expiration):

   ```json
   {
     "matchId": "friends-table-1",
     "preset": "29-standard",
     "port": 8766,
     "allowedOrigins": ["http://127.0.0.1:8765"],
     "journalPath": "/private/server-owned-directory/friends-game.journal",
     "invitation": {
       "tokenHash": "<sha256-hex-from-invite-command>",
       "expiresAt": 1900000000000,
       "journalPath": "/private/server-owned-directory/friends-memberships.journal"
     }
   }
   ```

   Use the existing `CARD29_CONFIG`/`CARD29_JOURNAL_KEY` setup and
   `corepack yarn start:29`. Readiness must be enabled; `table: false` is rejected
   in invite mode. The preset, lifecycle, and ready/rematch defaults still apply.
3. Share the invitation privately with trusted players. Opening it prefills the
   masked access field and server address, removes the fragment from the visible
   URL, and waits for **Join private table**; it never auto-connects. Verify the
   server address before joining. A fragment is not sent in HTTP requests, but the
   original link is still a bearer secret in messages/bookmarks/screenshots—do not
   publish it, log it, or include it in analytics.
4. Each guest sees availability only and selects a vacant seat. The browser creates
   a separate 32-byte cryptographic reconnect token. **Save it securely, then tap
   “I saved this token — claim Seat …”**. Selecting a seat alone makes no claim.
   The server durably reserves the seat before acknowledging it; competing claims
   cannot overwrite the winner. Failed clipboard access offers manual reveal/copy.
5. Once claimed, that connection gets only its assigned seat's normal private view.
   All four owners must connect and confirm readiness before dealing. To return
   after reload/disconnect, enter the saved reconnect token—not the shared invite.
   The invitation cannot recover, transfer, or replace an occupied seat.

### Boundaries And Recovery

- Invitation holders authenticate as `guest`, not as a player or spectator.
  Guests receive only `LOBBY` seat availability; they cannot read game snapshots,
  cards, chat, history, or submit game/ready/rematch commands. The wire uses
  `GET_LOBBY` and a strict `TAKE_SEAT` containing a private UUID `requestId`, requested
  seat index 0–3, and the new reconnect token. Requesting a seat is allowed only
  before the first deal, never as a way to choose an actor for game commands.
  Identical availability pushes are suppressed, rather than signaling unrelated
  ready/rematch game events to unseated guests.
- `SEAT_RESULT` echoes that request ID with `result: { ok, seat, expiresAt }` on
  success or a public failure code. Only the guest's existing connection receives
  this result; no token, token hash, or claim nonce is broadcast in the lobby.
  Accepted retries require the same nonce, seat, and credential hash. Lost
  acknowledgements can retry safely; a closed socket is never marked connected
  after a pending durable claim finishes. The client swaps its in-memory invite
  credential for the saved seat token only after the matching acknowledgement.
- Ownership remains reserved across disconnects, ready timeouts, leave, rematches,
  and restarts. A ready timeout reopens the connection for the same owner; it does
  not give an invite holder that person's seat. There is no host reassignment,
  account recovery, per-person identity check, or public seat release yet. Someone
  holding the shared invite can claim multiple seats using separate browsers;
  only trusted private groups should use it. This is not ranked/public admission.
- The invitation and all its claimed credentials expire at `invitation.expiresAt`
  (Unix milliseconds). Choose a bounded lifetime sufficient for the planned games.
  There is no online refresh/revocation service. After expiry, provision a new table
  with fresh credentials/journals rather than editing ownership records.
- The membership ledger stores one opening and at most four accepted claims,
  containing hashes only. It uses the existing encrypted, fsynced, single-writer
  journal adapter under a distinct authenticated namespace. Its random authority ID
  is bound into the game journal metadata. Startup rejects missing claimed journals,
  mismatched authorities, changed invite configuration, and silent conversion from
  pre-provisioned to invite mode. Use a fresh pair for a new mode/table.
- Back up **both journals and the key together**. The same stale-lock procedure
  applies to both `.lock` files; never remove a live lock. Binding detects mismatched
  pairs but is not a distributed lease or a trusted anti-rollback checkpoint.
  General public invites/codes, online table creation, seat transfer, spectator
  admission in invite mode, parties, and quick matchmaking are still later work.

## Ready Checks And Rematches

The actor journals table coordination alongside game transitions; React only
renders the server's ready/vote controls and public per-seat consent indicators.

- `table.phase` is `WAITING`, `READY_CHECK`, `PLAYING`, `REMATCH`, or `CLOSED`.
  The snapshot includes a `checkId`, `matchNumber`, ready flags, rematch votes, and
  absolute window deadline. `TABLE_UPDATED` events invalidate browser snapshots.
- Readiness begins only once all originally human seats are connected. Disconnect
  or leave cancels that check and clears its confirmations. At expiry, unconfirmed
  seats are marked offline and their sockets close with `READY_CHECK_EXPIRED` in
  the UI. Ready players stay connected. The private slots reopen only to their
   assigned owner's credentials; there is no public seat transfer or bot-fill API.
- `READY` and `REMATCH_VOTE` use the usual `COMMAND`/`RESULT` envelope, with the
  extra required `expectedCheckId` from the current snapshot. Example:

  ```json
  { "type": "COMMAND", "command": {
    "commandId": "00000000-0000-4000-8000-000000000001",
    "matchId": "private-table-1", "expectedVersion": 0, "expectedCheckId": 1,
    "action": { "type": "READY" }
  } }
  ```

  A rematch action is `{ "type": "REMATCH_VOTE", "accept": true }` or `false`.
  Spectators cannot consent. Originally human owners must consent themselves,
  even if disconnect bots finished their match. Stale checks and retries cannot
  confirm another round; command IDs retain accepted/rejected receipts.
- A vote is cleared if its owner disconnects. Reconnecting can re-vote only before
  the original rematch deadline. Any decline or expiry closes the offer; no dealer
  is drawn, no new cards are dealt, and the host must provision a new table to
  continue. An abandoned match can offer a rematch but cannot itself be revived.
- The wire `matchId` remains the private table's stable routing/journal ID.
  `table.matchNumber` distinguishes successive matches. Engine versions and recipient
  cursors stay monotonic, and command receipts remain table-scoped. Gateway quotas
  do not reset on a rematch (but are still in-memory across host restarts).
  No old move gains authority when match scores reset. This is private-table
  coordination, not the future public lobby's independently indexed match history.
- A new random dealer is persisted with unanimous rematch consent before the fresh
  deal. Recovery never re-draws it. A crash before the automatic deal recovers that
  pending deal exactly once. Replay also verifies ready/vote state and receipts.
  A restart cancels readiness because old sockets are gone; rematch votes from
  previously online owners clear, but their deadline is never extended.

New hosts enable `table: { "readyMs": 15000, "rematchMs": 20000 }` by default.
These positive bounded millisecond settings are durable; changing them against an
existing journal is rejected. For an older lifecycle-enabled journal without table
coordination metadata, explicitly set `"table": false` to retain its original
immediate-start behavior and omit ready/rematch controls. Do not edit old records
or migrate an in-progress hand implicitly. New coordinated tables require a fresh
journal. Bots can replace disconnected players during play but never bypass human
consent. Command receipts and journals grow across rematches, so production still
needs persisted table lifetime/retention quotas beyond the gateway's in-memory cap.

## Quick Chat And Completed History

Rebuild the UI and restart the private host together to enable the new protocol
messages. No new configuration, encryption key, or journal migration is required:
history is rebuilt from the existing journal's verified completed outcomes.

### Fixed-list chat

- Seated human owners can send **Good luck**, **Well played**, **Oops**, or
  **Thanks**. No text input, custom phrase, card ID, target seat, or other caller
  metadata is accepted. Spectators can read messages but cannot send them.
- Chat uses the existing authenticated/idempotent command envelope:

  ```json
  { "type": "COMMAND", "command": {
    "commandId": "00000000-0000-4000-8000-000000000001",
    "matchId": "private-table-1", "expectedVersion": 1,
    "action": { "type": "QUICK_CHAT", "phraseId": "GOOD_LUCK" }
  } }
  ```

  Other phrase IDs are `WELL_PLAYED`, `OOPS`, and `THANKS`. Chat does not require a
  bidding/card turn, but the owner must be connected and use the current version.
  A returning human can chat while a disconnect bot finishes its decision.
- The actor enforces one accepted message per seat every two seconds, across
  socket replacements, rematches, and restart recovery. Rejected retries remain
  cached: after a cooldown, a new click must use a new command ID. Chat never
  increments the game version, resets deadlines, spends banks, or applies a move.
- Each accepted message is appended before broadcasting `CHAT_MESSAGE` in the
  normal recipient sequence. Public message IDs are server counters, not copies
  of caller-provided UUIDs. The live `chat` snapshot projection includes permission,
  remaining cooldown, and only the most recent 20 messages. Replay rebuilds these
  values without re-broadcasting old messages or changing cached engine receipts.
  A successful `RESULT` includes its server `chatMessageId`. Validated, contiguous
  chat-only traffic updates just the bounded transcript; acknowledgements confirm
  the server ID, with snapshot fallback if needed. Chat therefore does not force
  whole-game refreshes that could exhaust the gateway's ordinary message quota.
- **Mute messages from seats** filters the local transcript only. Mutes remain
  in the current rendered session, not browser storage or server preferences, and
  clear when the table UI is disconnected/recreated. Reporting/moderation, persistent
  mute preferences, emotes, and any between-hand free text remain unimplemented.
  Fixed phrases reduce available communication; they do not prove collusion-free play.

### Completed-result browser

- **Latest results** and **Older results** show completed hand summaries and match
  outcomes for this authenticated table, including prior rematches. A hand result
  includes the original bid/target, declarer, stake/pair adjustment, points, score
  change, trump/indicator, and all eight completed tricks. Abandoned matches show
  no winner and count only their previously completed hands.
- Only committed `HAND_SCORED` and `MATCH_ENDED` public outcomes enter the index.
  No current hand, undealt deck, live concealed card, or internal trump-power flag
  is returned. Authenticated spectators may read the same completed public results.
  Queries do not write a journal record, advance event cursors, or alter the game.
- Requests use the authenticated table context, never a client-selected match/seat:

  ```json
  { "type": "GET_HISTORY", "requestId": "00000000-0000-4000-8000-000000000002", "limit": 10 }
  ```

  The `HISTORY` response echoes `requestId` with `matchId` and a `page` containing
  `entries`, `nextBefore`, `earliestAvailable`, `total`, and `truncated`. `limit`
  defaults to 10 and must be 1–20. To fetch older results, send the returned
  `nextBefore` as `before`; entry-index cursors are exclusive and stay stable as
  newer results arrive. Late replies are correlated to their pending request.
- The in-memory browsing index retains the most recent **100 combined hand/match
  entries**, rebuilt on verified restart. Pages explicitly flag truncation; an
  expired cursor returns an empty page with the retained-window metadata. This is
  not a deletion/retention policy for the encrypted journal, which still contains
  older full records and requires separate operational retention and backups.
- This is table-scoped history for the existing pre-provisioned participants, not
  an account-wide recent-match service, database index, audit log browser, or public
  sharing endpoint. A history-request timeout leaves gameplay connected and lets
  the user try again. Quick match, parties, and invite/seat assignment are still
  later lobby work.

## Engine Boundary

`createEngine` takes a validated ruleset, server-chosen dealer, and table settings.
`applyEngineInput` validates unknown command data; `applyEngineCommand` accepts
trusted typed inputs. Both return immutable transitions or unchanged-state
rejections. The actor must derive seats from authentication, never client input.
`START_DEAL`, `TIMEOUT`, `VOID_DEAL`, `ABANDON`, and `SET_BOT` are internal operations
only; clients cannot change seat controllers.

Commands include recorded server time, expected version, and (for timeouts) the
decision version. Accepted commands increment version once. Fixed pair/redeal
deadlines are enforced; ordinary turn deadlines/time banks are owned by the actor.
`START_DEAL` requires a fresh injected deck after each score or void.

Send only `engineView` and `recipientEvents` outputs, never engine state. Keep
recipient sequence counters across transitions and pass `showCapturedPoints` to
event projection for competitive tables. Views respect trick-history settings;
trump-power flags never leave history projections. Summaries reveal full hand data.
The actor adds event IDs/timestamps and keeps sequence counters and command receipts
for its lifetime. A journal adapter must store records durably before resolving
`append`; records contain full hidden state and are server-only. `openFileJournal`
provides a local encrypted adapter; `restoreMatchActor` validates and replays records
before exposing recovered state. Storage failure stops the actor before publishing
uncommitted state. Transport publication failure is reported without undoing a
committed command. Inject authenticated seats into `dispatch`; never expose its
seat argument directly to clients. Client commands cannot invoke system actions.

Account authentication, incident recovery, spectator delay,
forced-card automation, and preselection remain unimplemented. Command receipts
currently grow for the match lifetime; bound match duration/rate at the gateway.

## WebSocket Host Integration

`createWebSocketGateway` in `src/adapters/websocket-gateway.ts` attaches the
`/29-card/ws` upgrade route to a dedicated Node HTTP server. The host must supply
an explicit browser-origin allowlist, terminate TLS, and inject
`authenticate(token, request)`. Authentication returns `{ matchId, viewer }` from
verified server-side membership, or `null` for invalid credentials. Never derive
the seat from unverified token claims or client commands. Tokens go in `HELLO`,
not query strings. Token issuance, expiry/revocation enforcement, and pre-upgrade
IP/connection-attempt limits belong to the production host. This route is not
attached to the existing Carrom static server.

Create the gateway, then create an actor with its publish port wired to
`gateway.publish(matchId, viewer, events)`. Register the actor using
`gateway.registerMatch(matchId, actor)` before starting it. For restart recovery,
restore the actor first and register it afterward; recovery deliberately publishes
no historical events. Remove completed tables using `unregisterMatch`, and stop
actors, close the gateway, and close journals during host shutdown.

Protocol version 1 uses strict JSON messages:

- First send `{ "type": "HELLO", "protocolVersion": 1, "token": "..." }` and
  await `WELCOME`. Only one active socket per authenticated match/viewer is kept.
- Send `{ "type": "GET_VIEW" }` for `SNAPSHOT`, containing the filtered actor
  snapshot and its recipient `seq` cursor.
- Send `{ "type": "COMMAND", "command": { "commandId": "<uuid>",
  "matchId": "...", "expectedVersion": 1, "action": { "type": "BID",
  "amount": 16 } } }`. `RESULT` returns the actor's accepted/rejected receipt.
  Spectators cannot submit commands. System actions and seat fields are rejected.
- Live `EVENTS` contain only the authenticated viewer's envelopes. After reconnect,
  send `{ "type": "RESUME", "matchId": "...", "seq": 12 }`. `REPLAY` returns
  the available suffix and latest cursor; a missing, future, overflowed, or
  pre-recovery cursor receives `SNAPSHOT` instead. Clients must tolerate duplicate
  delivery and apply events in sequence order; on a gap request `GET_VIEW`.
- `ERROR` contains a public error code, never provider exceptions or hidden state.
- Send `{ "type": "LEAVE_TABLE" }` to leave explicitly. The authenticated seat
  immediately becomes bot-controlled; `LEFT_TABLE` acknowledges the leave and the
  socket closes. Spectators cannot invoke this operation. Rejoining with a valid
  credential follows normal turn-boundary reclaim rather than cancelling takeover.

Buffers are in-memory, recipient-scoped, capped at 512 events by default, and reset
on each `HAND_STARTED`. Restart recovery restores actor sequence counters but not
transport buffers. Limits also cap payloads (16 KiB), pending messages, connections,
outgoing buffered bytes, per-connection/per-viewer message rates, and command
attempts per registered match. The default 10,000-command cap includes retries and
rejections; after reaching it the host must retire the table, not re-register it to
reset the cap. Production hosts still need a persisted lifetime/retention policy.
WebSocket ping/pong runs every 10 seconds; two unanswered probes disconnect the
socket. Connection changes feed the actor's persisted lifecycle (see below), and
turn timers continue normally. Delayed spectators, editable preferences, and
foreground/background presence commands remain unimplemented. Compression is disabled pending
confidentiality/performance review. Socket integration tests use the real actor
and loopback WebSocket clients; they are not browser UI or full conformance tests.

## Run A Private Table

`corepack yarn start:29` builds and runs `src/server.ts`. It binds only to
`127.0.0.1` on port 8766 by default. This is a single private table with either
pre-provisioned members or invite-only first-claim seating,
not a public lobby, account system, or finished multiplayer deployment. Keep
Carrom on its existing `corepack yarn start` server.

For the pre-provisioned mode, follow these steps. For invite mode, use the earlier
`invitation` configuration instead of the `members` field below.

1. Provision a private directory outside the repository, mode `0700`, for the
   journal and configuration. The server refuses repository journal directories,
   public-readable directories/files, symlink configuration files, and malformed
   configuration. Do not commit configuration or credentials.
2. Run `corepack yarn token:29` separately for each of the four physical seats.
   It generates a cryptographically random 256-bit bearer token and its SHA-256
   `tokenHash`. Deliver the raw token securely to only that seat's player; put only
   the hash in the server configuration. An optional fifth credential can have
   `viewer: "spectator"`. There must be four unique seats and no reused hashes.
3. Provision a separate random 32-byte encryption key through your secret manager.
   Set `CARD29_JOURNAL_KEY` to its 64-character hex encoding. Keep this key stable
   across restarts; losing it loses recovery access. Never reuse player tokens as
   the encryption key.
4. Create a mode-`0600` configuration file in the private directory. Set
   `CARD29_CONFIG` to that file's absolute path, then run `corepack yarn start:29`.
   The validated configuration has the following shape (replace all placeholders):

```json
{
  "matchId": "private-table-1",
  "preset": "29-standard",
  "port": 8766,
  "lifecycle": { "disconnectGraceMs": 60000, "abandonAfterMs": 600000 },
  "table": { "readyMs": 15000, "rematchMs": 20000 },
  "allowedOrigins": ["https://cards.example.com"],
  "journalPath": "/private/server-owned-directory/table.journal",
  "members": [
    { "viewer": 0, "tokenHash": "<seat-0-sha256-hex>", "expiresAt": 1900000000000 },
    { "viewer": 1, "tokenHash": "<seat-1-sha256-hex>", "expiresAt": 1900000000000 },
    { "viewer": 2, "tokenHash": "<seat-2-sha256-hex>", "expiresAt": 1900000000000 },
    { "viewer": 3, "tokenHash": "<seat-3-sha256-hex>", "expiresAt": 1900000000000 }
  ]
}
```

`expiresAt` is Unix epoch milliseconds; choose a short session lifetime. The host
verifies hash membership at `HELLO` and closes connected sessions when they expire.
Changing configuration takes effect only after a restart. To revoke immediately,
stop the host, replace the compromised credential hash, then restart. There is no
token-minting HTTP endpoint and no client-supplied seat-selection API.

The host serves only `GET /healthz` and `/29-card/ws`. Health returns 503 after a
reported runtime failure; no error details, configuration, or journal contents are
served. On startup an existing journal is verified/replayed, and the preset must
match its original configuration. Clients initially request `GET_VIEW`; startup
and recovery do not populate the in-memory resume buffer. SIGINT/SIGTERM stop
accepting traffic, disconnect clients, drain the actor, then close/sync the journal
and release its lock. An unclean crash still requires the stale-lock procedure below.

Before exposing the service, configure a TLS reverse proxy for `wss://`, an exact
browser-origin allowlist, proxy connection/attempt limits, private logs, and secret
delivery. Do not trust arbitrary forwarded-IP headers. This host deliberately has
no account database, public lobby/seat assignment, token refresh, persisted quotas,
or automatic crash-lock removal. The playable private-table UI connects to this
host; private ready checks and rematches are durable actor operations, not a
general-purpose lobby service.

## Disconnects, Bots, And Returning Players

- The private host enables lifecycle handling by default: `disconnectGraceMs`
  is 60 seconds and `abandonAfterMs` is 10 minutes. Both are positive integer
  milliseconds, at most 2,147,483,647, recorded in the journal. A new host must use
  a fresh match/journal for legacy tables without lifecycle metadata; changing
  lifecycle settings on an existing table is rejected rather than silently migrated.
- Seats begin offline when the server starts. On coordinated tables no hand or
  disconnect bot starts until readiness succeeds. During play, timers run while
  offline; reconnecting within grace preserves human control without replenishing
  turn time or time banks. Legacy `table: false` hosts still start immediately.
- After grace, the actor journals `SET_BOT` and `BOT_TOOK_OVER` before publishing.
  The baseline bot sees only its filtered engine view and legal actions. It uses
  the same pass/minimum-opening, trump-selection, and weakest-legal-card policies
  as timeouts, revealing only when no legal card can be played. It also declares
  eligible pairs regardless of the human's manual-pair preference.
- Each bot decision draws a crypto-random 600–1500 ms delay independent of its
  cards/action. The selected delay/deadline is journaled for recovery, not redrawn
  during replay. Ordinary turn deadlines take priority over late bot decisions.
- A reconnecting player uses `GET_VIEW` to see their hand and the public `seats`
  array (`connected`, `controller`, `reclaimPending`). If a bot already controls
  the seat, human commands return cached `SEAT_NOT_CONTROLLED` receipts until the
  next decision boundary. `PLAYER_RECLAIMED` then restores the human controller.
  Revelation alone is not a boundary: the bot completes its reveal/play turn.
  Use a fresh command ID after reclaim, since rejected retries remain idempotent.
- Socket closure, credential expiry, missing heartbeats, and explicit removal from
  the gateway mark human seats offline. Replacing a still-live authenticated socket
  does not create a false disconnect. Spectators never keep a table alive.
- Once all originally human seats have been offline continuously for the abandon
  interval, the actor commits `ABANDONED` with no winner, even if bots are playing.
  A human return before expiry cancels that countdown; a late return cannot revive
  that match. On coordinated tables it can still join the new rematch vote.
  Bot-only actor tables do not trigger all-human abandonment.
- Restart replay verifies controller changes, bot decisions, receipts, sequences,
  and deadlines. Already-offline seats retain their disconnect times; seats that
  were recorded online are marked disconnected at restart time because old sockets
  no longer exist. This does not infer a crash timestamp or count unknown downtime
  as a proven disconnect interval. In-memory transport buffers still need snapshot
  fallback after restart. Durable restart-disconnect events can advance the cursor.

This lifecycle milestone is covered by deterministic actor tests (including complete
bot matches for all three presets) and loopback WebSocket/host tests. Browser tests
also cover the playable client separately; they are not proof of impaired-network,
multi-host, or full T48/T49 release conformance.

## Local Journal Operations

- Supply a dedicated server-owned path in an existing private directory and a
  32-byte key from a secret manager. Keys are not written to the journal. Never
  place journals under public assets or commit them. Wire `journal.append` to the
  actor's append port; stop the actor before awaiting `journal.close()`.
- Reopen with the same match ID/key and pass `journal.records` to
  `restoreMatchActor(records, ports)`. It verifies engine version, configuration,
  transitions, stored views/events, and receipts by replay. Recovery does not
  rebroadcast historical events. Overdue deadlines are scheduled immediately.
- AES-256-GCM authenticates each record and binds it to the match, index, and prior
  record hash. Writes are acknowledged after file sync. Only an incomplete final
  line is discarded on opening; corrupt complete records fail closed.
- This adapter is single-host, not a distributed lease or database. An exclusive
  `.lock` prevents another local writer. After a crash, an operator must confirm
  the old process is dead before removing the stale lock. Never remove a live lock.
- Full state is retained in every record for verification. Hand-start snapshot
  indexing, bounded-memory/streaming recovery, retention, backups, KMS rotation,
  and automatic supervisor recovery remain deployment work. Whole-suffix rollback
  detection requires an external trusted head/checkpoint; chaining alone cannot
  detect deletion of complete records from the end.
