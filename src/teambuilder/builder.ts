import type { PokemonSet } from '../ps.js';
import { dex, TEAM_SIZE } from '../data/format.js';
import { metaMon, type MetaMon, type MetaSnapshot } from '../data/meta.js';
import { megaForm, setFromMeta } from '../data/sets.js';
import { speedOf } from '../data/damage.js';
import { toId } from '../battle/protocol.js';
import { matchup, type Matchup } from '../ai/teampreview.js';
import { baseSpeciesId } from './sample.js';

export interface BuildOptions {
  meta: MetaSnapshot;
  /** Pokémon that must be on the team (usage-stats names, e.g. `Garchomp-Mega-Z`). */
  core?: string[];
  exclude?: string[];
  /** Candidates drawn from the most used Pokémon. */
  poolSize?: number;
  /** Meta threats the team is scored against. */
  threatCount?: number;
  maxMegas?: number;
  beamWidth?: number;
  results?: number;
}

export interface ThreatAnswer {
  threat: string;
  usage: number;
  /** Our best 1-on-1 answer and how well it does (-1..1). */
  answer: string;
  score: number;
}

export interface TeamReport {
  team: PokemonSet[];
  members: string[];
  score: number;
  breakdown: { coverage: number; roles: number; synergy: number; weaknesses: number };
  threats: ThreatAnswer[];
  /** Attacking types that hit three or more members super-effectively. */
  sharedWeaknesses: string[];
  roles: string[];
  speedTiers: { species: string; speed: number }[];
}

interface Candidate {
  mon: MetaMon;
  set: PokemonSet;
  base: string;
  mega: boolean;
}

const SPEED_CONTROL = ['tailwind', 'trickroom'];
const SOFT_SPEED_CONTROL = ['icywind', 'electroweb', 'thunderwave', 'bulldoze', 'scaryface'];
const REDIRECT = ['followme', 'ragepowder'];

function moveIds(set: PokemonSet): string[] {
  return set.moves.map(m => dex.moves.get(m).id);
}

function resolveName(meta: MetaSnapshot, name: string): string {
  const entry = metaMon(meta, name);
  if (entry) return entry.species;
  // Accept the pre-Mega name with its stone implied, e.g. "Salamence" -> "Salamence-Mega".
  const mega = meta.mons.find(m => dex.species.get(m.species).isMega && baseSpeciesId(m.species) === baseSpeciesId(name));
  if (mega) return mega.species;
  throw new Error(`${name} has no usage data in ${meta.format}`);
}

function rolesOf(team: PokemonSet[]): string[] {
  const roles = new Set<string>();
  for (const set of team) {
    const moves = moveIds(set);
    if (moves.includes('fakeout')) roles.add('Fake Out');
    if (moves.includes('tailwind')) roles.add('Tailwind');
    if (moves.includes('trickroom')) roles.add('Trick Room');
    if (moves.some(m => SOFT_SPEED_CONTROL.includes(m))) roles.add('Speed drops');
    if (moves.some(m => REDIRECT.includes(m))) roles.add('Redirection');
    if (toId(set.ability) === 'intimidate') roles.add('Intimidate');
    if (megaForm(set)) roles.add('Mega');
    if (moves.includes('wideguard')) roles.add('Wide Guard');
    if (['drizzle', 'drought', 'sandstream', 'snowwarning'].includes(toId(set.ability))) roles.add('Weather');
  }
  return [...roles];
}

