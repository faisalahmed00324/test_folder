import { z } from 'zod';

export const seatSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export const directionSchema = z.enum(['clockwise', 'counterclockwise']);
export type Seat = z.infer<typeof seatSchema>;
export type Direction = z.infer<typeof directionSchema>;
export type Team = 'A' | 'B';

export function nextSeat(seat: Seat, direction: Direction): Seat {
  return ((seat + (direction === 'clockwise' ? 1 : 3)) % 4) as Seat;
}

export function partnerSeat(seat: Seat): Seat {
  return ((seat + 2) % 4) as Seat;
}

export function teamForSeat(seat: Seat): Team {
  return seat % 2 === 0 ? 'A' : 'B';
}

export function dealOrder(dealer: Seat, direction: Direction): readonly Seat[] {
  const eldest = nextSeat(dealer, direction);
  const second = nextSeat(eldest, direction);
  return [eldest, second, nextSeat(second, direction), dealer];
}
