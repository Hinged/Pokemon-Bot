import { Battle, makeSeed, State, toID, type PokemonSet, type PRNGSeed, type SimPokemon } from '../ps.js';
import { dex, type FormatInfo } from '../data/format.js';
import { metaMon, type MetaSnapshot } from '../data/meta.js';
import { completeSet, megaForm, setFromMeta, teamSpecies } from '../data/sets.js';
import { defaultSpread } from '../data/stats.js';
import { opponentOf } from '../ai/agent.js';
import { parseIdent, type BattleRequest, type SideID } from './protocol.js';
import type { BattleTracker, TimedEffect, TrackedPokemon, TrackedSide } from './tracker.js';

type SimBattle = InstanceType<typeof Battle>;

/** Typical durations (turns) used to estimate how long a field effect has left. */
const DURATIONS: Record<string, number> = {
  tailwind: 4, reflect: 5, lightscreen: 5, auroraveil: 5, safeguard: 5, mist: 5,
  trickroom: 5, gravity: 5, magicroom: 5, wonderroom: 5,
  sunnyday: 5, raindance: 5, sandstorm: 5, snowscape: 5, snow: 5,
  electricterrain: 5, grassyterrain: 5, psychicterrain: 5, mistyterrain: 5,
  taunt: 3, encore: 3, yawn: 2, throatchop: 2, healblock: 5, disable: 4, magnetrise: 5, saltcure: 99,
};
const EXTENDERS: Record<string, string> = {
  reflect: 'lightclay', lightscreen: 'lightclay', auroraveil: 'lightclay',
  sunnyday: 'heatrock', raindance: 'damprock', sandstorm: 'smoothrock', snowscape: 'icyrock', snow: 'icyrock',
  electricterrain: 'terrainextender', grassyterrain: 'terrainextender',
  psychicterrain: 'terrainextender', mistyterrain: 'terrainextender',
};
/** Volatiles we can recreate faithfully from the protocol. */
const VOLATILES = new Set([
  'confusion', 'taunt', 'encore', 'leechseed', 'yawn', 'substitute', 'focusenergy', 'saltcure', 'throatchop',
  'healblock', 'disable', 'torment', 'magnetrise', 'aquaring', 'ingrain', 'charge', 'stockpile', 'perish3',
  'perish2', 'perish1', 'perish0', 'protosynthesis', 'quarkdrive', 'flashfire', 'unburden', 'twoturnmove',
  'mustrecharge',
]);

export interface Belief {
  battle: SimBattle;
  /** Serialized battle for fast cloning. */
  snapshot: string;
  ourSide: SideID;
  foeSide: SideID;
}

/** Turns left on an effect at the start of `turn`; `effect.turn` is its first countdown turn. */
function remaining(effect: TimedEffect, turn: number, holderItem?: string | null): number {
  let total = DURATIONS[effect.id] ?? 5;
  const extender = EXTENDERS[effect.id];
  if (extender && holderItem === extender) total += 3;
  return Math.max(1, total - Math.max(0, turn - effect.turn));
}

/** The opponent's set for a tracked Pokémon, filling hidden details from usage data. */
export function opponentSet(mon: TrackedPokemon, meta?: MetaSnapshot): PokemonSet {
  let set: PokemonSet;
  if (mon.set) {
    set = completeSet(mon.set, meta);
  } else {
    const key = mon.megaEvolved ? mon.species : teamSpecies(mon.baseSpecies);
    const entry = meta && (metaMon(meta, key) ?? metaMon(meta, mon.baseSpecies));
    if (meta && entry) {
      set = setFromMeta(meta, entry.species);
    } else {
      const spread = defaultSpread(mon.baseSpecies);
      const species = dex.species.get(mon.baseSpecies);
      set = {
        name: '', species: species.name, item: '', ability: species.abilities['0'], moves: [],
        nature: spread.nature, evs: spread.sps, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        level: 50, gender: '',
      } as PokemonSet;
    }
    // What we've seen beats what usage stats suggest.
    const seen = mon.moves.map(id => dex.moves.get(id).name);
    const rest = set.moves.filter(m => !seen.includes(m));
    set = { ...set, moves: [...seen, ...rest].slice(0, 4) };
    if (mon.item) set.item = dex.items.get(mon.item).name;
    if (mon.ability) set.ability = dex.abilities.get(mon.ability).name;
  }
  if (!set.moves.length) set = { ...set, moves: ['Struggle'] };
  return { ...set, name: mon.name || set.name };
}

