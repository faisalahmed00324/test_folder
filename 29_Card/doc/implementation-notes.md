# Implementation Notes

Working interpretations, not confirmation of regional rules or a replacement for
the production specification. Resolve open items before implementing their behavior.

## Foundation Decisions

- Mobile-first React web; private tables precede casual quick match.
- Raw configuration excludes `totalPoints` and `maxBid`; validation derives both.
  A future persistence boundary must verify stored derived values, not trust them.
- Parse configuration/decks at entry; freeze configuration deeply. Trusted inner
  calculations do not repeatedly validate their arguments.
- The immutable audit deck is not an extra card location. Only
  `deck.slice(dealtCount)` counts as undealt in card-location invariants.
- Packets are separate transitions. Traffic-level T05 waits for filtered transport
  integration; internal dealing tests do not prove client confidentiality.
- Reject external indicators with `anyTrump`: a declarer may choose a suit they
  lack and then have no legal card after revealing. Use `anyCard` instead.
- Initially accept second rounds only with ascending bidding, face-down cards,
  seventh-card off, and doubling off. Other combinations require defined mechanics.
  All three presets validate, but validation is not a claim of full conformance.

## Auction Decisions

- Accept an equal `BID` from the responding duel holder as `HOLD`, normalizing
  history and events to `HOLD`/`BID_HELD`, as acceptance test T07 requires.
- Ascending auctions end when all players except the latest bidder have passed,
  not merely when traversal returns to that bidder. The pseudocode in sections
  7.3 and 7.4 would prematurely stop a round with multiple active bidders.
  Skip the latest bidder and keep prompting the other active seats.
- A second round starts with all four seats active and a fresh history, including
  the previous declarer. Before a new bid, all four can pass. Existing declarer and
  contract remain standing even if that declarer passes in this round.
- Apply the common partner-overbid rule in both rounds. Holding is not an overbid.
- Drain unavailable bids as automatic passes in the same transition, but retain a
  holder's opportunity to hold at maximum. Each transition returns ordered events;
  the outer match runtime will add versions, timestamps, and recipient sequences.
- The result identifies initial selection, unchanged trump, or reselection. This
  module never changes card locations. The trump module implements concealed-card
  return/reselection; connecting both modules awaits the hand coordinator.
- Timeout decisions use the same transition path and mark their history/events
  `auto: true`. Timer scheduling, stale-decision protection, and time banks remain
  responsibilities of the future match runtime.

## Trump And Doubling Decisions

- Initial selection requires packet one. Face-down selection removes an accessible
  card immediately. Packet two preserves that slot; external trump moves no cards.
- Seventh-card mode reserves a concealed slot before packet two and moves the
  declarer's third card of that packet directly into it. Filter that identity out
  of every `CARDS_DEALT` payload, including the declarer's. Trump knowledge is empty
  for all viewers in that mode. Full client snapshots still await the view layer.
- Selection emits public `TRUMP_SELECTED` and declarer-only `TRUMP_DETAILS` domain
  records. The future transport adds recipient sequencing; state is never a response.
- A different second-round winner returns the old indicator privately to its
  owner, then selects from eight accessible cards. The same declarer bypasses
  reselection. The full hand coordinator will invoke these from auction results.
- Selection timeout uses suit points, count, then highest rank. Remaining ties
  use fixed C/D/H/S order, independent of display sorting. Conceal the weakest card
  of that suit. Apply the same policy to eight-card reselection, unspecified in
  section 19.1. This is an implementation default to confirm before release.
- Doubling prompts first defender, their partner, declarer, then declaring partner
  as applicable. First double/redouble skips the other teammate; timeouts pass.
  Disabled presets produce a finished sequence. The future coordinator schedules
  the sequence before/after packet two using `doubling.timing`; the standalone
  decision sequence deliberately does not enforce deal timing.
- The play module performs revelation and returns the indicator atomically.

## Play Decisions

