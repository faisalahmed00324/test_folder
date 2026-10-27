# Twenty-Nine And Twenty-Eight

Mobile-first online card game with a pure TypeScript rules engine. The baseline
is [the production specification](doc/Twenty-Nine%20%26%20Twenty-Eight%20Production%20Rules%20and%20Engine%20Specification.md);
see [implementation notes](doc/implementation-notes.md) for interpretations.

## Play Locally

From the repository root, using the pinned Corepack Yarn:

```sh
corepack yarn build:ui
corepack yarn start
```

In another terminal:

```sh
corepack yarn start:29
```

Open `http://127.0.0.1:8765/29_Card/index.html`. The backend listens on
`127.0.0.1:8766`; its WebSocket address is
`ws://127.0.0.1:8766/29-card/ws`. Create a table, share its six-digit PIN, and
have three friends join. The creator automatically gets seat 0; joiners receive
seats 1, 2, and 3 in arrival order. Use separate windows/profiles for local players.
There is no login, manual seat selection, spectator admission, encryption-key
setup, or invitation generation in this workflow.

All four players connect and tap **Ready** within 15 seconds before cards are
dealt. Play uses server-provided legal actions for bidding, trump selection,
doubling, pair declarations, and cards. After a match, unanimous rematch consent
within 20 seconds starts fresh scores, banks, and a random dealer.

The root URL still opens Carrom. This bundled React page cannot run directly
from a file URL. Keep the static server and card backend running separately.

## Temporary Tables And Privacy

- The six-digit PIN is only a shared table locator. Create returns a random
  256-bit seat credential. Join uses a client-generated 256-bit attempt identifier
  as its seat credential, so retrying the same request recovers the same reservation;
  only its SHA-256 digest remains in the membership map. The UI retains the attempt
  identifier in memory until a successful response and uses the credential invisibly
  in `HELLO`, never as a URL query parameter. Do not log API requests, responses, or
  WebSocket credentials.
- Each table has exactly four reservations, including its creator. A full table
  rejects additional joiners; disconnect/leave does not transfer or release a
  reservation. A still-running client can reconnect with its in-memory credential.
  The PIN cannot recover somebody else's seat. Reload or closing the client loses
  the credential; create a new table rather than expecting account recovery.
- Tables and credentials live only in server memory. No configuration file,
  database, journal, local save, account, or historical-result service is used.
  Restarting the host invalidates every PIN and seat credential.
- A table expires after six hours, even while connected, or after ten minutes
  without connected players. Closed tables are retired too. Cleanup runs every
  30 seconds and on create/join, revokes credentials, unregisters the gateway,
  closes sockets, and stops the actor and timers.
- Disconnect grace is 60 seconds; during play filtered-view baseline bots can
  take over, and reconnecting humans reclaim at safe turn boundaries. Explicit
  leave yields immediately. Bots never bypass the initial human ready check.
- Fixed-list quick chat has a two-second per-seat cooldown and a bounded live
  transcript. Live scores and current completed-hand summaries are gameplay,
  not persistent history. `GET_HISTORY` returns an empty page on this host.
- Knowing the PIN allows joining any unreserved seat, and one person can reserve
  multiple seats. Share it only with intended players. These are casual temporary
  tables, not ranked identity, matchmaking, or a public hardened service.

## HTTP API

HTTP uses the **same host and port as the configured WebSocket endpoint**:
replace `ws:` with `http:` or `wss:` with `https:`. Do not send API requests to
the static server's port. Shared Zod boundaries are in
`src/protocol/private-tables.ts`; requests reject unknown properties and coercion.

| Method/path | JSON request | Successful JSON response |
| --- | --- | --- |
| `POST /29-card/tables` | `{}` | `{ "pin": "012345", "token": "<seat credential>" }` |
| `POST /29-card/tables/join` | `{ "pin": "012345", "attemptId": "<43-char base64url secret>" }` | `{ "pin": "012345", "token": "<same attemptId>" }` |

Success is HTTP 200. PINs are strings matching `/^\d{6}$/`, including leading
zeros. Requests require `Content-Type: application/json` and at most 1 KiB.
Errors are JSON `{ "error": "<public message>" }`:

- 400: invalid request, content type, JSON, PIN, or oversized body.
- 403: disallowed browser origin.
- 404: missing/expired table or unknown path.
- 409: all four seats reserved or a join attempt was reused for another PIN.
- 429: IP request limit reached.
- 503: table capacity unavailable, shutdown, or service failure.

Responses use `Cache-Control: no-store`. CORS permits exactly
`http://127.0.0.1:8765` and `http://localhost:8765` by default; valid POST
preflights permit only the `Content-Type` request header. Disallowed origins
are rejected, not merely hidden by CORS. No-origin HTTP clients are allowed
for integration; WebSockets require an allowlisted origin.

Default bounds are 100 tables, 30 API requests per IP per minute (including
invalid guesses and preflights), and 4096 tracked IP windows. Unknown IPs are
rate-limited when that map is full; expired windows are removed. The backend
does not trust forwarded-IP headers. PIN and token collisions retry with
cryptographic randomness and fail safely after a bounded number of attempts.
HTTP connections, payloads, timeouts, and requests per socket are bounded.