function usageOf(mon: TrackedPokemon, meta?: MetaSnapshot): number {
  if (!meta) return 0;
  const key = mon.set ? megaForm(mon.set) ?? mon.baseSpecies : mon.baseSpecies;
  return (metaMon(meta, key) ?? metaMon(meta, mon.baseSpecies))?.usage ?? 0;
}

/**
 * Picks which of the opponent's Pokémon to put in the belief: actives first, then the rest of what
 * they've revealed, then the likeliest unrevealed picks until the bring size is reached.
 */
function opponentLineup(side: TrackedSide, pick: number, meta?: MetaSnapshot): TrackedPokemon[] {
  const lineup: TrackedPokemon[] = [];
  for (const mon of side.active) if (mon && !lineup.includes(mon)) lineup.push(mon);
  for (const mon of side.team) if (mon.revealed && !lineup.includes(mon)) lineup.push(mon);
  const unrevealed = side.team.filter(m => !lineup.includes(m))
    .sort((a, b) => usageOf(b, meta) - usageOf(a, meta));
  for (const mon of unrevealed) {
    if (lineup.length >= pick) break;
    lineup.push(mon);
  }
  return lineup;
}

function setStatus(battle: SimBattle, pokemon: SimPokemon, mon: TrackedPokemon): void {
  if (!mon.status || mon.fainted) return;
  pokemon.status = mon.status as never;
  pokemon.statusState = battle.initEffectState({ id: mon.status, target: pokemon });
  if (mon.status === 'slp') {
    pokemon.statusState.startTime = 3;
    pokemon.statusState.time = Math.max(1, 3 - mon.sleepTurns);
  } else if (mon.status === 'frz') {
    pokemon.statusState.startTime = 3;
    pokemon.statusState.time = 3;
  } else if (mon.status === 'tox') {
    pokemon.statusState.stage = mon.toxicTurns;
  }
}

function setVolatile(battle: SimBattle, pokemon: SimPokemon, id: string, extra: Record<string, unknown> = {}): void {
  const condition = battle.dex.conditions.get(id);
  // Two-turn moves use their own id as a bare marker volatile even without a condition entry.
  if (!condition.exists && !battle.dex.moves.get(id).exists) return;
  const effectId = condition.exists ? condition.id : toID(id);
  pokemon.volatiles[effectId] = battle.initEffectState({
    id: effectId, name: condition.exists ? condition.name : battle.dex.moves.get(id).name, target: pokemon,
    source: pokemon, sourceSlot: pokemon.getSlot(), ...extra,
  });
}

function applyVolatiles(battle: SimBattle, pokemon: SimPokemon, mon: TrackedPokemon, turn: number, foes: SimPokemon[]): void {
  pokemon.volatiles = {};
  for (const [rawId, info] of Object.entries(mon.volatiles)) {
    if (!VOLATILES.has(rawId)) continue;
    const effect: TimedEffect = { id: rawId, turn: info.turn };
    if (rawId.startsWith('perish')) {
      setVolatile(battle, pokemon, 'perishsong', { duration: Math.max(1, Number(rawId.slice(6))) });
    } else if (rawId === 'substitute') {
      setVolatile(battle, pokemon, rawId, { hp: Math.floor(pokemon.maxhp / 4) });
    } else if (rawId === 'confusion') {
      setVolatile(battle, pokemon, rawId, { time: 2 });
    } else if (rawId === 'leechseed') {
      const seeder = foes.find(f => f.isActive && !f.fainted);
      if (seeder) setVolatile(battle, pokemon, rawId, { source: seeder, sourceSlot: seeder.getSlot() });
    } else if (rawId === 'twoturnmove' && info.move) {
      setVolatile(battle, pokemon, info.move, { duration: 2 });
      setVolatile(battle, pokemon, 'twoturnmove', { move: info.move, duration: 2 });
    } else if (rawId === 'mustrecharge') {
      setVolatile(battle, pokemon, 'mustrecharge', { duration: 2 });
    } else if (rawId === 'encore' || rawId === 'disable') {
      const move = mon.lastMove ?? mon.moves[0];
      if (move) setVolatile(battle, pokemon, rawId, { move, duration: remaining(effect, turn) });
    } else if (DURATIONS[rawId]) {
      setVolatile(battle, pokemon, rawId, { duration: remaining(effect, turn) });
    } else {
      setVolatile(battle, pokemon, rawId);
    }
  }
  if (mon.choiceLock && pokemon.getItem().isChoice) setVolatile(battle, pokemon, 'choicelock', { move: mon.choiceLock });
  if (mon.protectStreak > 0) {
    setVolatile(battle, pokemon, 'stall', { counter: 3 ** Math.min(mon.protectStreak, 6), duration: 1 });
  }
}