- `createPlayState` starts from a prepared full trump deal. The hand coordinator
  must first finish applicable second-round/doubling decisions; this module does
  not infer that sequencing from the standalone trump state.
- Reveal metadata is the public/hidden marker: `reveal === null` means hidden.
  A pending reveal-play obligation records its actor and returned indicator until
  that actor plays. It survives plain-data serialization without consulting clocks.
- Follow suit takes precedence over reveal obligations, including when a returned
  indicator is the declarer's only led-suit card. Leading after forced revelation
  permits any trump, including under Twenty-Eight's indicator-card preset.
- Resolution fixes each play's trump-power flag at completion. Off-suit trumps
  before the reveal position remain powerless under standard rules. When trump
  is led, all led-suit cards compete by rank regardless of their power flags.
- Completed cards move exclusively into history. `TRICK_COMPLETE` is an internal
  coordination boundary with no actor, allowing upcoming automatic pairs/windows
  to run before `startNextTrick`. Trick eight ends at `COMPLETE`, not match scoring.
- Starting trick eight automatically reveals a remaining concealed card before
  the lead without imposing a revealer obligation. External indicators can stay
  hidden until the future summary layer discloses them.
- Play timeout selects the weakest legal card, breaking rank ties by C/D/H/S.
  It takes a reveal action only when no legal card exists. Reveal and the following
  play are separate deterministic commands; the runtime will schedule follow-up
  defaults without giving an expired decision a fresh timer/time bank.

## Pair, Scoring, And Match Decisions

- Pair handling consumes a completed play boundary and returns a closed result or
  a fixed-deadline manual window. Opening depends only on winning-team preferences,
  never eligibility/cards. Bots declare automatically regardless of preference.
  A public declaration closes the window; ineligible requests never shorten it.
- There is no manual pass/decline that changes the deadline. Explicit recorded
  times govern declarations and expiry; an action at the deadline is expired.
- Pair bounds clamp adjustments, not the original contract. With narrower custom
  bounds, the untouched original contract may be outside those bounds; this resolves
  the conflict between configuration validation and invariant 7. Presets are unaffected.
- Completed play retains the original indicator identity after revelation so the
  summary can disclose it without reconstructing card ownership. External trump
  produces a null indicator. Summaries expose full trick history only at hand end.
- Scoring checks complete card/point conservation and captured totals against
  history. Bands use the original integer bid; effective target decides success.
  Only declaring-team game points change; stake multiplication never alters cards.
- Match progress consumes a completed play result once for its current deal number.
  Duplicate scoring is rejected after progression, including if a new deal starts.
  This is not transport idempotency, which still requires command IDs in the actor.
- Deal number includes scored hands and voids; hand number advances only after a
  nonterminal scored hand. Terminal results retain the final hand/deal/dealer.
- All-pass honors the explicit `redealSameDealer` policy even if general fault/
  pointless-four redeals rotate. This resolves conflicting general redeal wording.
- Every pointless-four deal opens the same fixed window. After a void the engine
  discards its packet and awaits another injected deck. Fresh CSPRNG shuffling and
  incident reporting remain adapter responsibilities, not domain effects.
- These are standalone rule transitions. The next coordinator will connect auctions,
  selection, second rounds, doubling, play, pairs, scoring, and fresh deals. Internal
  fault/void operations must never become unauthenticated client commands.

## Runtime Foundation

- `application/match-actor.ts` serializes authenticated-seat commands and scheduled
  work through one queue. Strict client schemas exclude system commands and actor
  fields. The future gateway authenticates seats and enforces rate limits.
- Command IDs are scoped to the authenticated seat within a match. Accepted and
  rejected responses are cached unchanged, including stale-state snapshots. Retries
  never reapply a move. Malformed envelopes are rejected before journaling.
- Every transition, time-bank extension, and valid-envelope rejection is appended
  before publication/response. Journal records include hidden engine state and
  must remain server-only. Append failures stop the actor; publication failures
  are reported without rolling back committed state.
