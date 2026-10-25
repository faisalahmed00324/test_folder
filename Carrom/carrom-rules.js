/* Authoritative game model and rules. No DOM, input, animation, or test hooks. */
(function (root) {
  'use strict';

  const CONFIG = Object.freeze({
    boardSize: 600,
    padding: 40,
    coinRadius: 12,
    strikerRadius: 15,
    pocketRadius: 23,
    baselineMinX: 80,
    baselineMaxX: 520,
    baselines: Object.freeze({ 1: 480, 2: 120 }),
    queenBonus: 3,
    requireQueen: true,
    // Confirmed by the user: queen alone grants one immediate covering attempt.
    queenCoverAttempt: true,
    // User overrides to inst.md: striker rebounds, and an early final coin is returned.
    strikerCanBePocketed: false,
    returnFinalCoinBeforeQueen: true,
    extraFoulPointPenalty: 0,
  });

  function makeDisk(id, type, x, y) {
    return {
      id, type, x, y, vx: 0, vy: 0,
      radius: type === 'striker' ? CONFIG.strikerRadius : CONFIG.coinRadius,
      pocketed: false,
      creditedTo: null,
    };
  }

  const colorOf = player => player === 1 ? 'white' : 'black';
  const opponentOf = player => player === 1 ? 2 : 1;
  const defaultAim = player => player === 1 ? -Math.PI / 2 : Math.PI / 2;

  function createGame() {
    const coins = [makeDisk('queen', 'queen', 300, 300)];
    // A close-packed hexagon: queen + six inner + twelve outer coins.
    const spacing = CONFIG.coinRadius * 2 + 1;
    const positions = [];
    for (let ring = 1; ring <= 2; ring++) {
      for (let q = -ring; q <= ring; q++) {
        for (let r = -ring; r <= ring; r++) {
          if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) !== ring) continue;
          positions.push({
            ring,
            x: 300 + spacing * (q + r / 2),
            y: 300 + spacing * Math.sqrt(3) * r / 2,
          });
        }
      }
    }
    positions.sort((a, b) => a.ring - b.ring ||
      Math.atan2(a.y - 300, a.x - 300) - Math.atan2(b.y - 300, b.x - 300));
    const counts = { white: 0, black: 0 };
    positions.forEach((position, index) => {
      const color = index % 2 === 0 ? 'white' : 'black';
      coins.push(makeDisk(`${color}-${++counts[color]}`, color, position.x, position.y));
    });

    const state = {
      currentPlayer: 1,
      player1Color: 'white', player2Color: 'black',
      player1Score: 0, player2Score: 0,
      player1CoinsRemaining: 9, player2CoinsRemaining: 9,
      player1CoinsPocketed: 0, player2CoinsPocketed: 0,
      queenStatus: 'OnBoard', queenPendingCoverBy: null, queenCoveredBy: null,
      isShotInProgress: false, gameStatus: 'Playing', winner: null,
      shotNumber: 0, completedShots: 0, lastShotResult: null, activeShot: null,
      pointPenalties: { 1: 0, 2: 0 },
      coins,
      striker: makeDisk('striker', 'striker', 300, CONFIG.baselines[1]),
    };
    return state;
  }

  function syncTotals(state) {
    for (const player of [1, 2]) {
      const own = state.coins.filter(coin => coin.type === colorOf(player));
      const pocketed = own.filter(coin => coin.pocketed).length;
      state[`player${player}CoinsRemaining`] = own.length - pocketed;
      state[`player${player}CoinsPocketed`] = pocketed;
      state[`player${player}Score`] =
        own.filter(coin => coin.pocketed && coin.creditedTo === player).length +
        (state.queenCoveredBy === player ? CONFIG.queenBonus : 0) - state.pointPenalties[player];
    }
  }

  function isClear(state, x, y, radius, exceptId) {
    return state.coins.every(coin => coin.pocketed || coin.id === exceptId ||
      Math.hypot(coin.x - x, coin.y - y) >= coin.radius + radius + 0.5);
  }

  function canPlaceStriker(state, x) {
    return Number.isFinite(x) && x >= CONFIG.baselineMinX && x <= CONFIG.baselineMaxX &&
      isClear(state, x, CONFIG.baselines[state.currentPlayer], CONFIG.strikerRadius);
  }

  function placeStriker(state, x) {
    if (state.isShotInProgress || state.gameStatus === 'Finished') return false;
    if (!canPlaceStriker(state, x)) return false;
    Object.assign(state.striker, { x, y: CONFIG.baselines[state.currentPlayer], vx: 0, vy: 0, pocketed: false });
    return true;
  }

  function resetStriker(state) {
    // Prefer the center, or the closest clear point if a coin blocks it.
    Object.assign(state.striker, { vx: 0, vy: 0, pocketed: false });
    for (let offset = 0; offset <= CONFIG.baselineMaxX - 300; offset++) {
      for (const x of offset === 0 ? [300] : [300 - offset, 300 + offset]) {
        if (placeStriker(state, x)) return true;
      }
    }
    // A completely blocked baseline cannot accept another shot until it is clear.
    state.striker.x = 300;
    state.striker.y = CONFIG.baselines[state.currentPlayer];
    return false;
  }

  function returnCoin(state, coin) {
    // Deterministic nearest free center placement; never stack returned coins.
    const candidates = [];
    for (let x = 70; x <= 530; x += 25) {
      for (let y = 70; y <= 530; y += 25) candidates.push({ x, y });
    }
    candidates.push({ x: 300, y: 300 });
    candidates.sort((a, b) =>
      Math.hypot(a.x - 300, a.y - 300) - Math.hypot(b.x - 300, b.y - 300) || a.y - b.y || a.x - b.x);
    const spot = candidates.find(p => isClear(state, p.x, p.y, coin.radius, coin.id));
    if (!spot) throw new Error('No free position for a returned coin.');
    Object.assign(coin, spot, { vx: 0, vy: 0, pocketed: false, creditedTo: null });
  }

  function returnQueen(state) {
    returnCoin(state, state.coins.find(coin => coin.type === 'queen'));
    state.queenStatus = 'OnBoard';
    state.queenPendingCoverBy = null;
    state.queenCoveredBy = null;
  }

  function isStationary(state) {
    return [state.striker, ...state.coins].every(disk => disk.pocketed ||
      (disk.vx === 0 && disk.vy === 0));
  }

  function beginShot(state, angle, power) {
    if (state.gameStatus === 'Finished' || state.isShotInProgress || !isStationary(state)) return false;
    if (!Number.isFinite(angle) || !Number.isFinite(power) || power < 1 || power > 100) return false;
    if (!canPlaceStriker(state, state.striker.x) ||
        state.striker.y !== CONFIG.baselines[state.currentPlayer]) return false;
    state.activeShot = {
      id: ++state.shotNumber,
      player: state.currentPlayer,
      pocketedIds: [],
      // A per-shot snapshot, not an all-time list of pockets.
      previouslyPocketedIds: state.coins.filter(c => c.pocketed).map(c => c.id),
      pendingCoverBy: state.queenPendingCoverBy,
      fouls: [],
    };
    state.isShotInProgress = true;
    state.striker.vx = Math.cos(angle) * power * 0.15;
    state.striker.vy = Math.sin(angle) * power * 0.15;
    return true;
  }

  function recordPocket(state, disk) {
    if (!state.isShotInProgress || disk.pocketed) return;
    if (disk.type === 'striker' && !CONFIG.strikerCanBePocketed) return;
    disk.pocketed = true;
    disk.vx = 0;
    disk.vy = 0;
    state.activeShot.pocketedIds.push(disk.id);
    if (disk.type === 'striker') state.activeShot.fouls.push('Striker pocketed');
  }

  function recordFoul(state, reason) {
    if (!state.isShotInProgress) return false;
    if (!state.activeShot.fouls.includes(reason)) state.activeShot.fouls.push(reason);
    return true;
  }

  function applyFoul(state, shot, newlyPocketed) {
    const returnedIds = [];
    // Invalid own-coin pockets are restored, not scored. Then apply one prior-coin penalty.
    for (const coin of newlyPocketed.filter(c => c.type === colorOf(shot.player))) {
      returnCoin(state, coin);
      returnedIds.push(coin.id);
    }
    const penaltyCoin = state.coins.find(c => c.type === colorOf(shot.player) &&
      c.pocketed && shot.previouslyPocketedIds.includes(c.id));
    if (penaltyCoin) {
      returnCoin(state, penaltyCoin);
      returnedIds.push(penaltyCoin.id);
    }
    if (state.queenStatus === 'PendingCover' || newlyPocketed.some(c => c.type === 'queen')) {
      returnQueen(state);
      returnedIds.push('queen');
    }
    state.pointPenalties[shot.player] += CONFIG.extraFoulPointPenalty;
    return returnedIds;
  }

  function resolveShot(state) {
    if (!state.isShotInProgress || !state.activeShot || !isStationary(state)) return null;
    const shot = state.activeShot;
    const pocketed = state.coins.filter(c => shot.pocketedIds.includes(c.id));
    const own = pocketed.filter(c => c.type === colorOf(shot.player));
    const queenPocketed = pocketed.some(c => c.type === 'queen');
    const foul = shot.fouls.length > 0;
    let retained = false;
    let message;
    let returnedIds = [];

    if (foul) {
      returnedIds = applyFoul(state, shot, pocketed);
      message = `Foul: ${shot.fouls.join(', ')}. Turn passes to Player ${opponentOf(shot.player)}.`;
    } else {
      own.forEach(coin => { coin.creditedTo = shot.player; });
      retained = own.length > 0;
      message = retained ? `Player ${shot.player} pocketed ${own.length} own coin(s). Shoot again.` :
        `No own coin pocketed. Player ${opponentOf(shot.player)}'s turn.`;

      if (queenPocketed || shot.pendingCoverBy === shot.player) {
        if (own.length > 0) {
          state.queenStatus = 'Covered';
          state.queenCoveredBy = shot.player;
          state.queenPendingCoverBy = null;
          message = `Player ${shot.player} covered the queen! +${CONFIG.queenBonus} bonus. Shoot again.`;
        } else if (queenPocketed && shot.pendingCoverBy === null) {
          state.queenStatus = 'PendingCover';
          state.queenPendingCoverBy = shot.player;
          retained = CONFIG.queenCoverAttempt;
          message = `Player ${shot.player}: cover the queen with an own coin on this next shot.`;
        } else {
          returnQueen(state);
          returnedIds.push('queen');
          message = `Queen not covered; returned to the board. Player ${opponentOf(shot.player)}'s turn.`;
        }
      }
    }

    syncTotals(state);
    if (!foul && CONFIG.returnFinalCoinBeforeQueen && state.queenStatus === 'OnBoard' &&
        state[`player${shot.player}CoinsRemaining`] === 0 && own.length > 0) {
      const lastCoin = own[own.length - 1];
      returnCoin(state, lastCoin);
      returnedIds.push(lastCoin.id);
      retained = false;
      message = `Final coin returned: cover the queen before finishing. Player ${opponentOf(shot.player)}'s turn.`;
      syncTotals(state);
    }
    state.isShotInProgress = false;
    state.activeShot = null;
    state.completedShots++;

    // Retain the existing recreational rule: a covered queen is a board-wide prerequisite.
    // No victory is awarded during a foul or a pending covering action.
    if (!foul && state.queenStatus !== 'PendingCover') {
      for (const player of [shot.player, opponentOf(shot.player)]) {
        if (state[`player${player}CoinsRemaining`] === 0 &&
            (!CONFIG.requireQueen || state.queenStatus === 'Covered')) {
          state.winner = player;
          state.gameStatus = 'Finished';
          message = `Player ${player} wins!`;
          break;
        }
      }
    }
    if (state.gameStatus !== 'Finished' && !retained) state.currentPlayer = opponentOf(shot.player);
    state.lastShotResult = {
      id: shot.id, player: shot.player, pocketedIds: [...shot.pocketedIds],
      ownCoinsPocketed: foul ? 0 : own.filter(c => c.pocketed).length,
      fouls: [...shot.fouls], returnedIds,
      turnRetained: retained && !foul && state.gameStatus !== 'Finished',
      nextPlayer: state.currentPlayer, message,
    };
    resetStriker(state);
    return state.lastShotResult;
  }

  root.CarromRules = Object.freeze({
    CONFIG, createGame, colorOf, opponentOf, defaultAim, syncTotals,
    isStationary, canPlaceStriker, placeStriker, resetStriker,
    beginShot, recordPocket, recordFoul, resolveShot,
  });
})(typeof window === 'undefined' ? globalThis : window);