function applyPokemon(battle: SimBattle, pokemon: SimPokemon, mon: TrackedPokemon, exactHp: boolean, turn: number, foes: SimPokemon[]): void {
  if (mon.megaEvolved && !pokemon.species.isMega) {
    const form = megaForm(pokemon.set);
    if (form) pokemon.formeChange(form, pokemon.getItem(), true);
  }
  if (mon.item !== null && toID(pokemon.item) !== mon.item) {
    pokemon.item = mon.item as never;
    pokemon.itemState = battle.initEffectState({ id: mon.item, target: pokemon });
  }
  if (mon.fainted || mon.hp <= 0) {
    pokemon.hp = 0;
    pokemon.fainted = true;
    pokemon.isActive = false;
    pokemon.isStarted = false;
    pokemon.status = 'fnt' as never;
    pokemon.volatiles = {};
    pokemon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
    pokemon.side.pokemonLeft--;
    return;
  }
  pokemon.hp = exactHp ? Math.min(mon.hp, pokemon.maxhp) :
    Math.max(1, Math.min(pokemon.maxhp, Math.round((mon.hp / mon.maxhp) * pokemon.maxhp)));
  pokemon.status = '' as never;
  setStatus(battle, pokemon, mon);
  if (!pokemon.isActive) return;
  pokemon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...mon.boosts };
  pokemon.activeTurns = mon.activeTurns;
  pokemon.activeMoveActions = mon.moveActions;
  applyVolatiles(battle, pokemon, mon, turn, foes);
  for (const slot of pokemon.moveSlots) {
    const used = mon.ppUsed[slot.id] ?? 0;
    if (!exactHp) slot.pp = Math.max(0, slot.maxpp - used);
  }
}

function applySideConditions(battle: SimBattle, sideId: SideID, tracked: TrackedSide, turn: number): void {
  const side = battle[sideId];
  side.sideConditions = {};
  for (const effect of Object.values(tracked.conditions)) {
    const condition = battle.dex.conditions.get(effect.id);
    if (!condition.exists) continue;
    const state: Record<string, unknown> = {
      id: condition.id, name: condition.name, target: side, source: side.active[0], sourceSlot: side.active[0]?.getSlot(),
    };
    if (DURATIONS[effect.id]) state.duration = remaining(effect, turn, effect.source?.item);
    if (['spikes', 'toxicspikes'].includes(effect.id)) state.layers = effect.layers ?? 1;
    side.sideConditions[condition.id] = battle.initEffectState(state);
  }
}

function applyField(battle: SimBattle, tracker: BattleTracker): void {
  const field = battle.field;
  const anyActive = battle.getAllActive()[0];
  if (field.weather) field.clearWeather();
  if (field.terrain) field.clearTerrain();
  for (const id of Object.keys(field.pseudoWeather)) field.removePseudoWeather(id);
  const weather = tracker.field.weather;
  if (weather && anyActive) {
    field.setWeather(weather.id, anyActive);
    if (field.weatherState.duration) field.weatherState.duration = remaining(weather, tracker.turn, weather.source?.item);
  }
  const terrain = tracker.field.terrain;
  if (terrain && anyActive) {
    field.setTerrain(terrain.id, anyActive);
    if (field.terrainState.duration) field.terrainState.duration = remaining(terrain, tracker.turn, terrain.source?.item);
  }
  for (const effect of Object.values(tracker.field.pseudoWeather)) {
    if (!anyActive || !battle.dex.conditions.get(effect.id).exists) continue;
    field.addPseudoWeather(effect.id, anyActive);
    const state = field.pseudoWeather[effect.id];
    if (state) state.duration = remaining(effect, tracker.turn);
  }
}