- Timers use absolute deadlines. A time bank is consumed once, extending the
  original deadline rather than callback arrival time. Manual reveal/play retains
  the original turn deadline. Stale callbacks are ignored. Next deals obtain a
  fresh injected shuffle automatically.
- `adapters/node-runtime.ts` uses Node crypto for Fisher-Yates and first dealer;
  deterministic decks are injected only by tests. No new dependency is needed.
- The encrypted file journal now provides local durable appends, and
  `restoreMatchActor` verifies the versioned journal through replay. Full stored
  state is compared, never trusted as an executable snapshot. Recovery rebuilds
  receipts, sequence counters, time banks, and absolute deadlines without replaying
  historical deliveries to clients. Unsupported engine versions fail closed.
- There is no hand-start snapshot index or account-based identity provider yet.
  File locks require
  operator intervention after an unclean exit; storage is single-host only.
  Earlier milestone notes above describe historical boundaries; the coordinator
  and runtime foundation now implement their respective documented portions.

## WebSocket Gateway Milestone

- The injectable Node gateway accepts protocol-v1 `HELLO`, `GET_VIEW`, `RESUME`,
  and wrapped actor `COMMAND` messages. Authentication and membership are host
  ports; strict session validation rejects invalid provider results. Origin
  allowlisting is mandatory. No credentials are accepted in query strings.
- Seat authority never comes from the command. The host authenticates membership
  once per socket; commands and snapshots use only that session's match/viewer.
  A new authenticated connection replaces the old connection for that viewer.
- Only actor-projected event envelopes enter recipient buffers. Buffers reset at
  hand start, have a fixed maximum length, and are not restored from journals.
  Actor recipient counters survive recovery, enabling safe snapshot fallback when
  a requested suffix is unavailable. Snapshot/cursor reads are synchronous with
  respect to publication, so the cursor describes the committed projected state.
- Payload, queue, connection, send-buffer, per-connection/per-viewer rate, and
  per-registration command-attempt bounds protect resources. Persisted lifetime
  quotas and pre-upgrade abuse prevention remain production-host responsibilities.
  Heartbeats terminate missing peers; actor timers continue independently.
- Real loopback WebSocket tests exercise filtered deals, reconnect replay,
  snapshot fallback, identity enforcement, retries, stale receipts, malformed
  input, limits, and transport/provider failures. These establish part of T05
  traffic confidentiality, not seventh-card/full-hand network conformance or T48
  disconnect-bot takeover. React UI and browser network tests remain future work.

## Private Host Milestone

- `src/server.ts` runs one private table on loopback and wires the real actor,
  crypto randomness/timers, encrypted journal, verified recovery, and gateway.
  `CARD29_CONFIG` is a private JSON file; `CARD29_JOURNAL_KEY` comes from the host
  environment/secret manager. Journal directories must be private and outside the
  repository. No static-file or identity-minting HTTP route is exposed.
- Operator-provisioned random tokens authenticate physical seats through SHA-256
  hashes and constant-time digest comparison. Four unique seats and distinct
  hashes are required. Optional spectator access is another explicit credential.
  Provider expiry is carried internally to the gateway, enforced on commands and
  publication, and closes an active socket at expiry. Account linking, online
  revocation, token refresh, and proxy abuse controls remain deployment work.
- Recovery rejects changed presets rather than silently ignoring host settings.
  Shutdown closes traffic, drains queued/in-flight actor work, and only then
  closes the journal. The health endpoint exposes no hidden data and degrades
  after reported errors. This is not an automatic incident-recovery supervisor.
- Real-host tests exercise hashed credentials, expiry, private-file checks,
  restart recovery and idempotency, preset mismatch, cleanup, and health/static
  isolation. No disconnect lifecycle or browser-playable UI is claimed.

## Disconnect Lifecycle Milestone

- The existing actor queue owns connection changes, grace expiries, bot decisions,
  reclaim, and abandonment. Lifecycle settings, state, selected bot delays, and
  operation records are journaled before publication. The private host enables
  lifecycle by default; generic actors may omit it to preserve legacy archives.
  The host rejects legacy lifecycle-free journals or changed lifecycle settings;
  start a new match/journal instead of attempting an implicit migration.
