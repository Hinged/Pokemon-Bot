import {
  calculate,
  Generations,
  Field as CalcField,
  Move as CalcMove,
  Pokemon as CalcPokemon,
} from '@smogon/calc';
import type { PokemonSet } from '../ps.js';
import { dex } from './format.js';
import { megaForm } from './sets.js';

/** @smogon/calc models Champions as generation 0. */
export const calcGen = Generations.get(0 as Parameters<typeof Generations.get>[0]);

type CalcWeather = 'Sun' | 'Rain' | 'Sand' | 'Snow' | 'Harsh Sunshine' | 'Heavy Rain' | 'Strong Winds';
type CalcTerrain = 'Electric' | 'Grassy' | 'Psychic' | 'Misty';

const WEATHER: Record<string, CalcWeather> = {
  sunnyday: 'Sun', raindance: 'Rain', sandstorm: 'Sand', snowscape: 'Snow', snow: 'Snow',
  desolateland: 'Harsh Sunshine', primordialsea: 'Heavy Rain', deltastream: 'Strong Winds',
};
const TERRAIN: Record<string, CalcTerrain> = {
  electricterrain: 'Electric', grassyterrain: 'Grassy', psychicterrain: 'Psychic', mistyterrain: 'Misty',
};

export interface Combatant {
  set: PokemonSet;
  /** Use the Mega form (if the set holds its Mega Stone). */
  mega?: boolean;
  boosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  /** Current HP as a fraction of max (defaults to full). */
  hpFraction?: number;
  status?: '' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
}

export interface FieldOptions {
  doubles?: boolean;
  /** Showdown weather id, e.g. `sunnyday`. */
  weather?: string;
  /** Showdown terrain id, e.g. `grassyterrain`. */
  terrain?: string;
  defenderReflect?: boolean;
  defenderLightScreen?: boolean;
  defenderAuroraVeil?: boolean;
  helpingHand?: boolean;
  defenderFriendGuard?: boolean;
}

export interface DamageResult {
  move: string;
  min: number;
  max: number;
  /** Damage as a percentage of the defender's max HP. */
  minPct: number;
  maxPct: number;
  avgPct: number;
  defenderHp: number;
  desc: string;
}

export function activeSpecies(c: Combatant): string {
  return (c.mega && megaForm(c.set)) || c.set.species;
}

function activeAbility(c: Combatant): string {
  const form = c.mega ? megaForm(c.set) : null;
  return form ? dex.species.get(form).abilities['0'] : c.set.ability;
}

export function toCalcPokemon(c: Combatant): CalcPokemon {
  const species = activeSpecies(c);
  const pokemon = new CalcPokemon(calcGen, species, {
    item: c.set.item || undefined,
    ability: activeAbility(c),
    nature: c.set.nature || 'Hardy',
    evs: { ...c.set.evs },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    level: 50,
    boosts: c.boosts,
    status: c.status || '',
  });
  if (c.hpFraction !== undefined && c.hpFraction < 1) {
    pokemon.originalCurHP = Math.max(1, Math.round(pokemon.maxHP() * c.hpFraction));
  }
  return pokemon;
}

export function toCalcField(options: FieldOptions = {}): CalcField {
  return new CalcField({
    gameType: options.doubles === false ? 'Singles' : 'Doubles',
    weather: options.weather ? WEATHER[options.weather] : undefined,
    terrain: options.terrain ? TERRAIN[options.terrain] : undefined,
    attackerSide: { isHelpingHand: options.helpingHand },
    defenderSide: {
      isReflect: options.defenderReflect,
      isLightScreen: options.defenderLightScreen,
      isAuroraVeil: options.defenderAuroraVeil,
      isFriendGuard: options.defenderFriendGuard,
    },
  });
}

/** Damage of one move. Status moves and immunities return zeros. */
export function calcDamage(
  attacker: Combatant | CalcPokemon,
  defender: Combatant | CalcPokemon,
  moveName: string,
  field?: FieldOptions | CalcField,
): DamageResult {
  const att = attacker instanceof CalcPokemon ? attacker : toCalcPokemon(attacker);
  const def = defender instanceof CalcPokemon ? defender : toCalcPokemon(defender);
  const fld = field instanceof CalcField ? field : toCalcField(field);
  const move = new CalcMove(calcGen, moveName, { ability: att.ability, item: att.item, species: att.name });
  const defenderHp = def.maxHP();
  const empty: DamageResult = { move: move.name, min: 0, max: 0, minPct: 0, maxPct: 0, avgPct: 0, defenderHp, desc: '' };
  if (move.category === 'Status') return empty;
  let result;
  try {
    result = calculate(calcGen, att, def, move, fld);
  } catch {
    return empty;
  }
  const [min, max] = result.range();
  if (!max) return empty;
  let desc = '';
  try {
    desc = result.desc();
  } catch {
    desc = `${move.name}: ${min}-${max}`;
  }
  const pct = (n: number) => Math.round((1000 * n) / defenderHp) / 10;
  return { move: move.name, min, max, minPct: pct(min), maxPct: pct(max), avgPct: pct((min + max) / 2), defenderHp, desc };
}

/** Best damaging move from a set against a defender, by average roll. */
export function bestMove(
  attacker: Combatant,
  defender: Combatant,
  field?: FieldOptions,
): DamageResult | null {
  const att = toCalcPokemon(attacker);
  const def = toCalcPokemon(defender);
  const fld = toCalcField(field);
  let best: DamageResult | null = null;
  for (const move of attacker.set.moves) {
    const r = calcDamage(att, def, move, fld);
    if (r.max > 0 && (!best || r.avgPct > best.avgPct)) best = r;
  }
  return best;
}

export function speedOf(c: Combatant): number {
  return toCalcPokemon(c).stats.spe;
}
