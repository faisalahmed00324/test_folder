# Repository Instructions

Apply these defaults to every game and shared tool in this repository. Read the
nearest game README and any nested AGENTS.md before changing game behavior.

## Tooling

- Use the pinned Yarn version through Corepack. Never add npm or pnpm lockfiles.
- Use React with TypeScript for new UIs and Node.js with TypeScript for backends.
  This is the forward-looking stack, not a request to migrate existing Carrom.
- Keep React components focused on presentation and interaction. Keep rules and
  use cases framework-independent; Node.js transport handlers call use cases,
  rather than implementing game rules themselves.
- New React apps need an explicit bundler, JSX/typecheck configuration, and build
  integration. Never serve raw JSX/TSX through the current static asset pipeline.
- Use Jest for unit tests and Playwright for browser integration and E2E tests.
- Use Zod for untrusted structured input: saved games, network responses, messages,
  configuration, and imported data. Validate once at the boundary with `safeParse`
  when failure is expected; handle errors explicitly. Infer TypeScript types from
  schemas instead of maintaining duplicate types.
- Do not add Zod to trusted inner-loop calculations or to a standalone browser
  script via a bare package import. The current browser assets have no bundler;
  introduce a deliberate build integration if a browser feature needs Zod.
- Prefer TypeScript for new modules with an appropriate build/test setup. Preserve
  existing standalone JavaScript behavior; do not migrate unrelated code.

## Small Monorepo

- Keep each game's source, tests, rules, and README together. Today Carrom lives in
  `Carrom/`; preserve its public paths and direct-file browser support.
- Share tooling at the root. Extract a shared package only when multiple games
  actually need it; never import another game's internal modules.
- Use Yarn workspaces when independently packaged games or shared packages are
  introduced. Multiple folders alone do not require workspace manifests.
- Register new public assets in `server.js`'s `ASSETS` allowlist. Keep test drivers,
  fixtures, documentation, secrets, and development dependencies out of `dist/`.
- When adding a game, update test discovery, typechecking, coverage collection,
  build registration, and root documentation so root checks include it.

## Clean Code And Hexagonal Architecture

- Keep game rules and state transitions independent of the DOM, storage, network,
  UI framework, and test tooling. Dependencies point inward toward game logic.
- Application use cases coordinate rules and effects. Define small ports only for
  real external effects, such as persistence, clocks, randomness, or transport.
- Adapters implement those ports; wire them at the entry point. Inject effects
  where determinism or substitution is needed, not through a global service locator.
- Prefer plain functions and data. No mandatory classes, repositories, interfaces,
  dependency-injection container, or extra layer for a pure calculation.
- Use descriptive names, explicit invariants, short cohesive functions, and guard
  clauses. Extract helpers for meaningful reuse or complexity, not arbitrary line limits.
- Make the smallest correct change. Avoid speculative abstractions, unrelated
  refactors, duplicated rule logic, and compatibility layers without a real consumer.
- See `docs/engineering.md` for the dependency model and new-game checklist.

## Required Tests And Verification

- Every new or changed rule/use case needs Jest unit tests. Cover normal behavior,
  relevant edge cases, invalid inputs, and state invariants. Bug fixes need a
  regression test that fails without the fix.
- Exercise production functions directly. Mock only external boundaries; never
  duplicate the algorithm being tested. Do not expose production-only test hooks.
- Keep unit tests deterministic and independent of browsers, network, real time,
  and ambient randomness. Use Playwright for actual browser behavior.
- Keep Jest tests in `<game>/tests/unit/**/*.test.cjs` with explicit imports from
  `@jest/globals`. TypeScript or ESM tests require an intentional runner/config
  update; do not add undiscoverable tests or mix Jest and Playwright globals.
- For React component unit tests, use React Testing Library with Jest and jsdom
  when that setup is introduced. Test Node.js use cases in Node and transport
  adapters with integration tests; keep actual browser E2E coverage in Playwright.
- Run `yarn check` before completing code changes. It runs typechecking, unit tests,
  E2E tests, and the production build. Use `yarn test:unit --coverage` when changing
  domain logic; expand the coverage source list when adding modules or games.
- Report the checks run and any blockers. Never claim an unrun check passed.

## Reusable Skills

OpenCode skills live in `.opencode/skills/`. Use `game-development` for game rules,
architecture, and boundary validation; use `game-testing` for tests and regressions.
These skills elaborate this file rather than override it.