- Startup starts a hand with all seats offline; readiness is a later UI/table
  milestone. Grace expiry changes the internal `isBot` preference without changing
  human pair automation preferences, hand contents, time banks, or turn deadline.
  Simultaneous grace expiries are drained in one queue turn. Grace callbacks are
  invalidated by committed state/lifecycle changes, including reconnects.
- Baseline bots consume `engineView` only. Timeout and bot adapters share pure
  decision-policy helpers instead of duplicating card selection. Production delays
  are drawn uniformly from the crypto 600–1500 ms range, independent of action.
  Replay verifies the recorded legal action, ownership, and decision deadline.
- Reconnect during bot control records a pending reclaim. The next completed
  decision restores human control; reveal alone does not complete a card turn.
  Human commands during bot control are persisted `SEAT_NOT_CONTROLLED` receipts,
  so retrying the same ID after reclaim still returns that rejection.
- `LEAVE_TABLE` is an authenticated connection-level command; it immediately
  hands the seat to a bot and closes the socket. Socket replacement suppresses
  false disconnects. Expiry, real closure, missed heartbeats, and unregistration
  mark seats offline. Spectators are excluded from all-human abandonment.
- Abandonment uses the last disconnect of the originally human seats and takes
  priority at expiry, even if bots remain active. A pre-expiry human return resets
  the all-offline interval; reconnecting after expiry cannot rescue the match.
- Recovery preserves known offline timestamps and bot deadlines. Previously online
  seats get a durable restart-disconnect at restart time, not an invented crash
  time. Transport resume counters therefore can advance during recovery. A clock
  moving backwards across presence-only records fails closed as for engine moves.
- Tests exercise complete bot matches per preset, grace/reclaim/reveal boundaries,
  simultaneous expiries, stale callbacks, all-human and bot-only abandonment,
  replay tampering, storage failure, host lifecycle mismatch, socket replacement,
  explicit leave, and heartbeat disconnect. These cover runtime aspects of T48/T49,
  not the full browser, impaired-network, or multi-host conformance release gates.

## First Playable React Client

- `src/client/` contains presentation, a framework-independent connection use case,
  and Zod network projection schemas. The reusable player-command schema moved to
  `src/protocol/` so the browser never imports the Node actor. No game rules moved
  into React. The client renders only server-provided legal actions/private views.
- esbuild explicitly bundles React/TypeScript/CSS into `.build/29-ui/`. The root
  build registers exactly HTML/JS/CSS in the existing static asset allowlist;
  private engine builds, test hosts, fixtures, and source maps are not published.
  Typechecking includes TSX and new browser tests. Jest deliberately transforms
  TSX; component tests use Testing Library/jsdom and backend tests stay in Node.
- The first client treats events as snapshot invalidations rather than maintaining
  duplicate game transition logic. View requests are coalesced, stale controls are
  locked, and gaps force a new authoritative view. Snapshot identity/version/cursor
  validation rejects seat changes and rollback, including across reconnects.
- Tokens remain in memory and only enter `HELLO`. Remote endpoints require WSS;
  plaintext is allowed only on loopback. Cards clear on disconnect/leave/errors.
  Reconnect reauthenticates and fetches a snapshot before retrying any uncertain
  command with its unchanged UUID/expectedVersion. Missing responses time out.
- Legal bids, holds/passes, trump selection, doubling, card play/revelation, manual
  pairs/redeals, bot reclaim status, public history, scores, and terminal results
  have labeled controls. Live hand summaries survive automatic next-deal snapshots;
  prior hand history is not fetched on a fresh join. Server visibility settings
  remain authoritative; spectators get no hand or move controls.
