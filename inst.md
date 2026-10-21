# Two-Player Carrom Game — Rules and Game Logic Specification

## 1. Game Overview

Implement a digital Carrom game for two players. Players take alternate turns using a striker to pocket carrom coins into one of the four corner pockets.

The game uses:
- 9 white coins
- 9 black coins
- 1 red queen
- 1 striker per turn (shared game striker)
- 4 corner pockets
- Two players: Player 1 and Player 2

Player 1 plays white coins, and Player 2 plays black coins. The queen is shared by both players.

The objective is to pocket all coins of your assigned color and satisfy the queen-covering rules before your opponent does.

## 2. Initial Board Setup

1. Place all 19 coins in the standard carrom arrangement at the center of the board.
2. Place the red queen at the center.
3. Arrange the white and black coins symmetrically around the queen.
4. Both players shoot from their own baseline at the bottom edge of the board from their perspective.
5. The first player is selected randomly or by a pre-game coin toss.
6. Player 1 is assigned white, and Player 2 is assigned black.
7. The game starts with Player 1's turn if no toss mechanism is implemented.

## 3. Turn Rules

Each turn follows these steps:

1. The active player places or moves the striker along their permitted baseline.
2. The player aims by selecting a direction and shot strength.
3. The player shoots the striker.
4. The physics engine simulates the striker and coin collisions until all moving objects stop.
5. Evaluate all pocketed coins, fouls, queen status, and scoring.
6. Determine whether the player retains the turn or the turn passes to the opponent.

### Turn Retention

- If the player legally pockets at least one coin of their own color, they get another turn.
- If the player pockets no coin of their own color, the turn passes to the opponent.
- Pocketing only an opponent's coin does not grant an extra turn.
- Pocketing the queen alone does not grant an extra turn unless the queen is legally covered during the required sequence.
- A foul normally ends the player's turn, subject to the queen and penalty rules below.

## 4. Coin Pocketing Rules

### Own Coins
- Pocketing your own coin legally removes it from the board.
- The coin counts toward your remaining coins and progress toward winning.
- Multiple own coins pocketed in one shot are all counted.

### Opponent's Coins
- Pocketed opponent coins are removed from the board.
- They do not count toward the active player's score.
- They do not grant an extra turn unless the shot also legally pockets at least one of the active player's own coins.

### Queen
- The red queen may be pocketed by either player.
- A player who pockets the queen must cover it by pocketing one of their own coins in the same shot or on their immediately following shot.
- If the player fails to cover the queen, the queen is returned to the center, or the nearest valid position according to the implementation's placement rules.
- If the queen is covered successfully, it is considered claimed by that player.
- Once claimed, the queen counts toward that player's score.
- The queen cannot be claimed by both players.

For a simpler implementation, use the following explicit behavior:
- Queen and own coin pocketed in the same shot: queen is covered immediately.
- Queen pocketed without an own coin: set `queenPendingCover` for the active player.
- If the active player pockets an own coin on their next valid shot, the queen is covered.
- If the active player fails to cover the queen on that shot, return the queen to the board and clear `queenPendingCover`.
- If a foul occurs while covering the queen, return the queen to the board and clear `queenPendingCover`.

## 5. Fouls and Penalties

A foul occurs when any of the following happens:

1. The striker is pocketed.
2. The player violates a configured shooting rule.
3. The striker is not placed within the permitted baseline.
4. A player attempts a shot while the board is still moving.

### Striker Pocketed
- The shot is a foul.
- The player's turn ends.
- Return the striker to its designated starting area.
- Return one previously pocketed coin belonging to the fouling player to the board, if one is available.
- If the queen was pending cover, return the queen to the board and cancel the pending cover.

### Other Fouls
- End the player's turn.
- Apply the configured penalty consistently.
- Do not award an extra turn for coins pocketed during an invalid shot.
- Restore any coins that must be returned under the selected rule set.

Implement foul handling in one centralized function so penalties remain consistent.

## 6. Scoring

Use the following scoring system:

