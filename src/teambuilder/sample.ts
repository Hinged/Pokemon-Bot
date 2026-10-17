import type { PokemonSet } from '../ps.js';
import { dex, TEAM_SIZE } from '../data/format.js';
import type { MetaMon, MetaSnapshot } from '../data/meta.js';
import { setFromMeta } from '../data/sets.js';
import { toId } from '../battle/protocol.js';

export function baseSpeciesId(species: string): string {
  return dex.species.get(species).baseSpecies.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function teammateFrac(mon: MetaMon, other: string): number {
  return mon.teammates.find(([name]) => name === other)?.[1] ?? 0;
}

export interface SampleOptions {
  /** Only draw from the most used Pokémon. */
  top?: number;
  /** Most teams run one or two Mega Stones. */
  maxMegas?: number;
  /** Sample items/moves/spreads by usage instead of always taking the most common. */
  varySets?: boolean;
}

/**
 * Draws a plausible ladder team: the first Pokémon by usage, then teammates weighted by usage and
 * how often they appear alongside what's already on the team.
 */
export function sampleMetaTeam(meta: MetaSnapshot, rng: () => number, options: SampleOptions = {}): PokemonSet[] {
  const pool = meta.mons.slice(0, options.top ?? 60);
  const maxMegas = options.maxMegas ?? 2;
  const chosen: MetaMon[] = [];
  const bases = new Set<string>();
  let megas = 0;

  while (chosen.length < TEAM_SIZE) {
    const candidates = pool.filter(m => {
      if (bases.has(baseSpeciesId(m.species))) return false;
      if (dex.species.get(m.species).isMega && megas >= maxMegas) return false;
      return true;
    });
    if (!candidates.length) break;
    const weights = candidates.map(c => {
      const synergy = chosen.reduce((acc, s) => acc + teammateFrac(s, c.species), 0);
      return c.usage * (chosen.length ? 0.2 + 3 * synergy : 1);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    let pick = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        pick = candidates[i];
        break;
      }
    }
    chosen.push(pick);
    bases.add(baseSpeciesId(pick.species));
    if (dex.species.get(pick.species).isMega) megas++;
  }

  const usedItems = new Set<string>();
  return chosen.map(mon => {
    const set = setFromMeta(meta, mon.species, { excludeItems: usedItems, rand: options.varySets ? rng : undefined });
    if (set.item) usedItems.add(toId(set.item));
    return set;
  });
}
