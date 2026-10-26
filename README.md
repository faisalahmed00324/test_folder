# Games

Each game lives in its own folder. Carrom is available at `/Carrom/carrom.html`;
the root URL currently opens Carrom as the default game.

Twenty-Nine and Twenty-Eight are under development in [`29_Card/`](29_Card/README.md).
The pure engine covers complete hands and matches. A server-runtime foundation adds
secure shuffling, serialized commands, idempotency, and turn timers/time banks.
An injectable WebSocket gateway adds private seat routing, bounded reconnect
replay, and snapshot fallback. `corepack yarn start:29` starts an ephemeral
multi-table host at `http://127.0.0.1:8766`, without keys, configuration files,
accounts, or saved history. Create a table to receive a six-digit PIN and the
first seat; three friends join with that PIN and get the remaining seats
automatically. Invisible random credentials keep each seat's private traffic
separate; the shared PIN is not a reconnect credential.

For the React table UI, run `corepack yarn build:ui`, `corepack yarn start`,
and `corepack yarn start:29` in separate terminals, then open
`http://127.0.0.1:8765/29_Card/index.html`. All four players must confirm the
15-second ready check before dealing. Disconnect grace, filtered-view bots,
turn-boundary reclaim, fixed-phrase quick chat, and unanimous rematches remain.
Tables expire after six hours or ten minutes without connected players; restart
discards all tables and credentials. No login, journal key, invitation link,
manual token setup, or result-history persistence is required. The old encrypted
private-server adapters remain internal legacy modules, not the default workflow.
See the [game README](29_Card/README.md) for API and deployment limits.
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
