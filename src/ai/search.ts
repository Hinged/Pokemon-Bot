import { makeSeed, PRNG, type Battle, type PRNGSeed } from '../ps.js';
import type { BattleRequest, SideID } from '../battle/protocol.js';
import { cloneBattle, type Belief } from '../battle/belief.js';
import { choiceString, combos, slotOptions, type SlotOption } from './actions.js';
import { evaluate, DEFAULT_WEIGHTS, type EvalWeights } from './evaluate.js';
import { Heuristics } from './heuristics.js';
import { ThreatModel } from './threat.js';
import { solveZeroSum } from './nash.js';

export interface SearchOptions {
  /** Candidate actions kept per active slot for us / the opponent. */
  ourPerSlot: number;
  foePerSlot: number;
  /** Joint actions kept after combining slots. */
  ourJoint: number;
  foeJoint: number;
  /** Random seeds averaged per cell (damage rolls, crits, accuracy). */
  samples: number;
  /** Stop adding samples once this much time has been spent. */
  timeBudgetMs: number;
  /** Never exceed this, even before every cell has been simulated once (turn timers). */
  hardLimitMs: number;
  /**
   * `nash`: sample from the equilibrium strategy (unexploitable).
   * `best`: the highest-probability equilibrium action.
   */
  play: 'nash' | 'best';
  weights: EvalWeights;
  /** Weight of the next-turn threat term in leaf evaluation (0 disables it). */
  threatWeight: number;
}

export const DEFAULT_SEARCH: SearchOptions = {
  ourPerSlot: 6,
  foePerSlot: 5,
  ourJoint: 30,
  foeJoint: 16,
  samples: 3,
  timeBudgetMs: 6000,
  hardLimitMs: 20000,
  play: 'nash',
  weights: DEFAULT_WEIGHTS,
  threatWeight: 0.35,
};

export interface SearchResult {
  choice: string;
  value: number;
  /** Our candidate joint actions with equilibrium probability and value vs. the opponent's mix. */
  candidates: { choice: string; prob: number; value: number }[];
  /** The opponent's predicted mix. */
  opponent: { choice: string; prob: number }[];
  simulations: number;
  elapsedMs: number;
}

interface Ranked { opt: SlotOption; score: number }

