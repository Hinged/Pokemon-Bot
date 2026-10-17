import {
  calculate,
  Field as CalcField,
  Move as CalcMove,
  Pokemon as CalcPokemon,
} from '@smogon/calc';
import type { Battle, SimPokemon } from '../ps.js';
import { calcGen } from '../data/damage.js';
import { megaForm } from '../data/sets.js';
import type { BattleRequest, SideID } from '../battle/protocol.js';
import type { SlotOption } from './actions.js';

type CalcWeather = 'Sun' | 'Rain' | 'Sand' | 'Snow';
type CalcTerrain = 'Electric' | 'Grassy' | 'Psychic' | 'Misty';
const WEATHER: Record<string, CalcWeather> = { sunnyday: 'Sun', raindance: 'Rain', sandstorm: 'Sand', snowscape: 'Snow', snow: 'Snow' };
const TERRAIN: Record<string, CalcTerrain> = {
  electricterrain: 'Electric', grassyterrain: 'Grassy', psychicterrain: 'Psychic', mistyterrain: 'Misty',
};

const PROTECT = new Set(['protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'obstruct', 'silktrap', 'burningbulwark']);
const SLEEP = new Set(['spore', 'sleeppowder', 'hypnosis', 'yawn', 'darkvoid', 'lovelykiss', 'sing', 'grasswhistle']);
const SETUP = new Set([
  'swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'bulkup', 'quiverdance', 'shellsmash', 'coil',
  'irondefense', 'shiftgear', 'victorydance', 'tidyup', 'agility', 'growth', 'workup', 'bellydrum', 'geomancy',
]);
const RECOVERY = new Set(['recover', 'roost', 'slackoff', 'softboiled', 'moonlight', 'morningsun', 'synthesis', 'shoreup', 'strengthsap', 'lifedew', 'junglehealing']);
const REDIRECT = new Set(['followme', 'ragepowder', 'spotlight']);
const WEATHER_MOVES: Record<string, string> = { sunnyday: 'sunnyday', raindance: 'raindance', sandstorm: 'sandstorm', snowscape: 'snowscape' };
const TERRAIN_MOVES: Record<string, string> = {
  electricterrain: 'electricterrain', grassyterrain: 'grassyterrain', psychicterrain: 'psychicterrain', mistyterrain: 'mistyterrain',
};

/** Scores candidate actions with a damage calc and VGC rules of thumb, for pruning and greedy play. */
export class Heuristics {
  private readonly calcCache = new Map<string, CalcPokemon>();
  private readonly fieldCache = new Map<SideID, CalcField>();

  constructor(readonly battle: Battle) {}

  private calcMon(p: SimPokemon, mega = false): CalcPokemon {
    const key = `${p.side.id}${p.position}${mega ? 'm' : ''}${p.fullname}`;
    let mon = this.calcCache.get(key);
    if (mon) return mon;
    const form = mega && !p.species.isMega ? megaForm(p.set) : null;
    const species = form ?? p.species.name;
    const ability = form ? this.battle.dex.species.get(form).abilities['0'] : p.getAbility().name;
    try {
      mon = new CalcPokemon(calcGen, species, {
        item: p.getItem().name || undefined,
        ability,
        nature: p.set.nature || 'Hardy',
        evs: { ...p.set.evs },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        level: 50,
        boosts: { atk: p.boosts.atk, def: p.boosts.def, spa: p.boosts.spa, spd: p.boosts.spd, spe: p.boosts.spe },
        status: (p.status || '') as '',
        curHP: p.hp,
      });
    } catch {
      mon = new CalcPokemon(calcGen, p.species.baseSpecies, { level: 50, curHP: p.hp });
    }
    this.calcCache.set(key, mon);
    return mon;
  }

  /** Field from the point of view of an attack aimed at `defenderSide`. */
  private calcField(defenderSide: SideID): CalcField {
    let field = this.fieldCache.get(defenderSide);
    if (field) return field;
    const b = this.battle;
    const conds = b[defenderSide].sideConditions;
    field = new CalcField({
      gameType: b.gameType === 'doubles' ? 'Doubles' : 'Singles',
      weather: WEATHER[b.field.weather],
      terrain: TERRAIN[b.field.terrain],
      defenderSide: { isReflect: !!conds['reflect'], isLightScreen: !!conds['lightscreen'], isAuroraVeil: !!conds['auroraveil'] },
    });
    this.fieldCache.set(defenderSide, field);
    return field;
  }

  /** Expected damage as a fraction of the defender's max HP, with KO probability. */
  damage(attacker: SimPokemon, defender: SimPokemon, moveId: string, mega = false): { frac: number; koChance: number } {
    const att = this.calcMon(attacker, mega);
    const def = this.calcMon(defender);
    try {
      const move = new CalcMove(calcGen, this.battle.dex.moves.get(moveId).name, { ability: att.ability, item: att.item, species: att.name });
      const result = calculate(calcGen, att, def, move, this.calcField(defender.side.id));
      const [min, max] = result.range();
      if (!max) return { frac: 0, koChance: 0 };
      const maxhp = defender.maxhp;
      const hp = defender.hp;
      const koChance = min >= hp ? 1 : max < hp ? 0 : (max - hp + 1) / (max - min + 1);
      return { frac: (min + max) / 2 / maxhp, koChance };
    } catch {
      return { frac: 0, koChance: 0 };
    }
  }

  private foes(sideId: SideID): SimPokemon[] {
    return this.battle[sideId === 'p1' ? 'p2' : 'p1'].active.filter(p => p && !p.fainted && p.hp > 0);
  }

  private targetOf(sideId: SideID, slot: number, target: number | undefined): SimPokemon | null {
    if (target === undefined) return null;
    const side = target > 0 ? this.battle[sideId === 'p1' ? 'p2' : 'p1'] : this.battle[sideId];
    const p = side.active[Math.abs(target) - 1];
    if (p && !p.fainted && p.hp > 0) return p;
    // Single-target moves aimed at an empty slot retarget the other foe.
    return target > 0 ? this.foes(sideId)[0] ?? null : null;
  }

  /** Value of damaging `target`, in evaluation units (HP fraction plus a KO bonus). */
  private damageValue(attacker: SimPokemon, target: SimPokemon, moveId: string, mega: boolean): number {
    const { frac, koChance } = this.damage(attacker, target, moveId, mega);
    const hpFrac = target.hp / target.maxhp;
    return Math.min(frac, hpFrac) + koChance * 1.0;
  }

  /** Highest expected damage fraction any foe active can deal to `p`. */
  threatTo(p: SimPokemon, sideId: SideID): number {
    let worst = 0;
    for (const foe of this.foes(sideId)) {
      for (const slot of foe.moveSlots) {
        const { frac } = this.damage(foe, p, slot.id);
        if (frac > worst) worst = frac;
      }
    }
    return worst;
  }

  scoreOption(sideId: SideID, slot: number, opt: SlotOption, request: BattleRequest): number {
    const b = this.battle;
    const self = b[sideId].active[slot];
    if (!self || self.fainted) return 0;
    if (opt.kind === 'pass') return 0;
    if (opt.kind === 'switch') {
      const incoming = b[sideId].pokemon.find(p => p.fullname === identAt(request, opt.switchIndex!));
      if (!incoming) return 0.05;
      const now = this.threatTo(self, sideId);
      const then = this.threatTo(incoming, sideId) * (incoming.hp / incoming.maxhp > 0 ? 1 : 2);
      return 0.05 + Math.max(-0.3, Math.min(0.6, 0.6 * (now - then)));
    }

    const moveId = opt.moveId!;
    const move = b.dex.moves.get(moveId);
    const mega = !!opt.mega;
    const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
    // Mega Evolving is almost always right once it's on the field; break ties toward it.
    const megaBonus = mega ? 0.05 : 0;
    const foes = this.foes(sideId);
    const ally = b[sideId].active[slot === 0 ? 1 : 0];

    if (move.category !== 'Status') {
      let value = 0;
      if (move.target === 'allAdjacentFoes' || move.target === 'allAdjacent') {
        for (const foe of foes) value += this.damageValue(self, foe, moveId, mega);
        if (move.target === 'allAdjacent' && ally && !ally.fainted) value -= this.damageValue(self, ally, moveId, mega);
      } else {
        const target = this.targetOf(sideId, slot, opt.target);
        if (!target) return 0;
        if (target.side === self.side) return -this.damageValue(self, target, moveId, mega);
        value = this.damageValue(self, target, moveId, mega);
        if (moveId === 'fakeout' || moveId === 'firstimpression') {
          if (self.activeMoveActions > 0) return -0.5;
          if (moveId === 'fakeout') value += 0.45;
        }
      }
      if (move.priority > 0) value *= 1.1;
      if (move.self?.boosts || move.selfBoost) value *= 0.95;
      if (['icywind', 'electroweb', 'bulldoze', 'snarl', 'strugglebug', 'rocktomb'].includes(moveId)) value += 0.2;
      if (moveId === 'uturn' || moveId === 'voltswitch' || moveId === 'flipturn') value += 0.08;
      return value * accuracy + megaBonus;
    }

    // Status moves: rules of thumb, refined by the search.
    let value = 0.12;
    const target = this.targetOf(sideId, slot, opt.target);
    const ourSide = b[sideId];
    const threatened = this.threatTo(self, sideId);
    if (PROTECT.has(moveId)) {
      value = self.volatiles['stall'] ? 0.02 : 0.15 + 0.4 * Math.min(1, threatened);
    } else if (moveId === 'tailwind') {
      value = ourSide.sideConditions['tailwind'] ? -0.2 : 0.75;
    } else if (moveId === 'trickroom') {
      const ours = ourSide.active.filter(p => p && !p.fainted).map(p => p.getStat('spe', true, true));
      const theirs = foes.map(p => p.getStat('spe', true, true));
      const slower = avg(ours) < avg(theirs);
      const active = !!b.field.pseudoWeather['trickroom'];
      value = active ? (slower ? -0.5 : 0.5) : (slower ? 0.85 : 0);
    } else if (REDIRECT.has(moveId)) {
      value = ally && !ally.fainted ? 0.4 : 0;
    } else if (moveId === 'helpinghand') {
      value = ally && !ally.fainted ? 0.25 : 0;
    } else if (SLEEP.has(moveId)) {
      value = target && !target.status && target.side !== self.side ? 0.7 : 0;
      if (target?.hasType('Grass') && move.flags['powder']) value = 0;
    } else if (moveId === 'willowisp') {
      value = target && !target.status && !target.hasType('Fire') && target.side !== self.side ? 0.25 + 0.35 * physicalBias(target) : 0;
    } else if (moveId === 'thunderwave' || moveId === 'glare' || moveId === 'nuzzle') {
      value = target && !target.status && target.side !== self.side ? 0.35 : 0;
    } else if (moveId === 'partingshot') {
      value = 0.35;
    } else if (['reflect', 'lightscreen', 'auroraveil'].includes(moveId)) {
      value = ourSide.sideConditions[moveId] ? -0.1 : 0.5;
      if (moveId === 'auroraveil' && b.field.weather !== 'snowscape' && b.field.weather !== 'snow') value = 0;
    } else if (SETUP.has(moveId)) {
      const boosts = (Object.values(self.boosts) as number[]).reduce((a, n) => a + Math.max(0, n), 0);
      value = boosts >= 4 ? 0 : 0.35 * (1 - threatened);
    } else if (RECOVERY.has(moveId)) {
      value = 0.8 * (1 - self.hp / self.maxhp);
    } else if (moveId === 'pollenpuff' || moveId === 'healpulse' || moveId === 'floralhealing') {
      value = target && target.side === self.side ? 0.6 * (1 - target.hp / target.maxhp) : 0.1;
    } else if (WEATHER_MOVES[moveId]) {
      value = b.field.weather === WEATHER_MOVES[moveId] ? -0.1 : 0.35;
    } else if (TERRAIN_MOVES[moveId]) {
      value = b.field.terrain === TERRAIN_MOVES[moveId] ? -0.1 : 0.3;
    } else if (moveId === 'taunt' || moveId === 'encore') {
      value = target && target.side !== self.side ? 0.2 : 0;
    } else if (moveId === 'wideguard' || moveId === 'quickguard') {
      value = 0.15;
    } else if (moveId === 'perishsong') {
      value = 0.1;
    }
    return value * accuracy + megaBonus;
  }

  /** Scores and sorts every option for each slot, best first. */
  rank(sideId: SideID, perSlot: SlotOption[][], request: BattleRequest): { opt: SlotOption; score: number }[][] {
    return perSlot.map((options, slot) =>
      options.map(opt => ({ opt, score: this.scoreOption(sideId, slot, opt, request) })).sort((a, b) => b.score - a.score));
  }
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function physicalBias(p: SimPokemon): number {
  const atk = p.storedStats.atk;
  const spa = p.storedStats.spa;
  return atk > spa ? Math.min(1, (atk - spa) / 60 + 0.5) : 0.1;
}

/** Ident (`p1: Name`) of the Pokémon at a 1-based index of a request's side. */
function identAt(request: BattleRequest, index: number): string {
  return request.side.pokemon[index - 1]?.ident ?? '';
}
