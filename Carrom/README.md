# Two-player Carrom

Open `Carrom/carrom.html` directly in a browser, or run `npm start` and visit
<http://127.0.0.1:8765/Carrom/carrom.html>. No CDN, runtime dependency, or internet connection is needed to play.

## Controls

- **Player 1 (white)** shoots from the bottom; **Player 2 (black)** shoots from the top.
- Click/drag on your highlighted baseline, or use the **Striker position** slider, to move sideways.
- Click/drag elsewhere on the board to aim. The dotted arrow points **in the shot direction** and remains visible after releasing.
- Set power and click **Shoot**. Controls are locked until every disk is stationary.
- Your striker resets to the center of your baseline after each shot (or the nearest free position if the center is blocked).
- An own-color pocket earns another shot. A subsequent miss passes the turn; old pockets never count again.

## Rules and confirmed clarifications

`inst.md` is the baseline specification. The following choices were explicitly confirmed
by the user during implementation and override conflicting or unspecified parts of it:

1. Derive the **16 core E2E scenarios** from `inst.md`; it contains no numbered scenario list.
2. A queen-only pocket grants the **same player one immediate covering attempt**.
   An own coin covers it; a miss, opponent-only pocket, or foul returns the queen and passes the turn.
3. **The striker never enters a pocket.** It rebounds at corner cushions. Consequently,
   striker-pocket-foul tests from the original request are replaced by physical rebound tests.
   Other invalid-shot fouls still pass the turn and apply the one-prior-own-coin return penalty.
4. Pocketing the final own coin before queen coverage **returns that coin without its point
   and passes the turn**. Pocketing the queen and final own coin together is a valid covered finish.

Rules remain recreational, not tournament-compliant. As in the previous implementation,
queen coverage is a board-wide winning prerequisite; a player does not have to personally own
the queen bonus to finish. Opponent coins leave the board but award no points to the shooter.
Invalid own-coin pockets are restored before a prior-coin foul penalty is applied.
Returning a credited coin revokes that coin's point; the separate additional foul-point
penalty is disabled. These choices and geometry are centralized in `CarromRules.CONFIG`.

## Implementation

- `carrom-rules.js`: authoritative state, per-shot pocket collection, scoring, queen rules,
  centralized fouls, victory, collision-free returns, legal striker placement.
- `carrom-physics.js`: fixed-step motion, substepped collisions, cushions, friction,
  and calls into the rules engine for pocket events.
- `carrom.js`: rendering, input controls, animation, and visible shot-completion state.

Each shot is resolved once, and only after all disk velocities are zero.
The canvas exposes read-only `data-board-state` (`moving` / `stationary`) and
`data-completed-shots`, plus a `carrom:shot-complete` event. These also support UI automation.

## Playwright E2E tests (TypeScript)

Requires Node.js 20 or later. In PowerShell, use `npm.cmd` / `npx.cmd` if execution
policy blocks the PowerShell wrappers.

```text
npm install
npx playwright install chromium
npm run typecheck
npm test
```

The config starts and stops dedicated servers at ports **8877** (instrumented tests)
and **8878** (actual production build). It does not reuse the development server at 8765.
Each test gets its own page and game; retries are disabled so failures are not hidden.
View the HTML report with `npx playwright show-report`.

### Sixteen core scenarios

| # | Group | Scenario |
|---|---|---|
| 01 | Setup | Correct 19-coin, non-overlapping rack; colors and first player |
| 02 | Turns | Misses pass turns and use opposite baselines |
| 03 | Turns | Own pocket retains turn; next miss passes without recounting |
| 04 | Turns | Opponent-only pocket: removed, no score, no extra turn |
| 05 | Turns/scoring | Multiple/mixed pockets score only new own coins |
| 06 | Queen | Same-shot cover and exactly one 3-point bonus |
| 07 | Queen | Queen-only immediate covering attempt and successful next-shot cover |
| 08 | Queen | Missed covering shot returns queen without overlaps |
| 09 | Queen | Opponent-only pocket does not cover queen |
| 10 | Queen/fouls | Invalid covering shot returns queen and cancels cover |
| 11 | Fouls/scoring | Return one prior own coin and its point, not an opponent coin |
| 12 | Fouls/scoring | No prior own coin: no invented coin or negative score |
| 13 | Pocket protection | Real physics striker/corner rebound, both players |
| 14 | Victory | Legal final coin wins; final scores and shot lock |
| 15 | Victory | Early final coin returned; no premature winner |
| 16 | Restart | Play Again fully resets a finished game |

Additional tests cover real clicking, dragging, aiming, sliders, power, collision/pocket
physics, active-shot input locks, restart during animation, scaled mobile coordinates,
exactly-once resolution, same-shot queen/final-coin victory, and production isolation.
All waits use explicit completed-shot counts and stationary state, **not sleeps**.

### Deterministic scenarios are test-only

`Carrom/tests/server.cjs` injects `Carrom/tests/support/browser-driver.js` into a private
application closure **only in the test server's response**. It is never imported by the
app or the production server. `load()` sets deterministic starting positions/history;
`shot()` calls the production `beginShot`, `recordPocket`, and `recordFoul`, then the
normal `finishShot`/`resolveShot`. It does not set winners/scores or duplicate rule logic.
Real-interaction tests additionally run the normal physics loop through the UI.

`npm run build` copies only the five public game assets to `dist/Carrom/` and removes the inert
injection comment. No driver, scenario code, test dependency, or test API is in the build.
`node server.js --production` builds and serves this allowlist; requests for `tests/`
or source documentation return 404. Query parameters cannot enable the test API.
Production-isolation tests verify both the delivered script and a real production UI shot.
