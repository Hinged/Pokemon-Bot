import { describe, expect, it } from 'vitest';
import { Battle, makeSeed } from '../src/ps.js';
import { calcStats, defaultSpread, formatSpread, parseSpread, validateSps } from '../src/data/stats.js';
import { getFormat } from '../src/data/format.js';
import { metaTeams } from './helpers.js';

describe('Champions stats', () => {
  it('matches the simulator for real ladder sets', () => {
    const [team] = metaTeams(7);
    const battle = new Battle({ formatid: getFormat().simFormat as never, seed: makeSeed([1, 2, 3, 4]) });
    battle.setPlayer('p1', { name: 'a', team });
    battle.setPlayer('p2', { name: 'b', team });
    for (const pokemon of battle.p1.pokemon) {
      const stats = calcStats(pokemon.set.species, pokemon.set.evs, pokemon.set.nature);
      expect(stats.hp).toBe(pokemon.maxhp);
      for (const stat of ['atk', 'def', 'spa', 'spd', 'spe'] as const) expect(stats[stat]).toBe(pokemon.storedStats[stat]);
    }
  });

  it('computes level-50 stats from Stat Points', () => {
    // Rillaboom: 100 HP / 125 Atk base. HP = base + SP + 75; others = (base + SP + 20) * nature.
    const stats = calcStats('Rillaboom', { hp: 32, atk: 32 }, 'Adamant');
    expect(stats.hp).toBe(207);
    expect(stats.atk).toBe(Math.floor((125 + 32 + 20) * 1.1));
    expect(stats.spa).toBe(Math.floor((60 + 20) * 0.9));
  });

  it('parses and validates spreads', () => {
    const spread = parseSpread('Adamant:32/32/0/0/2/0');
    expect(spread.sps).toEqual({ hp: 32, atk: 32, def: 0, spa: 0, spd: 2, spe: 0 });
    expect(formatSpread(spread)).toBe('Adamant:32/32/0/0/2/0');
    expect(validateSps(spread.sps)).toEqual([]);
    expect(validateSps({ hp: 33 })).toHaveLength(1);
    expect(validateSps({ hp: 32, atk: 32, spe: 32 })).toHaveLength(1);
    const def = defaultSpread('Gholdengo');
    expect(Object.values(def.sps).reduce((a, b) => a + b, 0)).toBe(66);
  });
});
