export interface MatrixSolution {
  /** Mixed strategy for the row (maximizing) player. */
  row: number[];
  /** Mixed strategy for the column (minimizing) player. */
  col: number[];
  /** Expected payoff to the row player. */
  value: number;
}

/**
 * Approximate Nash equilibrium of a zero-sum matrix game via regret matching+ with linear
 * averaging. `payoff[i][j]` is the row player's payoff.
 */
export function solveZeroSum(payoff: number[][], iterations = 2000): MatrixSolution {
  const m = payoff.length;
  const n = payoff[0]?.length ?? 0;
  if (!m || !n) return { row: [], col: [], value: 0 };
  const rowRegret = new Array(m).fill(0);
  const colRegret = new Array(n).fill(0);
  const rowSum = new Array(m).fill(0);
  const colSum = new Array(n).fill(0);
  const strategy = (regret: number[]) => {
    const total = regret.reduce((a, r) => a + Math.max(0, r), 0);
    return total > 0 ? regret.map(r => Math.max(0, r) / total) : regret.map(() => 1 / regret.length);
  };

  for (let t = 1; t <= iterations; t++) {
    const x = strategy(rowRegret);
    const y = strategy(colRegret);
    const rowValues = new Array(m).fill(0);
    const colValues = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        rowValues[i] += payoff[i][j] * y[j];
        colValues[j] += payoff[i][j] * x[i];
      }
    }
    const v = x.reduce((a, xi, i) => a + xi * rowValues[i], 0);
    for (let i = 0; i < m; i++) rowRegret[i] = Math.max(0, rowRegret[i] + rowValues[i] - v);
    for (let j = 0; j < n; j++) colRegret[j] = Math.max(0, colRegret[j] + v - colValues[j]);
    for (let i = 0; i < m; i++) rowSum[i] += t * x[i];
    for (let j = 0; j < n; j++) colSum[j] += t * y[j];
  }

  const rowTotal = rowSum.reduce((a, b) => a + b, 0);
  const colTotal = colSum.reduce((a, b) => a + b, 0);
  const row = rowSum.map(s => s / rowTotal);
  const col = colSum.map(s => s / colTotal);
  let value = 0;
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) value += row[i] * col[j] * payoff[i][j];
  return { row, col, value };
}

/** Row maximizing the worst case over columns. */
export function maximin(payoff: number[][]): { index: number; value: number } {
  let best = { index: 0, value: -Infinity };
  payoff.forEach((row, i) => {
    const worst = Math.min(...row);
    if (worst > best.value) best = { index: i, value: worst };
  });
  return best;
}