/** Keeps the top options per slot, always including Protect and the best switch when present. */
function prune(ranked: Ranked[][], keep: number): Ranked[][] {
  return ranked.map(options => {
    const out = options.slice(0, keep);
    const protect = options.find(o => o.opt.moveId && ['protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'silktrap', 'burningbulwark'].includes(o.opt.moveId));
    if (protect && !out.includes(protect)) out[out.length - 1] = protect;
    const sw = options.find(o => o.opt.kind === 'switch');
    if (sw && !out.includes(sw) && out.length >= 3) out[out.length - 2] = sw;
    return out;
  });
}

function jointCandidates(ranked: Ranked[][], limit: number): SlotOption[][] {
  const all = combos(ranked.map(slot => slot.map(r => r.opt)));
  const score = new Map<SlotOption, number>();
  for (const slot of ranked) for (const r of slot) score.set(r.opt, r.score);
  return all
    .map(c => ({ c, s: c.reduce((a, o) => a + (score.get(o) ?? 0), 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.c);
}

function residualPending(battle: Battle): boolean {
  return battle.queue.list.some(action => action.choice === 'residual');
}

/** Plays one turn on a clone and returns the evaluation, or NaN if a choice was rejected. */
export function simulateTurn(
  snapshot: string,
  ourSide: SideID,
  ours: string,
  theirs: string,
  seed: PRNGSeed,
  weights: EvalWeights,
  threat?: ThreatModel,
): number {
  const battle = cloneBattle(snapshot);
  battle.prng = new PRNG(seed);
  const foeSide: SideID = ourSide === 'p1' ? 'p2' : 'p1';
  try {
    if (!battle.choose(ourSide, ours)) return NaN;
    if (!battle.ended && battle[foeSide].activeRequest && !battle[foeSide].isChoiceDone()) {
      if (!battle.choose(foeSide, theirs)) return NaN;
    }
    // Finish the turn if a mid-turn switch (U-turn, Eject Button...) paused it.
    let guard = 0;
    while (!battle.ended && battle.requestState === 'switch' && residualPending(battle) && guard++ < 6) {
      for (const side of battle.sides) {
        if (side.activeRequest && !side.activeRequest.wait && !side.isChoiceDone()) battle.choose(side.id, 'default');
      }
    }
  } catch {
    return NaN;
  }
  return evaluate(battle, ourSide, weights) + (threat ? threat.score(battle, ourSide) : 0);
}

function sampleSeeds(count: number, rng: () => number): PRNGSeed[] {
  return Array.from({ length: count }, () => makeSeed([0, 0, 0, 0].map(() => rng() * 0x10000)));
}

function pickFromMix(probs: number[], rng: () => number, floor = 0.05): number {
  const trimmed = probs.map(p => (p >= floor ? p : 0));
  const total = trimmed.reduce((a, b) => a + b, 0);
  if (total <= 0) return probs.indexOf(Math.max(...probs));
  let r = rng() * total;
  for (let i = 0; i < trimmed.length; i++) {
    r -= trimmed[i];
    if (r <= 0) return i;
  }
  return trimmed.length - 1;
}

/**
 * Simultaneous-move search over one turn: simulate every pruned (our joint action, their joint
 * action) pair in the real simulator, evaluate the results, and solve the matrix game.
 */
export function searchTurn(
  belief: Belief,
  request: BattleRequest,
  rng: () => number,
  options: Partial<SearchOptions> = {},
): SearchResult {
  const opts = { ...DEFAULT_SEARCH, ...options };
  const start = performance.now();
  const { battle, ourSide, foeSide } = belief;
  const heuristics = new Heuristics(battle);

  const foeAlive = battle[foeSide].active.map(p => !!p && !p.fainted && p.hp > 0);
  const ourAlive = battle[ourSide].active.map(p => !!p && !p.fainted && p.hp > 0);
  const ourRanked = prune(heuristics.rank(ourSide, slotOptions(request, { foeAlive }), request), opts.ourPerSlot);
  const ourJoint = jointCandidates(ourRanked, opts.ourJoint);

  const foeRequest = battle[foeSide].activeRequest as unknown as BattleRequest | null;
  const foeJoint = foeRequest && foeRequest.active ?
    jointCandidates(prune(heuristics.rank(foeSide, slotOptions(foeRequest, { foeAlive: ourAlive }), foeRequest), opts.foePerSlot), opts.foeJoint) :
    [[{ kind: 'pass', choice: 'pass' } as SlotOption]];

  const ourChoices = ourJoint.map(choiceString);
  const foeChoices = foeJoint.map(choiceString);
  const sums = ourChoices.map(() => foeChoices.map(() => 0));
  const counts = ourChoices.map(() => foeChoices.map(() => 0));
  const rejected = ourChoices.map(() => foeChoices.map(() => false));
  const threat = opts.threatWeight > 0 ? new ThreatModel(battle, opts.threatWeight) : undefined;
  let simulations = 0;

  const sampleCell = (i: number, j: number, seed: PRNGSeed) => {
    if (rejected[i][j]) return;
    const v = simulateTurn(belief.snapshot, ourSide, ourChoices[i], foeChoices[j], seed, opts.weights, threat);
    simulations++;
    if (Number.isNaN(v)) {
      rejected[i][j] = true;
      return;
    }
    sums[i][j] += v;
    counts[i][j]++;
  };

  const solve = () => {
    // Drop rows/columns the simulator rejected outright.
    const rows = ourChoices.map((_, i) => i).filter(i => counts[i].some(c => c > 0));
    const cols = foeChoices.map((_, j) => j).filter(j => rows.some(i => counts[i][j] > 0));
    const matrix = rows.map(i => cols.map(j => {
      if (counts[i][j]) return sums[i][j] / counts[i][j];
      const known = cols.filter(k => counts[i][k]).map(k => sums[i][k] / counts[i][k]);
      return known.length ? Math.min(...known) : 0;
    }));
    return { rows, cols, matrix, solution: solveZeroSum(matrix) };
  };

  // Every cell once, then spend the remaining samples where the equilibrium is decided:
  // our most promising rows against the opponent's most relevant replies.
  const seeds = sampleSeeds(opts.samples, rng);
  const hardLimit = Math.max(opts.hardLimitMs, opts.timeBudgetMs);
  // Candidates are sorted best-first, so a cut-off pass still covers the most promising cells.
  firstPass: for (let i = 0; i < ourChoices.length; i++) {
    for (let j = 0; j < foeChoices.length; j++) {
      if (performance.now() - start > hardLimit) break firstPass;
      sampleCell(i, j, seeds[0]);
    }
  }
  for (let s = 1; s < seeds.length; s++) {
    if (performance.now() - start > opts.timeBudgetMs) break;
    const { rows, cols, matrix, solution } = solve();
    const rowValue = matrix.map(row => row.reduce((a, v, j) => a + v * solution.col[j], 0));
    const topRows = rows.map((i, r) => ({ i, key: solution.row[r] + rowValue[r] * 1e-3 }))
      .sort((a, b) => b.key - a.key).slice(0, Math.max(6, Math.ceil(rows.length / 3))).map(x => x.i);
    const colPressure = cols.map((j, c) => ({ j, key: solution.col[c] - Math.min(...rows.map((_, r) => matrix[r][c])) * 1e-3 }));
    const topCols = colPressure.sort((a, b) => b.key - a.key).slice(0, Math.max(5, Math.ceil(cols.length / 2))).map(x => x.j);
    for (const i of topRows) for (const j of topCols) sampleCell(i, j, seeds[s]);
  }

  const { rows, cols, matrix, solution } = solve();
  if (!rows.length || !cols.length) {
    return { choice: ourChoices[0], value: 0, candidates: [], opponent: [], simulations, elapsedMs: performance.now() - start };
  }
  const rowValues = matrix.map(row => row.reduce((a, v, j) => a + v * solution.col[j], 0));
  const index = opts.play === 'best' ?
    solution.row.indexOf(Math.max(...solution.row)) :
    pickFromMix(solution.row, rng);

  const candidates = rows.map((i, r) => ({ choice: ourChoices[i], prob: solution.row[r], value: rowValues[r] }))
    .sort((a, b) => b.prob - a.prob || b.value - a.value);
  const opponent = cols.map((j, c) => ({ choice: foeChoices[j], prob: solution.col[c] }))
    .sort((a, b) => b.prob - a.prob);
  return {
    choice: ourChoices[rows[index]],
    value: solution.value,
    candidates,
    opponent,
    simulations,
    elapsedMs: performance.now() - start,
  };
}
