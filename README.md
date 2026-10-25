# Games

Each game lives in its own folder. Carrom is available at `/Carrom/carrom.html`;
the root URL currently opens Carrom as the default game.

Twenty-Nine and Twenty-Eight are under development in [`29_Card/`](29_Card/README.md).
The pure engine covers complete hands and matches. A server-runtime foundation adds
secure shuffling, serialized commands, idempotency, and turn timers/time banks.
An encrypted local journal and verified replay support restart recovery.
An injectable WebSocket gateway adds authenticated routing, private traffic,
bounded reconnect replay, and snapshot fallback. `corepack yarn start:29` runs a
loopback-only private-table host with hashed expiring seat credentials and encrypted
restart recovery. See the game README for private configuration and token setup.
Persisted seat lifecycle adds disconnect grace, filtered-view bots, turn-boundary
reclaim, and all-human abandonment. A playable React private-table preview is at
`/29_Card/index.html`: run `corepack yarn build:ui`, then the static server, and
connect using a host-provided WebSocket address and seat token. New tables use
durable 15-second ready checks and 20-second unanimous rematch votes, including a
fresh random dealer and reset scores/banks. Fixed-phrase quick chat includes a
per-seat cooldown and local muting; the completed-result browser recovers recent
table hands/matches from the encrypted journal. `corepack yarn invite:29` generates
private invitation links for optional durable first-claim seating; guests see no
game data before claiming, and owners keep separate reconnect credentials. Account
integration, public seat management, matchmaking/parties, and account-wide player
history remain unimplemented. See the game README before enabling invite mode.
`yarn build:engine` compiles it to the private `.build/29-card/` directory;
`yarn build` compiles it and bundles the React UI before copying allowlisted assets.

To add another game, place its browser assets in a folder and add its published
asset paths to the `ASSETS` allowlist in `server.js`. The production build copies
only those listed files, preserving their folder paths. Keep game-specific tests
and documentation alongside the game.

Requires Node.js 20 or later and Corepack. If Corepack is not installed, follow
<https://yarnpkg.com/corepack> first. Run these commands from the repository root:

```sh
corepack enable
yarn install
yarn playwright install chromium
```

The Yarn version is pinned in `package.json`. Dependencies use the standard
`node_modules` layout; commit `yarn.lock` when dependencies change. In CI, use
`yarn install --immutable` to prevent lockfile changes.

Run the local server with `yarn start`. Run the shared checks with `yarn typecheck`
and `yarn test`, and create the production build with `yarn build`.

## Development Standards

New UIs use **React with TypeScript** and backends use **Node.js with TypeScript**.
Game rules remain framework-independent. Existing Carrom stays standalone. The
29 Card UI uses esbuild, React Testing Library/Jest component tests, and Playwright
browser coverage; server-only code stays outside its bundle.

Repository-wide assistant instructions are in `AGENTS.md`. The
[engineering guide](docs/engineering.md) covers clean code, pragmatic hexagonal
architecture, Zod boundary validation, and adding games. Reusable OpenCode skills
are in `.opencode/skills/`.

Use Jest for unit tests (`yarn test:unit`) and Playwright for browser tests
(`yarn test:e2e`). `yarn test` runs both; `yarn check` runs typechecking, both test
suites, and the production build. Each game keeps its tests alongside its source.