function roleScore(team: PokemonSet[]): number {
  const all = team.flatMap(moveIds);
  let score = 0;
  if (all.includes('fakeout')) score += 0.15;
  if (all.some(m => SPEED_CONTROL.includes(m))) score += 0.25;
  else if (all.some(m => SOFT_SPEED_CONTROL.includes(m))) score += 0.1;
  if (all.some(m => REDIRECT.includes(m))) score += 0.08;
  if (team.some(s => toId(s.ability) === 'intimidate')) score += 0.1;
  const protects = team.filter(s => moveIds(s).some(m => ['protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'silktrap'].includes(m))).length;
  score += 0.03 * Math.min(protects, 4);
  return score;
}

function weaknessCount(team: PokemonSet[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of dex.types.names()) {
    if (type === 'Stellar') continue;
    let weak = 0;
    for (const set of team) {
      const species = dex.species.get(megaForm(set) ?? set.species);
      if (!dex.getImmunity(type, species.types)) continue;
      if (dex.getEffectiveness(type, species.types) > 0) weak++;
    }
    counts[type] = weak;
  }
  return counts;
}

function weaknessPenalty(team: PokemonSet[]): number {
  return Object.values(weaknessCount(team)).reduce((a, n) => a + (n >= 3 ? 0.12 * (n - 2) : 0), 0);
}

/**
 * Searches for teams that answer the most-used threats while covering VGC roles, using beam search
 * over usage-stats sets and calc-based 1-on-1 matchups.
 */
export function buildTeams(options: BuildOptions): TeamReport[] {
  const { meta } = options;
  const poolSize = options.poolSize ?? 60;
  const maxMegas = options.maxMegas ?? 2;
  const beamWidth = options.beamWidth ?? 40;
  const exclude = new Set((options.exclude ?? []).map(baseSpeciesId));
  const core = (options.core ?? []).map(n => resolveName(meta, n));

  const poolMons = meta.mons.slice(0, poolSize).filter(m => !exclude.has(baseSpeciesId(m.species)));
  for (const name of core) if (!poolMons.some(m => m.species === name)) poolMons.push(metaMon(meta, name)!);
  const candidates: Candidate[] = poolMons.map(mon => {
    const set = setFromMeta(meta, mon.species);
    return { mon, set, base: baseSpeciesId(mon.species), mega: !!megaForm(set) };
  });

  const threatMons = meta.mons.slice(0, options.threatCount ?? 30);
  const threatSets = threatMons.map(m => setFromMeta(meta, m.species));
  const totalUsage = threatMons.reduce((a, m) => a + m.usage, 0);
  const threatWeight = threatMons.map(m => m.usage / totalUsage);
  const matrix: Matchup[][] = candidates.map(c => threatSets.map(t => matchup(c.set, t)));
  const index = new Map(candidates.map((c, i) => [c.mon.species, i]));

  const synergy = (members: number[]) => {
    let s = 0;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const ma = candidates[members[a]].mon;
        const mb = candidates[members[b]].mon;
        const together = ma.teammates.find(([n]) => n === mb.species)?.[1] ?? 0;
        // Co-occurrence lift over chance, on a log scale and capped.
        if (together > 0) s += Math.max(-0.5, Math.min(1, Math.log(together / Math.max(mb.usage, 0.01))));
      }
    }
    return s;
  };

  const evaluateTeam = (members: number[]) => {
    const sets = members.map(i => candidates[i].set);
    const coverage = threatWeight.reduce((total, w, t) => {
      const scores = members.map(i => matrix[i][t].score).sort((a, b) => b - a);
      return total + w * (0.6 * (scores[0] ?? -1) + 0.4 * (scores[1] ?? -1));
    }, 0);
    const roles = roleScore(sets);
    const syn = 0.04 * synergy(members);
    const weak = weaknessPenalty(sets);
    return { score: coverage + roles + syn - weak, coverage, roles, synergy: syn, weaknesses: weak };
  };

  const valid = (members: number[], next: number) => {
    const c = candidates[next];
    if (members.includes(next)) return false;
    if (members.some(i => candidates[i].base === c.base)) return false;
    if (c.mega && members.filter(i => candidates[i].mega).length >= maxMegas) return false;
    return true;
  };

  let beam: number[][] = [[]];
  for (const name of core) {
    const i = index.get(name)!;
    beam = beam.map(m => (valid(m, i) ? [...m, i] : m));
  }
  while (beam[0].length < TEAM_SIZE) {
    const seen = new Set<string>();
    const expanded: { members: number[]; score: number }[] = [];
    for (const members of beam) {
      for (let i = 0; i < candidates.length; i++) {
        if (!valid(members, i)) continue;
        const next = [...members, i].sort((a, b) => a - b);
        const key = next.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        expanded.push({ members: next, score: evaluateTeam(next).score });
      }
    }
    if (!expanded.length) break;
    expanded.sort((a, b) => b.score - a.score);
    beam = expanded.slice(0, beamWidth).map(e => e.members);
  }

  // Return distinct teams (at least two members different from every earlier pick).
  const picked: number[][] = [];
  for (const members of beam) {
    if (picked.every(p => members.filter(i => !p.includes(i)).length >= 2)) picked.push(members);
    if (picked.length >= (options.results ?? 3)) break;
  }

  return picked.map(members => {
    const breakdown = evaluateTeam(members);
    // Re-derive sets in order with Item Clause respected.
    const usedItems = new Set<string>();
    const team = members.map(i => {
      const set = setFromMeta(meta, candidates[i].mon.species, { excludeItems: usedItems });
      if (set.item) usedItems.add(toId(set.item));
      return set;
    });
    const threats = threatMons.map((m, t) => {
      const best = members.map(i => ({ i, s: matrix[i][t].score })).sort((a, b) => b.s - a.s)[0];
      return { threat: m.species, usage: m.usage, answer: candidates[best.i].mon.species, score: +best.s.toFixed(2) };
    });
    const weak = weaknessCount(team);
    return {
      team,
      members: members.map(i => candidates[i].mon.species),
      score: +breakdown.score.toFixed(3),
      breakdown: {
        coverage: +breakdown.coverage.toFixed(3), roles: +breakdown.roles.toFixed(3),
        synergy: +breakdown.synergy.toFixed(3), weaknesses: +breakdown.weaknesses.toFixed(3),
      },
      threats,
      sharedWeaknesses: Object.entries(weak).filter(([, n]) => n >= 3).map(([t, n]) => `${t} (${n})`),
      roles: rolesOf(team),
      speedTiers: team.map(set => ({ species: megaForm(set) ?? set.species, speed: speedOf({ set, mega: !!megaForm(set) }) }))
        .sort((a, b) => b.speed - a.speed),
    };
  });
}
