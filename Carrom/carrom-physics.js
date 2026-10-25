/* Fixed-step physics; pocket events are always handed to the authoritative rules. */
(function (root) {
  'use strict';
  const Rules = root.CarromRules;
  const { CONFIG } = Rules;
  const FRICTION = 0.982;
  const STOP_SPEED = 0.07;

  function collide(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy);
    const minimum = a.radius + b.radius;
    if (distance >= minimum) return;
    const nx = distance > 0 ? dx / distance : 1;
    const ny = distance > 0 ? dy / distance : 0;
    const inverseA = a.type === 'striker' ? 0.5 : 1;
    const inverseB = b.type === 'striker' ? 0.5 : 1;
    const total = inverseA + inverseB;
    const overlap = minimum - distance;
    a.x -= nx * overlap * inverseA / total;
    a.y -= ny * overlap * inverseA / total;
    b.x += nx * overlap * inverseB / total;
    b.y += ny * overlap * inverseB / total;
    const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (relative >= 0) return;
    const impulse = -(1 + 0.88) * relative / total;
    a.vx -= impulse * nx * inverseA;
    a.vy -= impulse * ny * inverseA;
    b.vx += impulse * nx * inverseB;
    b.vy += impulse * ny * inverseB;
  }

  function pockets() {
    const low = CONFIG.padding;
    const high = CONFIG.boardSize - low;
    return [{ x: low, y: low }, { x: high, y: low }, { x: low, y: high }, { x: high, y: high }];
  }

  function contain(state, disk) {
    if (disk.pocketed) return;
    const pocket = pockets().find(p => Math.hypot(disk.x - p.x, disk.y - p.y) < CONFIG.pocketRadius);
    if (pocket && (disk.type !== 'striker' || CONFIG.strikerCanBePocketed)) {
      Rules.recordPocket(state, disk);
      return;
    }
    const low = CONFIG.padding + disk.radius;
    const high = CONFIG.boardSize - CONFIG.padding - disk.radius;
    if (disk.x < low) { disk.x = low; disk.vx = Math.abs(disk.vx) * 0.76; }
    if (disk.x > high) { disk.x = high; disk.vx = -Math.abs(disk.vx) * 0.76; }
    if (disk.y < low) { disk.y = low; disk.vy = Math.abs(disk.vy) * 0.76; }
    if (disk.y > high) { disk.y = high; disk.vy = -Math.abs(disk.vy) * 0.76; }
  }

  function step(state) {
    if (!state.isShotInProgress) return;
    // Four substeps prevent fast disks from tunnelling through coins or pockets.
    for (let substep = 0; substep < 4; substep++) {
      const disks = [state.striker, ...state.coins].filter(d => !d.pocketed);
      for (const disk of disks) {
        disk.x += disk.vx / 4;
        disk.y += disk.vy / 4;
        contain(state, disk);
      }
      for (let i = 0; i < disks.length; i++) {
        for (let j = i + 1; j < disks.length; j++) {
          if (!disks[i].pocketed && !disks[j].pocketed) collide(disks[i], disks[j]);
        }
      }
      for (const disk of disks) contain(state, disk);
    }
    for (const disk of [state.striker, ...state.coins]) {
      disk.vx *= FRICTION;
      disk.vy *= FRICTION;
      if (Math.hypot(disk.vx, disk.vy) < STOP_SPEED) disk.vx = disk.vy = 0;
    }
  }

  root.CarromPhysics = Object.freeze({ step });
})(window);
