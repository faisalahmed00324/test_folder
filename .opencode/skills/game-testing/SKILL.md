---
name: game-testing
description: Add Jest unit tests and Playwright browser tests for game rules, use cases, validation, and bug regressions in this multi-game repository.
---

# Game Testing

1. Read `AGENTS.md`, the game README, existing tests, and the production functions
   being changed. Identify observable outcomes and invariants before writing tests.
2. Add unit tests in `<game>/tests/unit/**/*.test.cjs`, importing APIs from
   `@jest/globals`. Current Jest setup runs CommonJS in Node; explicitly configure
    a transformer/module mode before adding TypeScript or ESM test files.
   For new React components, intentionally configure TSX transformation, React
   Testing Library, and jsdom. Keep domain and Node.js backend tests in the Node
   environment; test transport wiring separately from framework-free use cases.
3. Test production code directly with fresh state per test. Cover valid behavior,
   relevant boundary values, invalid commands, scoring/turn invariants, and duplicate
   events where applicable. For a bug, demonstrate a failing regression first.
4. Keep tests deterministic. Inject clocks, randomness, storage, and transport when
   needed; mock those external boundaries rather than the rules under test. Avoid
   sleeps, live network requests, browser setup, and snapshots as the sole assertion.
5. Use Playwright for rendering, input, mobile coordinates, and production isolation.
   Wait for observable state, not elapsed time. Never ship scenario helpers or test APIs.
6. Run `yarn test:unit`, then `yarn test:unit --coverage` for domain changes. Include
   new production modules in Jest's coverage list and inspect uncovered branches.
7. Run `yarn check` for the full typecheck, unit, E2E, and build gate. Report actual
   results, and state clearly if environment limits prevented any verification.
