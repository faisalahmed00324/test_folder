# Engineering Guide

## Technology Stack

Use React with TypeScript for all new UIs and Node.js with TypeScript for
backends. Existing Carrom remains standalone JavaScript until an explicit migration
is requested; adding these standards does not migrate it or install React tooling.

React components are UI adapters: render state, collect intent, and call application
use cases. Keep game rules outside components and hooks. Use effects to synchronize
with external systems, not to duplicate derived state. Keep high-frequency canvas
simulation outside React render state and clean up animation loops and listeners.

Node.js HTTP or WebSocket handlers are transport adapters. Validate requests and
messages with Zod, invoke application use cases, and map results to responses.
Validate server configuration at startup. Keep storage and transport out of the
domain, and never expose server secrets in browser bundles. Do not add a backend
service to an offline-only game unless a feature actually requires one.

When introducing the first React app, deliberately add a bundler and JSX/TypeScript
configuration and integrate generated assets with the production build/server.
The current allowlist copier cannot compile React. Configure Jest transformation
for TS/TSX and React Testing Library with jsdom for component unit tests; retain
Node test environments for domain/backend tests and Playwright for browser E2E.
Add tooling when implementing the app, rather than adding unused scaffolding now.

## Architecture

Use hexagonal architecture as a dependency rule, not a required directory tree:

```text
React UI / Node.js transport / storage adapters
                |
                v
       Application use cases
                |
                v
        Domain rules and state
```

The application owns any ports it needs. An adapter satisfies a port, and the
entry point supplies the adapter. The domain never imports an adapter. For
example, a save-game use case can receive a `save(snapshot)` function rather than
importing `localStorage`; a game with no persistence needs no storage port.

Carrom already separates rules (`carrom-rules.js`), simulation
(`carrom-physics.js`), and browser orchestration (`carrom.js`). Preserve this useful
separation rather than renaming files or adding wrappers solely for architecture.
Keep the confirmed rules in `Carrom/README.md` authoritative during refactors.

If a new game grows enough to benefit from directories, use `domain/`,
`application/`, and `adapters/` within that game. Do not create empty scaffolding.
Only extract cross-game code after genuine reuse appears. Add Yarn workspaces when
packages need their own dependency manifests, not just because another game exists.

## Boundary Validation

Use Zod where unknown data enters the application, before calling domain logic:

```ts
import { z } from 'zod';

const savedScoreSchema = z.object({
  version: z.literal(1),
  score: z.number().int().nonnegative(),
});

type SavedScore = z.infer<typeof savedScoreSchema>;

export function parseSavedScore(input: unknown): SavedScore {
  return savedScoreSchema.parse(input);
}
```

Use `safeParse` and an explicit recovery path for routine failures such as a
corrupt local save. Use `parse` when a caller intentionally handles a thrown
validation error. Validate semantic rules as well as shape, and version persisted
formats. Unit-test valid, malformed, unsupported-version, and out-of-range inputs.
Do not repeatedly validate trusted state inside the simulation loop.

Zod is installed, but the existing Carrom game has no structured external-data
boundary that needs it today. Do not retrofit schemas without a real feature.
Bare imports such as `import { z } from 'zod'` do not work in the current static
browser delivery; bundle browser dependencies deliberately if a future feature
requires them. Preserve offline play and avoid CDN dependencies.

## Tests

- Jest runs `**/tests/unit/**/*.test.cjs` in Node. Import test APIs from
  `@jest/globals`; require the production module, not a copied implementation.
- Browser-global legacy modules can be required in a Jest test and read from
  `globalThis`, as Carrom's rule tests demonstrate. This does not require changing
  their shipped browser interface.
- Playwright discovers `Carrom/tests/e2e` and `29_Card/tests/e2e`, with a private
  test-only gateway host for card-table browser tests. Add explicit discovery and
  server setup for each new game's E2E tests; do not assume all games are covered.
- Typechecking includes both games' tests and 29 Card TypeScript/TSX source.
  Extend `tsconfig.json` when adding source or another game. React component tests
  use Jest/jsdom and Testing Library; backend/domain tests stay in Node.
- Jest coverage includes Carrom rules/physics and 29 Card TypeScript/TSX. Extend
  `collectCoverageFrom` as source is added; coverage is diagnostic, not proof of
  correct behavior or a substitute for meaningful assertions.

```sh
yarn test:unit
yarn test:unit:watch
yarn test:unit --coverage
yarn test:e2e
yarn check
```

## New Game Checklist

1. Describe rules, controls, public URL, and meaningful edge cases in its README.
2. Build new UIs in React and any required backend in Node.js. Integrate bundling,
   TypeScript, and test configuration; keep rules independent of both frameworks
   and add Jest tests alongside the game.
3. Add application ports only for actual effects; validate unknown data with Zod.
4. Register browser assets in `server.js` and verify production isolation.
5. Add E2E coverage for critical player interactions and update test discovery,
   typechecking, and coverage configuration for the new paths.
6. Document the game in the root README and run `yarn check`.
