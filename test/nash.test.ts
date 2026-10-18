import { describe, expect, it } from 'vitest';
import { maximin, solveZeroSum } from '../src/ai/nash.js';

describe('matrix game solver', () => {
  it('finds the uniform equilibrium of rock-paper-scissors', () => {
    const rps = [[0, -1, 1], [1, 0, -1], [-1, 1, 0]];
    const { row, col, value } = solveZeroSum(rps, 5000);
    for (const p of [...row, ...col]) expect(p).toBeCloseTo(1 / 3, 1);
    expect(value).toBeCloseTo(0, 1);
  });

  it('plays a dominant strategy', () => {
    const payoff = [[3, 2], [1, 0]];
    const { row, col } = solveZeroSum(payoff);
    expect(row[0]).toBeGreaterThan(0.95);
    expect(col[1]).toBeGreaterThan(0.95);
    expect(maximin(payoff)).toEqual({ index: 0, value: 2 });
  });

  it('mixes when guessing matters (Protect vs attack)', () => {
    // Attack into Protect wastes the turn; attacking a non-protecting foe wins big.
    const payoff = [[-1, 2], [0.5, -0.5]];
    const { row } = solveZeroSum(payoff, 5000);
    expect(row[0]).toBeGreaterThan(0.1);
    expect(row[1]).toBeGreaterThan(0.1);
  });
});