- Browser E2E runs the actual production bundle against a test-only real gateway
  and actor, exercising four private seats, bidding/selection/doubling/a full trick,
  portrait layout, spectator isolation, rejoin, invalid auth, and asset isolation.
  This is not full-match browser or impaired-network conformance. Readiness and
  rematches require durable server coordination and are explicitly the next slice,
  not mocked client-only features. Existing Carrom tests and direct-file assets
  remain unchanged.

## Durable Readiness And Rematches

- `application/table-session.ts` implements pure private-seat consent transitions:
  all connected humans get a fixed 15-second ready check; no-show slots reopen;
  ended/abandoned matches get a 20-second unanimous rematch offer. Decline/expiry
  closes the offer. Disconnect clears readiness or that human's rematch vote.
  Pre-provisioned credential ownership does not change when a slot reopens.
- The existing actor queue owns table operations. Initial waiting state, consent,
  deadlines, expiry, receipts, and fresh rematch dealer are appended before public
  `TABLE_UPDATED`/`READY_FAILED` traffic. No shuffle, decision timer, bank spend,
  disconnect takeover, or abandonment runs while waiting for ready consent.
- New hosts enable table coordination; generic actors may omit it for existing
  consumers. Legacy lifecycle-enabled journals can explicitly use `table: false`.
  Changing durable table settings or implicitly enabling readiness on old journals
  fails closed. Originally provisioned bots may count as ready, but disconnect bots
  never consent on behalf of human owners. The current private host reserves four
  human credentials and exposes no ADD_BOT/public seating endpoint.
- READY/REMATCH_VOTE are strict table-command variants carrying commandId,
  expectedVersion, and expectedCheckId. They are never engine card/bidding inputs.
  Spectator/seat authority stays at the gateway. Check identities and cached
  receipts prevent stale confirmations and retries from entering another window.
- Rematches reset the pure engine from its original settings with a recorded
  crypto-selected dealer and fresh shuffle, restoring scores/controllers/banks.
  The private wire matchId remains the table route/journal identity; matchNumber
  distinguishes matches. Engine versions, receipt IDs, and recipient sequences do
  not reset, so old game commands remain stale/cached rather than mutating a new
  match. Independent public match IDs/history indexing remain later lobby work.
- Recovery verifies all table output through replay, reuses the recorded rematch
  dealer, and completes a pending post-consent deal once. Restart disconnects clear
  ready confirmations or online owners' rematch votes without extending a rematch
  deadline. Late reconnects cannot save an abandoned match but may join its offer.
- React renders real legal ready/vote actions, indicators, and countdowns. A new
  match clears prior summaries. Browser E2E now drives four real clients through
  readiness, a complete short-threshold match, and a unanimous rematch. Deterministic
  unit/socket/host tests cover expiry, declines, disconnects, stale IDs, spent-bank
  reset, replay tampering, append failure, and crashes at both deal boundaries.
  This does not claim public lobby, quota/retention, multi-host, or impaired-network
  release conformance. Earlier milestones describing immediate starts are historical.

## Fixed Chat And Completed Table History

- Chat policy is a pure application function with a two-second per-seat cooldown
  and a bounded 20-message transcript. Strict QUICK_CHAT actions carry only one
  fixed phrase ID; no free text, card metadata, spoofed sender, or target is accepted.
  Connected human owners may chat independently of a game turn; spectators cannot.
  Bots do not generate chat or consent on behalf of owners.
- The actor serializes accepted/rejected chat receipts through the existing journal
  before public CHAT_MESSAGE delivery. Retries do not re-publish, and cooldown state
  survives socket replacement/rematch/replay without changing game timing/version.
  Public message IDs are server counters: reflecting the caller's UUID would expose
  an unnecessary arbitrary-data channel. Live getView adds chat without altering
  the shape of cached rejection snapshots in older journals.
- The completed-result index is a pure projection of committed public HAND_SCORED
  and MATCH_ENDED envelopes, not a reader of live hand state. Public summaries copy
  all completed cards/points but omit internal trump-power fields. Replay rebuilds
  the index from verified records; no redundant external storage or migration is
  needed. A completed hand stays queryable after automatic dealing and rematches.
