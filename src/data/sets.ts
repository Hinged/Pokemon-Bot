import { Teams, toID, type PokemonSet } from '../ps.js';
import { dex, LEVEL } from './format.js';
import { metaMon, type MetaSnapshot, type Weighted } from './meta.js';
import { defaultSpread, emptyStats, parseSpread, type Spread } from './stats.js';

export type { PokemonSet };

/** Pre-Mega species to put on the team sheet for a usage-stats entry such as `Salamence-Mega`. */
export function teamSpecies(species: string): string {
  const s = dex.species.get(species);
  if (s.isMega && typeof s.battleOnly === 'string') return s.battleOnly;
  return s.name;
}

/** The Mega form a set turns into, if it holds the matching stone. */
export function megaForm(set: Pick<PokemonSet, 'species' | 'item'>): string | null {
  const item = dex.items.get(set.item);
  if (!item.megaStone) return null;
  const species = dex.species.get(set.species);
  return (item.megaStone as Record<string, string>)[species.name] ?? null;
}

function bestAbility(species: string, meta?: MetaSnapshot): string {
  const fromMeta = meta && metaMon(meta, species)?.abilities[0]?.[0];
  if (fromMeta) return dex.abilities.get(fromMeta).name;
  const s = dex.species.get(species);
  const options = Object.values(s.abilities).map(a => dex.abilities.get(a));
  options.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return options[0]?.name ?? '';
}

function weightedSample<T>(options: [T, number][], rand: () => number): T | undefined {
  const total = options.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return options[0]?.[0];
  let r = rand() * total;
  for (const [value, w] of options) {
    r -= w;
    if (r <= 0) return value;
  }
  return options[options.length - 1]?.[0];
}

export interface SetOptions {
  /** Item ids already used on the team (Item Clause). */
  excludeItems?: Set<string>;
  /** When provided, items, moves and spreads are sampled by usage instead of taking the most common. */
  rand?: () => number;
}

function pickMoves(moves: Weighted[], rand?: () => number): string[] {
  const legal = moves.filter(([id]) => dex.moves.get(id).exists);
  if (!rand) return legal.slice(0, 4).map(([id]) => dex.moves.get(id).name);
  const pool = legal.map(([id, w]): [string, number] => [id, w]);
  const chosen: string[] = [];
  while (chosen.length < 4 && pool.length) {
    const pick = weightedSample(pool, rand)!;
    chosen.push(dex.moves.get(pick).name);
    pool.splice(pool.findIndex(([id]) => id === pick), 1);
  }
  return chosen;
}

/** Builds the most likely (or a usage-weighted random) set for a meta Pokémon. */
export function setFromMeta(meta: MetaSnapshot, species: string, options: SetOptions = {}): PokemonSet {
  const entry = metaMon(meta, species);
  if (!entry) throw new Error(`${species} has no usage data in ${meta.format}`);
  const s = dex.species.get(entry.species);
  const exclude = options.excludeItems ?? new Set<string>();
  const baseSpecies = teamSpecies(s.name);

  let item: string;
  if (s.isMega && s.requiredItem) {
    item = s.requiredItem;
  } else {
    const items = entry.items.filter(([id]) => !exclude.has(id) && dex.items.get(id).exists);
    const picked = options.rand ? weightedSample(items, options.rand) : items[0]?.[0];
    item = picked ? dex.items.get(picked).name : '';
  }

  const ability = s.isMega ? bestAbility(baseSpecies, meta) : bestAbility(s.name, meta);
  const spreadText = options.rand ? weightedSample(entry.spreads, options.rand) : entry.spreads[0]?.[0];
  const spread: Spread = spreadText ? parseSpread(spreadText) : defaultSpread(s.name);

  return {
    name: '',
    species: baseSpecies,
    item,
    ability,
    moves: pickMoves(entry.moves, options.rand),
    nature: spread.nature,
    evs: { ...spread.sps },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    level: LEVEL,
    gender: '',
  } as PokemonSet;
}

/**
 * Most common spread for a set given what the team sheet shows (nature is public in Champions).
 * Megas are listed under their Mega form in usage stats, so that entry is tried first.
 */
export function likelySpread(meta: MetaSnapshot | undefined, set: Pick<PokemonSet, 'species' | 'item'>, nature?: string): Spread {
  const keys = [megaForm(set), set.species].filter((k): k is string => !!k);
  for (const key of keys) {
    const entry = meta && metaMon(meta, key);
    if (!entry) continue;
    const spreads = entry.spreads.map(([text]) => parseSpread(text));
    const match = nature ? spreads.find(sp => toID(sp.nature) === toID(nature)) : spreads[0];
    if (match) return match;
  }
  const fallback = defaultSpread(megaForm(set) ?? set.species);
  return nature ? { ...fallback, nature } : fallback;
}

/** Fills hidden Stat Points on a team-sheet set using usage data. */
export function completeSet(set: PokemonSet, meta?: MetaSnapshot): PokemonSet {
  const hasSps = set.evs && (Object.values(set.evs) as number[]).some(v => v > 0);
  if (hasSps) return { ...set, level: LEVEL };
  const spread = likelySpread(meta, set, set.nature || undefined);
  return {
    ...set,
    nature: set.nature || spread.nature,
    evs: { ...spread.sps },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    level: LEVEL,
  };
}

export function parseTeam(text: string): PokemonSet[] {
  const team = Teams.import(text.trim());
  if (!team || !team.length) throw new Error('Could not parse team');
  return team.map(set => ({
    ...set,
    level: LEVEL,
    evs: set.evs ?? emptyStats(),
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  }));
}

export function exportTeam(team: PokemonSet[]): string {
  // IVs and level are fixed in Champions; leave them out of the export.
  const clean = team.map(set => ({ ...set, ivs: undefined, level: undefined }) as unknown as PokemonSet);
  return Teams.export(clean).trim();
}

export function packTeam(team: PokemonSet[]): string {
  return Teams.pack(team);
}

/** What Open Team Sheets reveal: everything except Stat Points. */
export function teamSheet(team: PokemonSet[]): PokemonSet[] {
  return team.map(set => ({ ...set, evs: emptyStats(), ivs: emptyStats(31) }));
}
