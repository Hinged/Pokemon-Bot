import { Dex } from '../ps.js';

/** Pokémon Champions runs on Showdown's `champions` mod: level 50, Stat Points instead of EVs, Megas, no Tera. */
export const dex = Dex.mod('champions');

export const LEVEL = 50;
/** Total Stat Points a Pokémon can hold. */
export const SP_TOTAL = 66;
/** Maximum Stat Points in a single stat. */
export const SP_MAX = 32;
export const TEAM_SIZE = 6;

export interface FormatInfo {
  /** Showdown format id players queue for. */
  id: string;
  name: string;
  /**
   * Format the local simulator runs. The published `pokemon-showdown` package can lag behind the
   * live server by a regulation; battle mechanics are identical within the Champions mod, so we
   * simulate with the newest format the package knows about.
   */
  simFormat: string;
  gameType: 'doubles' | 'singles';
  /** How many of the six are brought to each game. */
  pick: number;
  /** Usage-stats folder name on smogon.com/stats. */
  statsId: string;
}

export const FORMATS: Record<string, FormatInfo> = {
  gen9championsvgc2026regmc: {
    id: 'gen9championsvgc2026regmc',
    name: '[Gen 9 Champions] VGC 2026 Reg M-C',
    simFormat: 'gen9championsvgc2026regmb',
    gameType: 'doubles',
    pick: 4,
    statsId: 'gen9championsvgc2026regmc',
  },
  gen9championsvgc2026regmb: {
    id: 'gen9championsvgc2026regmb',
    name: '[Gen 9 Champions] VGC 2026 Reg M-B',
    simFormat: 'gen9championsvgc2026regmb',
    gameType: 'doubles',
    pick: 4,
    statsId: 'gen9championsvgc2026regmb',
  },
  gen9championsbssregmc: {
    id: 'gen9championsbssregmc',
    name: '[Gen 9 Champions] BSS Reg M-C',
    simFormat: 'gen9championsbssregmb',
    gameType: 'singles',
    pick: 3,
    statsId: 'gen9championsbssregmc',
  },
};

export const DEFAULT_FORMAT = 'gen9championsvgc2026regmc';

export function getFormat(id: string = DEFAULT_FORMAT): FormatInfo {
  const key = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  const format = FORMATS[key];
  if (!format) {
    throw new Error(`Unknown format "${id}". Known formats: ${Object.keys(FORMATS).join(', ')}`);
  }
  return format;
}