- GET_HISTORY is a strict, authenticated, table-context read. It echoes a UUID
  request correlation ID, uses exclusive entry-index cursors, and limits pages to
  1–20 results (default 10). Reads do not change state, sequences, or journal contents.
  The browsing index holds the last 100 combined outcomes and explicitly reports
  truncation/earliest retained index; total counts include evicted entries. This
  bounded projection is not journal deletion, archival retention, or account-wide
  player history. All fixed-seat members and authenticated spectators can read
  outcomes already made public at hand end; there is no public-history URL.
- React adds fixed buttons, a cooldown indicator, local per-seat mute checkboxes,
  and paged hand/match details with all eight tricks. Browser storage is not used.
  Validated contiguous chat-only events update the transcript without reducing any
  game rules or fetching a whole-game view. Private acknowledgements identify the
  server message, allowing snapshot fallback when delivery is uncertain. Cooldowns
  use a monotonic UI clock and the last-send sample identity, so repeated sends
  restart their timer while unrelated messages do not. Idle chat does not poll.
  History RPCs are independent of pending game moves, and their timeout is recoverable
  without closing gameplay. Disconnection clears client history and pending queries.
- Tests cover clock boundaries, immutable/bounded projections, malformed and
  spoofed messages, cooldown bypass/retries, privacy before scoring, history cursor
  stability/truncation, rematch continuity, append failure, and encrypted restart
  recovery. Browser E2E reads old hand results after a fresh join and tests spectator
  chat/muting. This slice does not claim matchmaking, parties, invites, reporting,
  moderation, persistent mutes, multi-host history, or full social conformance gates.

## Invite-Only First-Claim Seating

- The private host now accepts exactly one identity mode: existing pre-provisioned
  members, or an invitation hash/expiry with a separate private membership ledger.
  The latter requires readiness. No public table creation, account provider, seat
  transfer/release, or spectator admission policy was invented for this slice.
- `application/invite-lobby.ts` serializes at most four accepted claims. Shared
  invitation possession authenticates a guest, which can inspect only ordered
  vacancy flags. A claim atomically binds a separate credential hash to an empty
  physical seat, before the first deal only. Duplicate nonce/seat/hash retries are
  accepted unchanged; different claims cannot overwrite an owner or alias a token.
- The browser generates 32 crypto-random bytes, displays the reconnect token masked,
  and requires explicit save confirmation before sending TAKE_SEAT. The server
  stores only its hash; acknowledgements never echo the secret. Pending claims keep
  the same token/nonce across reconnects. After acknowledgement the client uses
  that seat credential for normal HELLO, rather than retaining invitation authority.
- The gateway treats guest as a session role, never a game Viewer. Guest sockets
  are not replaced merely because another guest joins; they receive LOBBY updates
  only, not game events/history/chat/snapshots. A validated durable claim result is
  the sole guest-to-seat upgrade path. Disconnect during an append cannot create
  a false connected seat afterward. Seated clients cannot send TAKE_SEAT to change
  their game-command actor. Normal origin/rate/expiry/payload limits still apply.
- The encrypted file adapter gained a typed payload parameter for real reuse by
  game and membership records; its cryptographic format/locking/fsync behavior is
  unchanged. Membership records have a distinct authenticated namespace and a
  random authority ID bound into optional game metadata. Old journals remain
  unchanged. New mode recovery rejects missing/mismatched pairs or invite changes;
  deleting/replacing one is not an identity migration. Trusted checkpointing is
  still needed for whole-suffix rollback detection.
- `invite:29` generates a fresh secret fragment link and configuration hash. The UI
  consumes and removes the fragment before user interaction and never auto-joins.
  Fragments are not HTTP parameters, but the original link remains a secret in
  the sharing channel. Reconnect tokens are not inserted in URLs or browser storage;
  explicit clipboard copy is user-controlled. No raw token/nonce is published in
  lobby views, and membership journals contain no plaintext credential.
