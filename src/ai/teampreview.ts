import type { PokemonSet } from '../ps.js';
import { bestMove, speedOf, type Combatant } from '../data/damage.js';
import { dex } from '../data/format.js';
import { metaMon, type MetaSnapshot } from '../data/meta.js';
import { megaForm } from '../data/sets.js';

export interface Matchup {
  /** How well our Pokémon does 1-on-1 against theirs, from -1 (loses) to 1 (wins). */
  score: number;
  ourBest: { move: string; pct: number } | null;
  theirBest: { move: string; pct: number } | null;
  ourSpeed: number;
  theirSpeed: number;
}

export interface PreviewPlan {
  /** 0-based indices into our team: leads first, then the back line. */
  order: number[];
  matchups: Matchup[][];
  /** Estimated chance the opponent brings each of their Pokémon. */
  theirBringOdds: number[];
  notes: string[];
}

const SPEED_CONTROL = new Set(['tailwind', 'trickroom', 'icywind', 'electroweb', 'thunderwave']);
const REDIRECT = new Set(['followme', 'ragepowder']);

function combatant(set: PokemonSet): Combatant {
  return { set, mega: !!megaForm(set) };
}

function hitsToKo(pct: number): number {
  return pct > 0 ? Math.ceil(100 / pct) : 9;
}

export function matchup(ours: PokemonSet, theirs: PokemonSet): Matchup {
  const a = combatant(ours);
  const b = combatant(theirs);
  const ourBest = bestMove(a, b);
  const theirBest = bestMove(b, a);
  const ourSpeed = speedOf(a);
  const theirSpeed = speedOf(b);
  const ourHits = hitsToKo(ourBest?.avgPct ?? 0) - (ourSpeed > theirSpeed ? 0.5 : 0);
  const theirHits = hitsToKo(theirBest?.avgPct ?? 0) - (theirSpeed > ourSpeed ? 0.5 : 0);
  return {
    score: Math.tanh(0.8 * (theirHits - ourHits)),
    ourBest: ourBest && { move: ourBest.move, pct: ourBest.avgPct },
    theirBest: theirBest && { move: theirBest.move, pct: theirBest.avgPct },
    ourSpeed,
    theirSpeed,
  };
}

function hasMove(set: PokemonSet, ids: Set<string>): boolean {
  return set.moves.some(m => ids.has(dex.moves.get(m).id));
}

function supportValue(set: PokemonSet): number {
  let v = 0;
  const moves = set.moves.map(m => dex.moves.get(m).id);
  if (moves.includes('fakeout')) v += 0.3;
  if (hasMove(set, SPEED_CONTROL)) v += 0.25;
  if (hasMove(set, REDIRECT)) v += 0.2;
  if (dex.abilities.get(set.ability).id === 'intimidate') v += 0.15;
  return v;
}

function subsets(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, acc: number[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < n; i++) rec(i + 1, [...acc, i]);
  };
  rec(0, []);
  return out;
}

/** Usage-weighted odds that each opposing Pokémon is brought (sums to `pick`). */
function bringOdds(theirs: PokemonSet[], pick: number, meta?: MetaSnapshot): number[] {
  const weights = theirs.map(set => {
    const entry = meta && (metaMon(meta, megaForm(set) ?? set.species) ?? metaMon(meta, set.species));
    return 0.5 + (entry?.usage ?? 0.1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map(w => Math.min(1, (w / total) * pick));
}

/**
 * Chooses which Pokémon to bring and lead, from 1-on-1 matchups (damage calcs and Speed) plus the
 * support each Pokémon offers (Fake Out, speed control, redirection, Intimidate).
 */
export function planTeamPreview(
  ours: PokemonSet[],
  theirs: PokemonSet[],
  options: { pick: number; activeCount: number; meta?: MetaSnapshot },
): PreviewPlan {
  const { pick, activeCount, meta } = options;
  const matchups = ours.map(o => theirs.map(t => matchup(o, t)));
  const odds = theirs.length ? bringOdds(theirs, pick, meta) : [];
  const support = ours.map(supportValue);
  const megaHolders = ours.map(s => !!megaForm(s));

  const coverage = (members: number[]) => theirs.reduce((total, _, j) => {
    const scores = members.map(i => matchups[i][j].score).sort((a, b) => b - a);
    return total + odds[j] * (0.65 * (scores[0] ?? -1) + 0.35 * (scores[1] ?? scores[0] ?? -1));
  }, 0);

  let bestBring = subsets(ours.length, Math.min(pick, ours.length))[0];
  let bestBringScore = -Infinity;
  for (const members of subsets(ours.length, Math.min(pick, ours.length))) {
    let score = coverage(members);
    score += 0.5 * Math.max(...members.map(i => support[i]));
    const megas = members.filter(i => megaHolders[i]).length;
    if (megas > 1) score -= 0.25 * (megas - 1);
    if (score > bestBringScore) {
      bestBringScore = score;
      bestBring = members;
    }
  }

  let bestLeads = bestBring.slice(0, activeCount);
  let bestLeadScore = -Infinity;
  for (const leads of subsets(bestBring.length, activeCount).map(idx => idx.map(i => bestBring[i]))) {
    let score = theirs.reduce((total, _, j) => total + odds[j] * Math.max(...leads.map(i => matchups[i][j].score)), 0);
    score += leads.reduce((a, i) => a + support[i], 0);
    const fakeOuts = leads.filter(i => ours[i].moves.some(m => dex.moves.get(m).id === 'fakeout')).length;
    if (fakeOuts > 1) score -= 0.15;
    if (score > bestLeadScore) {
      bestLeadScore = score;
      bestLeads = leads;
    }
  }

  const back = bestBring.filter(i => !bestLeads.includes(i));
  const rest = ours.map((_, i) => i).filter(i => !bestBring.includes(i));
  const order = [...bestLeads, ...back, ...rest];

  const notes: string[] = [];
  theirs.forEach((t, j) => {
    const answers = bestBring
      .map(i => ({ i, m: matchups[i][j] }))
      .sort((a, b) => b.m.score - a.m.score);
    const top = answers[0];
    if (!top) return;
    const name = dex.species.get(t.species).name;
    if (top.m.score < 0) {
      notes.push(`Threat: ${name} — nothing brought wins 1-on-1 (best: ${ours[top.i].species}).`);
    }
  });
  return { order, matchups, theirBringOdds: odds, notes };
}
