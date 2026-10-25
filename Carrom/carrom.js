/* Browser input, rendering and animation. Rules live in carrom-rules.js. */
(function () {
  'use strict';
  const Rules = window.CarromRules;
  const Physics = window.CarromPhysics;
  const { CONFIG } = Rules;
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const byId = id => document.getElementById(id);
  let state = Rules.createGame();
  let aimAngle = Rules.defaultAim(state.currentPlayer);
  let gesture = null;
  let animationId = null;
  let previousTime = null;
  let accumulator = 0;

  function setMessage(text, foul = false) {
    byId('message').textContent = text;
    byId('message').classList.toggle('foul', foul);
  }

  function render() {
    const stationary = Rules.isStationary(state) && !state.isShotInProgress;
    const ready = stationary && state.gameStatus !== 'Finished';
    canvas.dataset.boardState = stationary ? 'stationary' : 'moving';
    canvas.dataset.completedShots = String(state.completedShots);
    canvas.dataset.currentPlayer = String(state.currentPlayer);
    canvas.dataset.strikerX = String(state.striker.x);
    canvas.dataset.strikerY = String(state.striker.y);
    canvas.dataset.aimAngle = String(aimAngle);
    for (const player of [1, 2]) {
      byId(`card-p${player}`).classList.toggle('active', player === state.currentPlayer);
      byId(`score-p${player}`).textContent = state[`player${player}Score`];
      byId(`coins-p${player}`).textContent = state[`player${player}CoinsRemaining`];
    }
    byId('turn-label').textContent = state.gameStatus === 'Finished' ?
      `Player ${state.winner} wins!` : `Player ${state.currentPlayer}'s Turn — ${state.currentPlayer === 1 ? 'Bottom' : 'Top'}`;
    byId('board-status').textContent = state.isShotInProgress ? 'Shot in progress — wait for the board to stop' :
      state.gameStatus === 'Finished' ? 'Game finished' : 'Board stationary — place, aim, and shoot';
    byId('queen-status').textContent = state.queenStatus === 'Covered' ?
      `Queen: Covered by Player ${state.queenCoveredBy}` : state.queenStatus === 'PendingCover' ?
        `Queen: Player ${state.queenPendingCoverBy} must cover on this shot` : 'Queen: On Board';
    byId('queen-status').classList.toggle('pending', state.queenStatus === 'PendingCover');
    byId('btn-shoot').disabled = !ready || !Rules.canPlaceStriker(state, state.striker.x);
    byId('power').disabled = !ready;
    byId('striker-position').disabled = !ready;
    byId('striker-position').value = state.striker.x;
    byId('striker-position-value').textContent = Math.round(state.striker.x);
    byId('winner-panel').classList.toggle('hidden', state.gameStatus !== 'Finished');
    if (state.gameStatus === 'Finished') {
      byId('winner-text').textContent = `Player ${state.winner} Wins!`;
      byId('winner-score').textContent = `Final scores — Player 1: ${state.player1Score} · Player 2: ${state.player2Score}`;
    }
    draw(ready);
  }

  function draw(ready) {
    ctx.clearRect(0, 0, 600, 600);
    ctx.fillStyle = '#68462d';
    ctx.fillRect(0, 0, 600, 600);
    ctx.fillStyle = '#e9c993';
    ctx.fillRect(40, 40, 520, 520);
    ctx.strokeStyle = '#6d3f30';
    ctx.lineWidth = 2;
    ctx.strokeRect(40, 40, 520, 520);
    for (const player of [1, 2]) {
      const y = CONFIG.baselines[player];
      const active = player === state.currentPlayer;
      ctx.strokeStyle = active ? '#0a7065' : '#845f48';
      ctx.lineWidth = active ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(CONFIG.baselineMinX, y - 8);
      ctx.lineTo(CONFIG.baselineMaxX, y - 8);
      ctx.moveTo(CONFIG.baselineMinX, y + 8);
      ctx.lineTo(CONFIG.baselineMaxX, y + 8);
      ctx.stroke();
      for (const x of [CONFIG.baselineMinX, CONFIG.baselineMaxX]) {
        ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = active ? '#07594f' : '#6d3f30';
      ctx.font = 'bold 13px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(`PLAYER ${player} · ${Rules.colorOf(player).toUpperCase()}`, 300, y + (player === 1 ? 42 : -32));
    }
    ctx.strokeStyle = '#9d423c';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(300, 300, 65, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(300, 300, 18, 0, Math.PI * 2); ctx.stroke();
    for (const x of [40, 560]) {
      for (const y of [40, 560]) {
        ctx.beginPath(); ctx.arc(x, y, CONFIG.pocketRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#16181b'; ctx.fill();
      }
    }
    for (const disk of [...state.coins, state.striker]) {
      if (disk.pocketed) continue;
      ctx.save();
      ctx.shadowColor = '#0005'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
      ctx.beginPath(); ctx.arc(disk.x, disk.y, disk.radius, 0, Math.PI * 2);
      ctx.fillStyle = { white: '#fff9e7', black: '#24242c', queen: '#d73550', striker: '#f4b82d' }[disk.type];
      ctx.fill(); ctx.strokeStyle = '#0008'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
      if (disk.type === 'striker') {
        ctx.beginPath(); ctx.arc(disk.x, disk.y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = '#81551b'; ctx.stroke();
      }
    }
    if (ready) drawAim();
  }

  function drawAim() {
    const start = state.striker;
    const length = 70 + Number(byId('power').value) * 1.1;
    const dx = Math.cos(aimAngle), dy = Math.sin(aimAngle);
    const x = start.x + dx * length, y = start.y + dy * length;
    ctx.save();
    ctx.strokeStyle = '#087c70'; ctx.fillStyle = '#087c70'; ctx.lineWidth = 3;
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(start.x + dx * 20, start.y + dy * 20); ctx.lineTo(x, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x - dx * 14 - dy * 7, y - dy * 14 + dx * 7);
    ctx.lineTo(x - dx * 14 + dy * 7, y - dy * 14 - dx * 7);
    ctx.closePath(); ctx.fill(); ctx.restore();
  }

  function finishShot() {
    const result = Rules.resolveShot(state);
    if (!result) return;
    aimAngle = Rules.defaultAim(state.currentPlayer);
    gesture = null;
    setMessage(result.message, result.fouls.length > 0);
    render();
    canvas.dispatchEvent(new CustomEvent('carrom:shot-complete', { detail: { id: result.id } }));
  }

  function frame(time) {
    animationId = null;
    if (!state.isShotInProgress) return;
    if (previousTime === null) previousTime = time - 1000 / 60;
    accumulator += Math.min(time - previousTime, 100);
    previousTime = time;
    while (accumulator >= 1000 / 60 && state.isShotInProgress) {
      Physics.step(state);
      accumulator -= 1000 / 60;
      if (Rules.isStationary(state)) finishShot();
    }
    render();
    if (state.isShotInProgress) animationId = requestAnimationFrame(frame);
  }

  function shoot() {
    if (state.isShotInProgress) {
      // Defensive path for a second shot attempt; the UI normally disables the button.
      Rules.recordFoul(state, 'Shot attempted while the board was moving');
      return;
    }
    if (!Rules.beginShot(state, aimAngle, Number(byId('power').value))) return;
    gesture = null;
    previousTime = null;
    accumulator = 0;
    setMessage('');
    render();
    animationId = requestAnimationFrame(frame);
  }

  function resetGame() {
    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
    previousTime = null;
    accumulator = 0;
    gesture = null;
    state = Rules.createGame();
    aimAngle = Rules.defaultAim(state.currentPlayer);
    byId('power').value = '50';
    byId('power-value').textContent = '50';
    setMessage('Player 1 starts from the bottom. Player 2 shoots from the top.');
    render();
  }

  function point(event) {
    const box = canvas.getBoundingClientRect();
    return { x: (event.clientX - box.left) * 600 / box.width, y: (event.clientY - box.top) * 600 / box.height };
  }

  function place(x) {
    const clamped = Math.max(CONFIG.baselineMinX, Math.min(CONFIG.baselineMaxX, x));
    if (!Rules.placeStriker(state, clamped)) setMessage('That position is blocked by a coin. Choose a clear spot.');
    render();
  }

  function aim(p) {
    if (Math.hypot(p.x - state.striker.x, p.y - state.striker.y) > 2) {
      aimAngle = Math.atan2(p.y - state.striker.y, p.x - state.striker.x);
    }
    render();
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || state.isShotInProgress || state.gameStatus === 'Finished') return;
    const p = point(event);
    gesture = Math.abs(p.y - CONFIG.baselines[state.currentPlayer]) <= 28 ? 'place' : 'aim';
    canvas.setPointerCapture(event.pointerId);
    if (gesture === 'place') place(p.x); else aim(p);
  });
  canvas.addEventListener('pointermove', event => {
    if (!gesture || state.isShotInProgress || state.gameStatus === 'Finished') return;
    const p = point(event);
    if (gesture === 'place') place(p.x); else aim(p);
  });
  function endGesture(event) {
    gesture = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  canvas.addEventListener('pointerup', endGesture);
  canvas.addEventListener('pointercancel', endGesture);
  byId('striker-position').addEventListener('input', event => place(Number(event.target.value)));
  byId('power').addEventListener('input', event => {
    byId('power-value').textContent = event.target.value;
    render();
  });
  byId('btn-shoot').addEventListener('click', shoot);
  byId('btn-reset').addEventListener('click', resetGame);
  byId('btn-restart').addEventListener('click', resetGame);

  resetGame();
  // E2E_INJECTION_POINT
})();