- Reservation lasts for the table lifetime/expiry, including no-shows and leave.
  Losing the saved token has no anonymous recovery bypass. Shared invite holders
  are trusted and may occupy multiple seats; the feature is not person-level
  authentication or collusion prevention. Account recovery, host reassignment,
  invite rotation, online table creation, parties, and quick match remain later.
- Tests cover concurrent claims, append-before-authority, conflicting/replayed
  nonces, unknown fields, expiry/backwards clocks, bad archives, failed writes,
  mode/path/authority mismatch, lost acknowledgements, socket closure during a
  claim, and encrypted restart recovery. Browser tests claim all four seats from
  scrubbed links, ready/deal, verify a fifth guest sees no game frames, and rejoin
  with the saved credential. No full public-lobby conformance is claimed.

## Remaining Clarifications

1. Lifecycle: section 5 describes pair windows inside play; section 20 defines a
   `PAIR_WINDOW` phase. Write an explicit transition table. The embedded lifecycle
   diagram is absent from the Markdown source.
2. Auction syntax and termination interpretations are recorded above.
3. Second round: retain seven accessible cards plus the known concealed card;
   "seeing all eight" does not return the concealed card to the accessible hand.
4. Timing: record explicit time inputs and decision IDs; never read a clock in the
   engine. Ignore stale scheduled work. Define timeout, window-close, automation,
   and abandonment commands accordingly.
5. Reveal obligations now persist across reconnect/recovery; preselection and
   foreground/background presence integration remain unimplemented.
6. Define runtime records, rejected-command idempotency, and preference updates.
   Selection/play timeout tie-breakers are documented above.
7. Complete protocol commands for preselection/cancellation and spectator snapshots.
8. Pair bounds and all-pass/dealer policy interpretations are recorded above;
   confirm custom variant behavior with launch-market players before enabling it.
9. Overview limits bots to casual play, while ranked disconnect replacement requires
   them. Resolve before ranked development.
10. Some regional alternatives in section 27 lack configuration keys. Do not claim
    support until they have explicit mechanics and tests.

## Verification

Foundation tests cover card values, seats, dealing, and configuration. They do not
yet establish trick winners, last-trick scoring, or complete T01-T04 conformance.
Maintain a T01-T64 matrix as features arrive; explicitly mark ranked/native deferrals.

Auction coverage exercises T07-T14 and T16, plus the auction outcome portion of
T15 and auction timeout defaults from T47. These are pure domain tests, not proof
of transport or full-hand conformance. Seeded legal-action simulations run 500
auctions per preset plus second rounds for Twenty-Eight; these are not the full
100,000-hand release workload.

Trump tests cover the T15 card return/reselection transitions, T17/T18 selection
and knowledge, and optional seventh-card event filtering. Doubling tests cover
T20 decision order/stakes and selection/doubling timeout defaults from T47.
Wire-level filtering and full phase orchestration remain unimplemented.

Play tests exercise T19 and T22-T33 domain behavior, T34 hidden-external resolution,
and card-point/bonus portions of T41. Summary scoring is now covered separately.
Seeded integration tests run 60 full eight-trick plays for each preset,
plus seventh-card and last-trick-bonus variants (300 hands total), asserting card
conservation, point totals, turn order, completed-trick stability, legal-action
availability, and termination. These are not full matches or the release workload.

Pair/scoring/progression tests cover T21 and T35-T44 domain behavior, preference-
driven T55/T56 pair behavior, stale/duplicate scoring rejection, all summary fields,
and pointless-four deadlines. Production play functions also drive full matches
for each preset and a last-trick-bonus variant, with automatic pair handling and
dealer rotation. These scripted rule integrations intentionally bypass auctions
and doubling; they do not claim complete coordinator or network conformance.

Run domain coverage and root `yarn check` per milestone. Add transport integration
and browser tests with those layers. Million-shuffle, 100,000-hand-per-preset,
recorded replay, and impaired-network workloads become dedicated release jobs once
the full engine/runtime exists.
