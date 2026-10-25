import { expect, test as base, type Page } from '@playwright/test';

export type Player = 1 | 2;
export interface Disk {
  id: string;
  type: 'white' | 'black' | 'queen' | 'striker';
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  pocketed: boolean;
  creditedTo: Player | null;
}
export interface Snapshot {
  currentPlayer: Player;
  player1Score: number;
  player2Score: number;
  player1CoinsRemaining: number;
  player2CoinsRemaining: number;
  player1CoinsPocketed: number;
  player2CoinsPocketed: number;
  queenStatus: 'OnBoard' | 'PendingCover' | 'Covered';
  queenPendingCoverBy: Player | null;
  queenCoveredBy: Player | null;
  isShotInProgress: boolean;
  gameStatus: 'Playing' | 'Finished';
  winner: Player | null;
  completedShots: number;
  shotNumber: number;
  striker: Disk;
  coins: Disk[];
  aimAngle: number;
  config: { baselines: Record<Player, number>; strikerCanBePocketed: boolean };
  lastShotResult: null | {
    id: number;
    player: Player;
    ownCoinsPocketed: number;
    pocketedIds: string[];
    returnedIds: string[];
    fouls: string[];
    turnRetained: boolean;
  };
}
export interface Scenario {
  currentPlayer?: Player;
  pocketedIds?: string[];
  queenCoveredBy?: Player;
  positions?: { id: string; x: number; y: number }[];
}
interface Shot {
  pocketedIds?: string[];
  foul?: string;
}
declare global {
  interface Window {
    __carromTest: {
      snapshot(): Snapshot;
      load(options: Scenario): void;
      shot(options: Shot): void;
      resolveAgain(): void;
    };
  }
}

export const coinIds = (color: 'white' | 'black', count: number) =>
  Array.from({ length: count }, (_, index) => `${color}-${index + 1}`);

export class Game {
  constructor(readonly page: Page) {}

  async open() {
    await this.page.goto('/Carrom/carrom.html');
    await this.stationary();
  }

  async snapshot() {
    return this.page.evaluate(() => window.__carromTest.snapshot());
  }

  async load(options: Scenario = {}) {
    await this.page.evaluate(scenario => window.__carromTest.load(scenario), options);
    await this.stationary(0);
  }

  async shot(options: Shot = {}) {
    const before = await this.snapshot();
    await this.page.evaluate(shot => window.__carromTest.shot(shot), options);
    await this.stationary(before.completedShots + 1);
    return this.snapshot();
  }

  async stationary(completed?: number) {
    const board = this.page.getByTestId('board');
    if (completed !== undefined) await expect(board).toHaveAttribute('data-completed-shots', String(completed));
    await expect(board).toHaveAttribute('data-board-state', 'stationary');
    await expect.poll(async () => {
      const state = await this.snapshot();
      return !state.isShotInProgress && [state.striker, ...state.coins].every(d =>
        d.pocketed || (d.vx === 0 && d.vy === 0));
    }).toBe(true);
    await this.assertTotals();
  }

  async assertTotals() {
    const state = await this.snapshot();
    for (const player of [1, 2] as const) {
      const color = player === 1 ? 'white' : 'black';
      const remaining = state.coins.filter(d => d.type === color && !d.pocketed).length;
      expect(state[`player${player}CoinsRemaining`]).toBe(remaining);
      expect(state[`player${player}CoinsPocketed`]).toBe(9 - remaining);
      await expect(this.page.getByTestId(`coins-remaining-${player}`)).toHaveText(String(remaining));
      await expect(this.page.getByTestId(`score-${player}`)).toHaveText(String(state[`player${player}Score`]));
    }
  }

  async expectTurn(player: Player) {
    const state = await this.snapshot();
    expect(state.currentPlayer).toBe(player);
    expect(state.striker.y).toBe(player === 1 ? 480 : 120);
    expect(state.striker.x).toBe(300);
    expect(state.aimAngle).toBeCloseTo(player === 1 ? -Math.PI / 2 : Math.PI / 2);
    await expect(this.page.getByTestId('turn')).toContainText(`Player ${player}'s Turn`);
    await expect(this.page.getByTestId(`player-${player}`)).toHaveClass(/active/);
    await expect(this.page.getByTestId('shoot')).toBeEnabled();
  }

  async coordinates(x: number, y: number) {
    const box = await this.page.getByTestId('board').boundingBox();
    if (!box) throw new Error('Board is not visible');
    return { x: box.x + x * box.width / 600, y: box.y + y * box.height / 600 };
  }

  async clickBoard(x: number, y: number) {
    const point = await this.coordinates(x, y);
    await this.page.mouse.click(point.x, point.y);
  }

  async dragBoard(fromX: number, fromY: number, toX: number, toY: number) {
    const from = await this.coordinates(fromX, fromY);
    const to = await this.coordinates(toX, toY);
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    await this.page.mouse.move(to.x, to.y, { steps: 8 });
    await this.page.mouse.up();
  }

  async power(value: number) {
    const slider = this.page.getByTestId('power');
    await slider.focus();
    await slider.press('Home');
    for (let i = 1; i < value; i++) await slider.press('ArrowRight');
    await expect(slider).toHaveValue(String(value));
  }

  async shootAndWait() {
    const before = await this.snapshot();
    await this.page.getByTestId('shoot').click();
    await expect(this.page.getByTestId('board')).toHaveAttribute('data-board-state', 'moving');
    await this.stationary(before.completedShots + 1);
    return this.snapshot();
  }
}

export const test = base.extend<{ game: Game }>({
  game: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const game = new Game(page);
    await game.open();
    await use(game);
    expect(errors, 'No uncaught application errors').toEqual([]);
  },
});
export { expect };