export interface BeliefOptions {
  format: FormatInfo;
  side: SideID;
  team: PokemonSet[];
  tracker: BattleTracker;
  meta?: MetaSnapshot;
  seed?: PRNGSeed;
  /**
   * Our Pokémon to place in each active slot instead of the current ones (by name). Used to look
   * ahead at forced-switch choices.
   */
  replacements?: (string | null)[];
}

/**
 * Builds a full simulator battle matching what we know about the current position, so the AI can
 * play candidate turns forward. Hidden information (opponent Stat Points, unrevealed picks) is
 * filled with the most likely values from usage stats.
 */
export function buildBelief(request: BattleRequest, options: BeliefOptions): Belief {
  const { tracker, meta, side: ourSide } = options;
  const foeSide = opponentOf(ourSide);
  const pick = options.format.pick;
  const activeCount = tracker.activeCount;

  // Our side: request order (actives first), with optional replacements swapped into active slots.
  const order = request.side.pokemon.map(p => parseIdent(p.ident).name);
  options.replacements?.forEach((name, slot) => {
    if (!name) return;
    const from = order.indexOf(name);
    if (from >= 0) [order[slot], order[from]] = [order[from], order[slot]];
  });
  const ourTracked = order.map(name => tracker.sides[ourSide].team.find(m => m.name === name)!);
  const ourSets = ourTracked.map(mon => {
    const set = options.team.find(s => (s.name || dex.species.get(s.species).name) === mon.name) ??
      options.team.find(s => dex.species.get(s.species).name === mon.baseSpecies);
    if (!set) throw new Error(`No set for our ${mon.name}`);
    return { ...set, name: mon.name };
  });

  const foeTracked = opponentLineup(tracker.sides[foeSide], pick, meta);
  const foeSets = foeTracked.map(mon => opponentSet(mon, meta));

  const battle = new Battle({ formatid: options.format.simFormat as never, seed: options.seed ?? makeSeed([1, 2, 3, 4]) });
  battle.setPlayer(ourSide, { name: 'us', team: ourSets });
  battle.setPlayer(foeSide, { name: 'them', team: foeSets });
  for (const s of [ourSide, foeSide]) {
    const size = (s === ourSide ? ourSets : foeSets).length;
    battle.choose(s, `team ${Array.from({ length: size }, (_, i) => i + 1).join('')}`);
  }

  battle.turn = tracker.turn;
  const ourMons = battle[ourSide].pokemon;
  const foeMons = battle[foeSide].pokemon;
  ourMons.forEach((pokemon, i) => applyPokemon(battle, pokemon, ourTracked[i], true, tracker.turn, foeMons));
  foeMons.forEach((pokemon, i) => applyPokemon(battle, pokemon, foeTracked[i], false, tracker.turn, ourMons));
  for (const [sideId, tracked] of [[ourSide, tracker.sides[ourSide]], [foeSide, tracker.sides[foeSide]]] as const) {
    if (tracked.megaUsed) for (const p of battle[sideId].pokemon) p.canMegaEvo = null;
    applySideConditions(battle, sideId, tracked, tracker.turn);
  }
  // A replacement can't be on its first turn for Fake Out purposes unless it actually is.
  options.replacements?.forEach((name, slot) => {
    if (!name) return;
    const pokemon = battle[ourSide].active[slot];
    if (pokemon) {
      pokemon.activeMoveActions = 0;
      pokemon.activeTurns = 0;
      pokemon.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
    }
  });
  applyField(battle, tracker);
  for (let i = 0; i < activeCount; i++) {
    for (const s of [ourSide, foeSide]) {
      const p = battle[s].active[i];
      if (p && !p.fainted) p.isStarted = true;
    }
  }
  battle.makeRequest('move');
  return { battle, snapshot: JSON.stringify(State.serializeBattle(battle)), ourSide, foeSide };
}

export function cloneBattle(snapshot: string): SimBattle {
  return State.deserializeBattle(snapshot) as SimBattle;
}
