import type { StatID, StatsTable } from '../ps.js';
import { dex, SP_MAX, SP_TOTAL } from './format.js';

export const STAT_IDS: StatID[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const STAT_NAMES: Record<StatID, string> = {
  hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe',
};

export function emptyStats(fill = 0): StatsTable {
  return { hp: fill, atk: fill, def: fill, spa: fill, spd: fill, spe: fill };
}

/**
 * Champions stat formula at level 50 with IVs fixed at 31. Each Stat Point adds exactly one point
 * to the stat before the nature multiplier (equivalent to 8 EVs in the main series).
 */
export function calcStat(stat: StatID, base: number, sp: number, nature?: string): number {
  if (stat === 'hp') return base + sp + 75;
  let value = base + sp + 20;
  const n = nature ? dex.natures.get(nature) : undefined;
  if (n?.plus === stat) value = Math.floor((value * 110) / 100);
  else if (n?.minus === stat) value = Math.floor((value * 90) / 100);
  return value;
}

export function calcStats(species: string, sps: Partial<StatsTable>, nature?: string): StatsTable {
  const s = dex.species.get(species);
  if (!s.exists) throw new Error(`Unknown species: ${species}`);
  const out = emptyStats();
  for (const stat of STAT_IDS) out[stat] = calcStat(stat, s.baseStats[stat], sps[stat] ?? 0, nature);
  return out;
}

export interface Spread {
  nature: string;
  sps: StatsTable;
}

/** Parses Smogon usage-stats spreads, e.g. `Adamant:32/32/0/0/2/0`. */
export function parseSpread(text: string): Spread {
  const [nature, values] = text.split(':');
  const nums = (values ?? '').split('/').map(Number);
  if (nums.length !== 6 || nums.some(n => !Number.isFinite(n))) throw new Error(`Bad spread: ${text}`);
  const sps = emptyStats();
  STAT_IDS.forEach((stat, i) => (sps[stat] = nums[i]));
  return { nature, sps };
}

export function formatSpread(spread: Spread): string {
  return `${spread.nature}:${STAT_IDS.map(s => spread.sps[s]).join('/')}`;
}

/** Showdown export line, e.g. `EVs: 32 HP / 32 Atk / 2 Spe` (Champions reuses the EVs field for SPs). */
export function formatSpLine(sps: Partial<StatsTable>): string {
  const parts = STAT_IDS.filter(s => (sps[s] ?? 0) > 0).map(s => `${sps[s]} ${STAT_NAMES[s]}`);
  return parts.length ? `EVs: ${parts.join(' / ')}` : '';
}

export function validateSps(sps: Partial<StatsTable>): string[] {
  const problems: string[] = [];
  let total = 0;
  for (const stat of STAT_IDS) {
    const v = sps[stat] ?? 0;
    if (!Number.isInteger(v) || v < 0) problems.push(`${STAT_NAMES[stat]} Stat Points must be a non-negative integer`);
    if (v > SP_MAX) problems.push(`${STAT_NAMES[stat]} has ${v} Stat Points (max ${SP_MAX})`);
    total += v;
  }
  if (total > SP_TOTAL) problems.push(`Total Stat Points ${total} exceed ${SP_TOTAL}`);
  return problems;
}

/**
 * A reasonable spread when nothing better is known: max the better attacking stat and Speed,
 * leftovers into HP, with a boosting nature.
 */
export function defaultSpread(species: string): Spread {
  const s = dex.species.get(species);
  const physical = s.baseStats.atk >= s.baseStats.spa;
  const sps = emptyStats();
  sps[physical ? 'atk' : 'spa'] = SP_MAX;
  sps.spe = SP_MAX;
  sps.hp = SP_TOTAL - 2 * SP_MAX;
  return { nature: physical ? 'Jolly' : 'Timid', sps };
}