## Host And Deployment

`src/server.ts` has no token/invite subcommands and accepts no command-line
arguments. Optional environment settings:

```sh
CARD29_PORT=8766 \
CARD29_ALLOWED_ORIGINS=http://127.0.0.1:8765,http://localhost:8765 \
corepack yarn start:29
```

Origins must be exact HTTP(S) origins without paths; neither wildcards nor
arbitrary origins are accepted. These settings contain no secrets. Programmatic
hosts may additionally set the bounded capacity, expiry, idle, and rate-limit
settings validated by `pinServerConfigSchema`.

For remote play, terminate TLS at a reverse proxy and route **both**
`/29-card/tables` (including `/join` and preflight requests) and `/29-card/ws`
to this loopback backend. Set the UI's HTTPS origin in the allowlist. Use
`wss://<host>/29-card/ws`; do not expose remote plaintext credentials. Proxy
deployments need their own trusted client-IP, connection-attempt, abuse, and
resource limits: all proxied API clients otherwise share the proxy's IP window.
SIGINT/SIGTERM stop admission, terminate sockets, stop actors, and close the host.

The private E2E driver mounts `createPinTableService` on its shared gateway at
`http://127.0.0.1:8879`, with UI origin `http://127.0.0.1:8878`. Its old
scenario tables remain solely for legacy tests.

## Rules And Runtime

Implemented engine features include the 32-card deck, J > 9 > A > T > K > Q > 8 > 7
ranking, opposite partnerships, both play directions, and validated immutable
`29-standard`, `29-simplified`, and `28-standard` presets. Pure modules cover
two-packet dealing, priority-duel/open auctions, Twenty-Eight second rounds,
concealed/seventh-card trump, double/redouble, follow-suit and trump revelation,
eight tricks, pair/redeal windows, scoring, dealer rotation, and match endings.
The temporary host currently chooses `29-standard`; public rules are unchanged.

The match actor serializes commands, derives seats only from authenticated
membership, enforces expected versions and ready-check IDs, caches command-ID
receipts, manages clocks/banks/lifecycle/rematches, and publishes filtered views.
Node runtime ports supply crypto shuffling, random dealer selection, and
cancellable timers. The temporary host supplies a no-op append port: no game
or membership journal is opened.

`createEngine` and `applyEngineCommand` remain framework-independent. Only
`engineView` and `recipientEvents` outputs may reach clients: internal engine
states, decks, journal records, and concealed trump metadata contain secrets.
`START_DEAL`, `TIMEOUT`, `VOID_DEAL`, `ABANDON`, and `SET_BOT` are system-only.

### WebSocket Protocol

The gateway supports protocol version 1:

- `HELLO` with `{ protocolVersion: 1, token }` authenticates one seat and returns
  `WELCOME` with its server-assigned `matchId` and `viewer`.
- `GET_VIEW` returns a private `SNAPSHOT` and recipient sequence.
- `COMMAND` carries a UUID `commandId`, server `matchId`, `expectedVersion`, and
  legal action. `READY` and `REMATCH_VOTE` also need `expectedCheckId`.
- `EVENTS` are recipient-filtered. `RESUME` with `matchId` and `seq` gets bounded
  `REPLAY` or a fresh snapshot. Credentials cannot address another table or seat.
- `LEAVE_TABLE` receives `LEFT_TABLE` and closes the socket.
- `GET_HISTORY` remains wire-compatible but returns no entries on the PIN host.
- `ERROR` contains a public protocol code, never internal exceptions.

Gateway defaults bound payloads to 16 KiB, pending messages, 100 connections,
outgoing buffered bytes, message rates, 512 current-hand resume events, and
10,000 command attempts per table. Heartbeats detect lost peers. Receipts remain
in memory only for the bounded table lifetime.

### Legacy Internal Modules

`adapters/private-server.ts`, encrypted `file-journal.ts`, invitation membership,
verified restart replay, and their tests remain intact for internal use. They
are **not** invoked by `start:29`, and their persistent history, configuration,
and saved invite/token flows are not the current browser startup workflow.
`CARD29_CONFIG` and `CARD29_JOURNAL_KEY` are not required or read by the default
entry point. There are no `token:29` or `invite:29` package scripts.

## Development And Verification

```sh
corepack yarn typecheck
corepack yarn test:unit --coverage
corepack yarn check
```

Jest tests live under `tests/unit/**/*.test.cjs` and import production functions.
Application tests inject clocks, credentials, IDs, and runtime boundaries;
HTTP/WebSocket integration tests use the real actor on loopback. Playwright
browser tests live under `tests/e2e`. Existing rules and legacy private-host
tests remain separate from PIN-host tests.

`build:engine` compiles to private `.build/29-card/`; `build:ui` bundles React
with esbuild into `.build/29-ui/`. Production `build` copies only allowlisted
public assets into `dist/`, never backend modules, keys, fixtures, or drivers.
Carrom remains unchanged. Account services, ranked admission, parties,
spectator delay, public matchmaking, and production conformance remain future work.
