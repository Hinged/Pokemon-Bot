/**
 * Interop shim for the Pokémon Showdown simulator.
 *
 * `pokemon-showdown` is published as CommonJS with getter-based exports, which
 * Node's ESM loader can't see as named exports, so everything is re-exported
 * from here.
 */
import ps from 'pokemon-showdown';
import stateModule from 'pokemon-showdown/dist/sim/state.js';

export const { Battle, Dex, Teams, TeamValidator, PRNG, toID } = ps;
export const State = stateModule.State;

export type Battle = InstanceType<typeof ps.Battle>;
export type SimPokemon = InstanceType<typeof ps.Pokemon>;
export type Side = InstanceType<typeof ps.Side>;
export type ModdedDex = ReturnType<typeof ps.Dex.mod>;
export type PokemonSet = NonNullable<ReturnType<typeof ps.Teams.import>>[number];
export type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type StatsTable = Record<StatID, number>;

export type PRNGSeed = NonNullable<ConstructorParameters<typeof ps.PRNG>[0]>;

/** Seed for Showdown's fast Gen 5 PRNG from four 16-bit numbers. */
export function makeSeed(parts: readonly number[]): PRNGSeed {
  return parts.map(n => Math.floor(Math.abs(n)) & 0xffff).join(',') as PRNGSeed;
}
