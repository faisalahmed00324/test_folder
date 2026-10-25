# Games

Each game lives in its own folder. Carrom is available at `/Carrom/carrom.html`;
the root URL currently opens Carrom as the default game.

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
Game rules remain framework-independent. Existing Carrom stays standalone until
an explicit migration; React build tooling will be added with the first React app.

Repository-wide assistant instructions are in `AGENTS.md`. The
[engineering guide](docs/engineering.md) covers clean code, pragmatic hexagonal
architecture, Zod boundary validation, and adding games. Reusable OpenCode skills
are in `.opencode/skills/`.

Use Jest for unit tests (`yarn test:unit`) and Playwright for browser tests
(`yarn test:e2e`). `yarn test` runs both; `yarn check` runs typechecking, both test
suites, and the production build. Each game keeps its tests alongside its source.
