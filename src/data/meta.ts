import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FORMAT, dex, getFormat } from './format.js';

/** A weighted option from usage stats: [id or name, fraction of sets that use it]. */
export type Weighted = [string, number];

export interface MetaMon {
  species: string;
  /** Fraction of teams that include this Pokémon. */
  usage: number;
  abilities: Weighted[];
  items: Weighted[];
  moves: Weighted[];
  /** Spreads in `Nature:hp/atk/def/spa/spd/spe` Stat Point form. */
  spreads: Weighted[];
  teammates: Weighted[];
}

export interface MetaSnapshot {
  format: string;
  month: string;
  cutoff: number;
  battles: number;
  mons: MetaMon[];
}

interface ChaosMon {
  usage: number;
  Abilities: Record<string, number>;
  Items: Record<string, number>;
  Moves: Record<string, number>;
  Spreads: Record<string, number>;
  Teammates: Record<string, number>;
}

interface ChaosStats {
  info: { metagame: string; cutoff: number; 'number of battles': number };
  data: Record<string, ChaosMon>;
}

export interface FromChaosOptions {
  month: string;
  /** Keep Pokémon with at least this usage fraction. */
  minUsage?: number;
  maxMons?: number;
}

function top(entries: Record<string, number>, total: number, limit: number, minFrac = 0.005): Weighted[] {
  return Object.entries(entries)
    .filter(([key]) => key !== '' && key !== 'nothing')
    .map(([key, w]): Weighted => [key, Math.round((w / total) * 10000) / 10000])
    .filter(([, frac]) => frac >= minFrac)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

/** Converts a Smogon "chaos" usage JSON into a compact snapshot. */
export function fromChaos(chaos: ChaosStats, options: FromChaosOptions): MetaSnapshot {
  const minUsage = options.minUsage ?? 0.002;
  const maxMons = options.maxMons ?? 150;
  const mons: MetaMon[] = [];
  for (const [species, m] of Object.entries(chaos.data)) {
    if (m.usage < minUsage) continue;
    if (!dex.species.get(species).exists) continue;
    const total = Object.values(m.Abilities).reduce((a, b) => a + b, 0) || 1;
    mons.push({
      species,
      usage: Math.round(m.usage * 10000) / 10000,
      abilities: top(m.Abilities, total, 3),
      items: top(m.Items, total, 6),
      moves: top(m.Moves, total, 12, 0.01),
      spreads: top(m.Spreads, total, 6, 0.01),
      teammates: top(m.Teammates, total, 15, 0.02),
    });
  }
  mons.sort((a, b) => b.usage - a.usage);
  return {
    format: chaos.info.metagame,
    month: options.month,
    cutoff: chaos.info.cutoff,
    battles: chaos.info['number of battles'],
    mons: mons.slice(0, maxMons),
  };
}

/** Downloads usage stats from smogon.com/stats and converts them to a snapshot. */
export async function fetchMeta(formatId: string, month: string, cutoff = 1630): Promise<MetaSnapshot> {
  const format = getFormat(formatId);
  const url = `https://www.smogon.com/stats/${month}/chaos/${format.statsId}-${cutoff}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  const chaos = (await res.json()) as ChaosStats;
  return fromChaos(chaos, { month });
}

const here = dirname(fileURLToPath(import.meta.url));
export const META_DIR = join(here, '..', '..', 'data', 'meta');

const cache = new Map<string, MetaSnapshot>();

/** Loads the bundled usage snapshot for a format (see `champ meta update`). */
export function loadMeta(formatId: string = DEFAULT_FORMAT): MetaSnapshot {
  const format = getFormat(formatId);
  const cached = cache.get(format.id);
  if (cached) return cached;
  const file = join(META_DIR, `${format.statsId}.json`);
  if (!existsSync(file)) {
    throw new Error(`No usage snapshot for ${format.id} at ${file}. Run: npm run champ -- meta update --format ${format.id}`);
  }
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as MetaSnapshot;
  cache.set(format.id, snapshot);
  return snapshot;
}

export function metaMon(meta: MetaSnapshot, species: string): MetaMon | undefined {
  const id = dex.species.get(species).id;
  return meta.mons.find(m => dex.species.get(m.species).id === id);
}