- Each legally pocketed own coin: 1 point.
- Successfully covered queen: 3 bonus points.
- Opponent coins: 0 points for the active player.
- Fouls: apply the defined coin-return penalty; optionally subtract 1 point if the game configuration enables point penalties.

The implementation should track both:
- `coinsPocketed`: number of own coins legally pocketed.
- `score`: total points earned, including the queen bonus and any configured penalties.

Do not award the queen bonus until the queen has been successfully covered.

## 7. Winning Conditions

A player wins when:
1. All of their own coins have been legally pocketed.
2. The queen has been legally covered, if the queen is required by the configured rule set.
3. No unresolved foul or queen-covering action remains.

If a player pockets their final coin before legally covering the queen, the game must not automatically declare them the winner. Apply the configured queen rule to resolve the game.

When a player wins:
- Stop accepting shots.
- Display the winner.
- Display the final scores.
- Provide options to restart the game or return to the main menu.

## 8. Striker Controls

The player should be able to:
- Move the striker horizontally along their permitted baseline.
- Aim by dragging or rotating an aiming indicator.
- Set shot power using a drag distance, slider, or power meter.
- Release or click to shoot.

Controls must enforce:
- The striker remains within the permitted baseline.
- The striker cannot be placed over another coin.
- The striker cannot be moved while a shot is in progress.
- The next shot cannot begin until all coins have stopped moving.

## 9. Physics and Collision Rules

The physics engine must handle:
- Striker-to-coin collisions.
- Coin-to-coin collisions.
- Wall rebounds.
- Pocket detection.
- Friction and gradual deceleration.
- Coin removal when a coin enters a pocket.

The game must wait until all objects are stationary before evaluating the completed shot.

Use a small velocity threshold to determine when an object is stationary, and prevent the game from becoming stuck due to tiny residual velocities.

## 10. Game State

Maintain a centralized game state with at least these fields:

- `currentPlayer`: Player 1 or Player 2.
- `player1Color`: White.
- `player2Color`: Black.
- `player1Score`: Integer.
- `player2Score`: Integer.
- `player1CoinsRemaining`: Integer.
- `player2CoinsRemaining`: Integer.
- `queenStatus`: OnBoard, PendingCover, or Covered.
- `queenPendingCoverBy`: Player ID or null.
- `isShotInProgress`: Boolean.
- `gameStatus`: Ready, Playing, or Finished.
- `winner`: Player ID or null.
- `lastShotResult`: Pocketed coins, fouls, and turn outcome.

Keep game rules separate from rendering, animation, and physics calculations.

## 11. Shot Resolution Order

After every shot, process the result in this order:

1. Wait until all moving objects are stationary.
2. Detect which coins entered pockets.
3. Detect whether the striker was pocketed.
4. Identify all fouls.
5. Apply foul penalties and restore any required coins.
6. Resolve queen pocketing and cover status.
7. Update coin counts and scores.
8. Check the winning conditions.
9. Determine whether the current player retains the turn.
10. Update the UI to display the next player's turn or the winner.

Ensure that one shot is resolved exactly once, even if multiple physics events occur.

## 12. User Interface Requirements

Display:
- Player names and assigned colors.
- Current player's turn.
- Remaining coins for each player.
- Current scores.
- Queen status.
- Aiming indicator and shot power.
- Foul notifications.
- Winner announcement.
- Restart button.

Provide clear visual feedback for a successful pocket, a foul, queen coverage, and turn changes.

## 13. Implementation Requirements

- Separate game rules, physics, input controls, and UI components.
- Use deterministic state transitions where possible.
- Prevent input during animations and active shots.
- Keep coin counts and scores synchronized with the actual board state.
- Add unit tests for turn changes, fouls, queen coverage, scoring, and victory.
- Make rule constants configurable so the implementation can be adjusted to a specific Carrom rule variant.

## 14. Important Rule Clarification

Carrom rules vary by region and competition. This specification uses a simplified recreational rule set rather than claiming strict tournament compliance. Before release, confirm the desired rules for queen coverage, foul penalties, opponent coins, and final-coin situations.

The implementation must treat the rules in this document as the source of truth unless a rule is explicitly made configurable.
