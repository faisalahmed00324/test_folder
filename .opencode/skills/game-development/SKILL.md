---
name: game-development
description: Build or change games using React UIs, Node.js backends, clean code, hexagonal architecture, Zod boundary validation, and shared Yarn tooling.
---

# Game Development

1. Read root `AGENTS.md`, `docs/engineering.md`, and the affected game's README.
   Identify confirmed rules, existing boundaries, public URLs, and build constraints.
   Use React with TypeScript for new UIs and Node.js with TypeScript for backends. Preserve
   existing Carrom unless migration is requested. Integrate a real React build before
   introducing JSX/TSX; the current static asset copier is not a bundler.
2. Keep game rules and state transitions free of browser and infrastructure imports.
   Put orchestration in application code and external effects behind small injected
    ports only when needed. Use functions and plain data before classes or frameworks.
   Treat React components and Node.js transport handlers as adapters, not places
   for game rules. Keep simulation loops outside React render state. Add a backend
   only for actual server-side requirements and keep secrets out of client bundles.
3. Parse untrusted structured data with Zod in the entering adapter. Handle expected
   validation failures, infer types from schemas, and preserve domain invariants.
   Do not add validation to hot simulation loops or break standalone browser imports.
4. Make the smallest change in the game's own folder. Share modules only for real
   cross-game reuse. Avoid premature workspace packages and architectural scaffolding.
5. Add Jest tests for new rules and regressions, plus Playwright tests for changed
   player interactions. Use the `game-testing` skill for the verification workflow.
6. Register any new production assets and update discovery/configuration for new
   games. Run `yarn check` and report results and any remaining limitations.
