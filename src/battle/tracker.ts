import { Teams, type PokemonSet } from '../ps.js';
import { dex } from '../data/format.js';
import {
  effectId,
  kwArgs,
  parseCondition,
  parseDetails,
  parseIdent,
  splitLine,
  toId,
  type BattleRequest,
  type BoostID,
  type SideID,
  type StatusID,
} from './protocol.js';

const PROTECT_MOVES = new Set([
  'protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'obstruct', 'silktrap', 'burningbulwark',
  'endure',
]);

export interface TrackedPokemon {
  side: SideID;
  /** Nickname as used in idents (empty until the Pokémon has been seen or named on a sheet). */
  name: string;
  /** Species on the team sheet / preview (pre-Mega). */
  baseSpecies: string;
  /** Current forme, e.g. `Salamence-Mega`. */
  species: string;
  level: number;
  gender: string;
  /** Exact HP for our own side; out of 100 for the opponent. */
  hp: number;
  maxhp: number;
  status: StatusID;
  fainted: boolean;
  boosts: Partial<Record<BoostID, number>>;
  /** Active volatile effects by id, with the turn they started. */
  volatiles: Record<string, { turn: number; move?: string }>;
  /** Item id; `''` once consumed or removed; `null` while unknown. */
  item: string | null;
  ability: string | null;
  /** Move ids known for this Pokémon (from team sheets or seen in battle). */
  moves: string[];
  ppUsed: Record<string, number>;
  megaEvolved: boolean;
  /** Has been sent into battle. */
  revealed: boolean;
  /** Active slot, or null while on the bench. */
  slot: number | null;
  /** End-of-turn residuals survived since switching in. */
  activeTurns: number;
  /** Move actions taken since switching in (Fake Out / First Impression only work on the first). */
  moveActions: number;
  lastMove: string | null;
  /** Consecutive successful Protect-style moves. */
  protectStreak: number;
  sleepTurns: number;
  toxicTurns: number;
  /** Move this Pokémon is locked into by a Choice item. */
  choiceLock: string | null;
  /** Full set when known (our own team, or the opponent's open team sheet). */
  set?: PokemonSet;
}

export interface TimedEffect {
  id: string;
  /** Turn on which the effect started. */
  turn: number;
  /** Pokémon that caused it, when known (for item-extended durations). */
  source?: TrackedPokemon;
  layers?: number;
}

export interface TrackedSide {
  id: SideID;
  name: string;
  team: TrackedPokemon[];
  active: (TrackedPokemon | null)[];
  conditions: Record<string, TimedEffect>;
  megaUsed: boolean;
}

export interface TrackedField {
  weather: TimedEffect | null;
  terrain: TimedEffect | null;
  pseudoWeather: Record<string, TimedEffect>;
}

function newPokemon(side: SideID, species: string, name = ''): TrackedPokemon {
  return {
    side, name, baseSpecies: species, species, level: 50, gender: '',
    hp: 100, maxhp: 100, status: '', fainted: false, boosts: {}, volatiles: {},
    item: null, ability: null, moves: [], ppUsed: {}, megaEvolved: false, revealed: false, slot: null,
    activeTurns: 0, moveActions: 0, lastMove: null, protectStreak: 0, sleepTurns: 0, toxicTurns: 0,
    choiceLock: null,
  };
}

function speciesMatches(a: string, b: string): boolean {
  const sa = dex.species.get(a);
  const sb = dex.species.get(b);
  if (sa.id === sb.id) return true;
  // Team preview hides some formes (`Urshifu-*`); Megas show their base form before evolving.
  return sa.baseSpecies === sb.baseSpecies && (a.endsWith('-*') || b.endsWith('-*') || !!sa.isMega || !!sb.isMega);
}

/**
 * Reconstructs what a player can know about a battle from the protocol stream: both teams as far
 * as they've been revealed, HP, status, boosts, volatiles, field and side conditions.
 */
export class BattleTracker {
  turn = 0;
  gameType: 'doubles' | 'singles' = 'doubles';
  ended = false;
  winner: string | null = null;
  readonly sides: Record<SideID, TrackedSide>;
  readonly field: TrackedField = { weather: null, terrain: null, pseudoWeather: {} };
  /** The most recent Pokémon to use a move (to attribute weather/terrain set by moves). */
  private lastMover: TrackedPokemon | null = null;
  /** Set once this turn's end-of-turn effects have run (`|upkeep|`). */
  private upkeepDone = false;

  /**
   * First turn whose end-of-turn countdown applies to an effect starting now. Effects started during
   * a turn's actions tick down at that turn's end; ones started at battle start or by replacements
   * sent in after the end-of-turn phase first tick down a turn later.
   */
  private get effectTurn(): number {
    return this.turn === 0 || this.upkeepDone ? this.turn + 1 : this.turn;
  }

  constructor() {
    this.sides = {
      p1: { id: 'p1', name: '', team: [], active: [null, null], conditions: {}, megaUsed: false },
      p2: { id: 'p2', name: '', team: [], active: [null, null], conditions: {}, megaUsed: false },
    };
  }

  get activeCount(): number {
    return this.gameType === 'doubles' ? 2 : 1;
  }

  /** Registers a full team (our own, or an opponent's open team sheet). */
  setTeam(side: SideID, team: PokemonSet[]): void {
    const s = this.sides[side];
    for (const set of team) {
      const species = dex.species.get(set.species).name;
      let mon = s.team.find(p => (set.name && p.name === set.name) || (!p.set && speciesMatches(p.baseSpecies, species)));
      if (!mon) {
        mon = newPokemon(side, species);
        s.team.push(mon);
      }
      mon.set = set;
      mon.name = mon.name || set.name || species;
      mon.baseSpecies = species;
      if (!mon.revealed) mon.species = species;
      mon.level = set.level || 50;
      mon.gender = set.gender || mon.gender;
      if (mon.item === null) mon.item = toId(set.item);
      if (mon.ability === null) mon.ability = toId(set.ability);
      for (const move of set.moves) {
        const id = toId(move);
        if (!mon.moves.includes(id)) mon.moves.push(id);
      }
    }
  }

  /** Our request carries exact information about our own side. */
  syncRequest(request: BattleRequest): void {
    const side = this.sides[request.side.id];
    side.name = request.side.name;
    for (const rp of request.side.pokemon) {
      const ident = parseIdent(rp.ident);
      const details = parseDetails(rp.details);
      const mon = this.findPokemon(request.side.id, ident.name, details.species);
      const cond = parseCondition(rp.condition);
      mon.hp = cond.hp;
      mon.maxhp = cond.fainted ? mon.maxhp : cond.maxhp;
      mon.status = cond.status;
      mon.fainted = cond.fainted;
      mon.item = toId(rp.item);
      mon.ability = toId(rp.ability || rp.baseAbility);
      mon.species = details.species;
      mon.moves = rp.moves.map(toId);
    }
  }

  getPokemon(identText: string, detailsText?: string): TrackedPokemon {
    const ident = parseIdent(identText);
    const species = detailsText ? parseDetails(detailsText).species : undefined;
    return this.findPokemon(ident.side, ident.name, species);
  }

  private findPokemon(sideId: SideID, name: string, species?: string): TrackedPokemon {
    const side = this.sides[sideId];
    let mon = side.team.find(p => p.name === name && (!species || !p.revealed || speciesMatches(p.species, species) || speciesMatches(p.baseSpecies, species)));
    if (!mon && species) {
      mon = side.team.find(p => !p.revealed && speciesMatches(p.baseSpecies, species) && (!p.name || p.name === p.baseSpecies || p.name === name));
    }
    if (!mon) {
      mon = newPokemon(sideId, species ?? name, name);
      side.team.push(mon);
    }
    if (name) mon.name = name;
    return mon;
  }

  /** Feeds a chunk of protocol (one or more lines). */
  receive(chunk: string): void {
    for (const line of chunk.split('\n')) this.handleLine(line);
  }

  handleLine(line: string): void {
    const parts = splitLine(line);
    if (!parts) return;
    const [cmd, ...rest] = parts;
    const { args, kw } = kwArgs(rest);
    switch (cmd) {
      case 'player':
        if (args[0] === 'p1' || args[0] === 'p2') this.sides[args[0]].name = args[1] ?? '';
        break;
      case 'gametype':
        this.gameType = args[0] === 'singles' ? 'singles' : 'doubles';
        for (const side of Object.values(this.sides)) side.active = new Array(this.activeCount).fill(null);
        break;
      case 'clearpoke':
        for (const side of Object.values(this.sides)) side.team = side.team.filter(p => p.set);
        break;
      case 'poke': {
        const side = args[0] as SideID;
        const details = parseDetails(args[1]);
        const existing = this.sides[side].team.find(p => speciesMatches(p.baseSpecies, details.species));
        if (!existing) {
          const mon = newPokemon(side, details.species);
          mon.level = details.level;
          mon.gender = details.gender;
          this.sides[side].team.push(mon);
        }
        break;
      }
      case 'showteam': {
        const side = args[0] as SideID;
        const team = Teams.unpack(args.slice(1).join('|'));
        if (team) this.setTeam(side, team);
        break;
      }
      case 'turn':
        this.turn = Number(args[0]);
        this.upkeepDone = false;
        break;
      case 'upkeep':
        this.upkeepDone = true;
        for (const side of Object.values(this.sides)) {
          for (const mon of side.active) {
            if (!mon || mon.fainted) continue;
            mon.activeTurns++;
            if (mon.status === 'tox') mon.toxicTurns++;
          }
        }
        break;
      case 'switch':
      case 'drag':
        this.onSwitch(args[0], args[1], args[2]);
        break;
      case 'detailschange': {
        const mon = this.getPokemon(args[0]);
        mon.species = parseDetails(args[1]).species;
        break;
      }
      case '-formechange': {
        const mon = this.getPokemon(args[0]);
        mon.species = args[1];
        break;
      }
      case '-mega': {
        const mon = this.getPokemon(args[0]);
        mon.megaEvolved = true;
        this.sides[mon.side].megaUsed = true;
        if (args[2]) mon.item = toId(args[2]);
        break;
      }
      case 'move':
        this.onMove(args[0], args[1], kw);
        break;
      case 'cant': {
        const mon = this.getPokemon(args[0]);
        mon.moveActions++;
        mon.protectStreak = 0;
        if (args[1] === 'slp') mon.sleepTurns++;
        if (args[1] === 'recharge') delete mon.volatiles['mustrecharge'];
        delete mon.volatiles['twoturnmove'];
        break;
      }
      case '-fail': {
        const mon = this.getPokemon(args[0]);
        if (mon.lastMove && PROTECT_MOVES.has(mon.lastMove)) mon.protectStreak = 0;
        break;
      }
      case '-damage':
      case '-heal':
      case '-sethp': {
        const mon = this.getPokemon(args[0]);
        this.applyCondition(mon, args[1]);
        break;
      }
      case 'faint': {
        const mon = this.getPokemon(args[0]);
        mon.hp = 0;
        mon.fainted = true;
        mon.status = '';
        mon.boosts = {};
        mon.volatiles = {};
        break;
      }
      case '-status': {
        const mon = this.getPokemon(args[0]);
        mon.status = args[1] as StatusID;
        mon.sleepTurns = 0;
        mon.toxicTurns = 0;
        break;
      }
      case '-curestatus': {
        const mon = this.getPokemon(args[0]);
        mon.status = '';
        break;
      }
      case '-cureteam': {
        const mon = this.getPokemon(args[0]);
        for (const p of this.sides[mon.side].team) p.status = '';
        break;
      }
      case '-boost':
      case '-unboost': {
        const mon = this.getPokemon(args[0]);
        const stat = args[1] as BoostID;
        const amount = Number(args[2]) * (cmd === '-boost' ? 1 : -1);
        mon.boosts[stat] = Math.max(-6, Math.min(6, (mon.boosts[stat] ?? 0) + amount));
        break;
      }
      case '-setboost': {
        const mon = this.getPokemon(args[0]);
        mon.boosts[args[1] as BoostID] = Number(args[2]);
        break;
      }
      case '-clearboost':
        this.getPokemon(args[0]).boosts = {};
        break;
      case '-clearallboost':
        for (const side of Object.values(this.sides)) for (const p of side.active) if (p) p.boosts = {};
        break;
      case '-clearnegativeboost': {
        const mon = this.getPokemon(args[0]);
        for (const [k, v] of Object.entries(mon.boosts)) if (v < 0) delete mon.boosts[k as BoostID];
        break;
      }
      case '-clearpositiveboost': {
        const mon = this.getPokemon(args[0]);
        for (const [k, v] of Object.entries(mon.boosts)) if (v > 0) delete mon.boosts[k as BoostID];
        break;
      }
      case '-invertboost': {
        const mon = this.getPokemon(args[0]);
        for (const k of Object.keys(mon.boosts) as BoostID[]) mon.boosts[k] = -(mon.boosts[k] ?? 0);
        break;
      }
      case '-copyboost': {
        const source = this.getPokemon(args[0]);
        const target = this.getPokemon(args[1]);
        target.boosts = { ...source.boosts };
        break;
      }
      case '-weather': {
        if (args[0] === 'none') {
          this.field.weather = null;
        } else if (!('upkeep' in kw)) {
          this.field.weather = { id: toId(args[0]), turn: this.effectTurn, source: this.sourceOf(kw) };
        }
        break;
      }
      case '-fieldstart': {
        const id = effectId(args[0]);
        const effect = { id, turn: this.effectTurn, source: this.sourceOf(kw) };
        if (id.endsWith('terrain')) this.field.terrain = effect;
        else this.field.pseudoWeather[id] = effect;
        break;
      }
      case '-fieldend': {
        const id = effectId(args[0]);
        if (id.endsWith('terrain')) this.field.terrain = null;
        else delete this.field.pseudoWeather[id];
        break;
      }
      case '-sidestart': {
        const side = this.sides[args[0].slice(0, 2) as SideID];
        const id = effectId(args[1]);
        const existing = side.conditions[id];
        side.conditions[id] = {
          id, turn: existing?.turn ?? this.effectTurn, source: this.lastMover ?? undefined,
          layers: (existing?.layers ?? 0) + 1,
        };
        break;
      }
      case '-sideend': {
        const side = this.sides[args[0].slice(0, 2) as SideID];
        delete side.conditions[effectId(args[1])];
        break;
      }
      case '-swapsideconditions': {
        const tmp = this.sides.p1.conditions;
        this.sides.p1.conditions = this.sides.p2.conditions;
        this.sides.p2.conditions = tmp;
        break;
      }
      case '-start': {
        const mon = this.getPokemon(args[0]);
        const id = effectId(args[1]);
        if (id === 'typechange' || id === 'typeadd') break;
        mon.volatiles[id] = { turn: this.effectTurn };
        break;
      }
      case '-prepare': {
        // Charging turn of a two-turn move: locked into it next turn.
        const mon = this.getPokemon(args[0]);
        mon.volatiles['twoturnmove'] = { turn: this.effectTurn, move: toId(args[1]) };
        break;
      }
      case '-mustrecharge': {
        const mon = this.getPokemon(args[0]);
        mon.volatiles['mustrecharge'] = { turn: this.effectTurn };
        break;
      }
      case '-end': {
        const mon = this.getPokemon(args[0]);
        delete mon.volatiles[effectId(args[1])];
        break;
      }
      case '-item': {
        const mon = this.getPokemon(args[0]);
        mon.item = toId(args[1]);
        break;
      }
      case '-enditem': {
        const mon = this.getPokemon(args[0]);
        mon.item = '';
        mon.choiceLock = null;
        break;
      }
      case '-ability': {
        const mon = this.getPokemon(args[0]);
        mon.ability = toId(args[1]);
        break;
      }
      case 'win':
        this.ended = true;
        this.winner = args[0] ?? null;
        break;
      case 'tie':
        this.ended = true;
        break;
    }
  }

  private sourceOf(kw: Record<string, string>): TrackedPokemon | undefined {
    if (kw.of) return this.getPokemon(kw.of);
    return this.lastMover ?? undefined;
  }

  private applyCondition(mon: TrackedPokemon, condition: string | undefined): void {
    if (!condition) return;
    const cond = parseCondition(condition);
    mon.hp = cond.hp;
    if (!cond.fainted) mon.maxhp = cond.maxhp;
    mon.fainted = cond.fainted;
    if (!cond.fainted) mon.status = cond.status;
  }

  private onSwitch(identText: string, detailsText: string, condition: string): void {
    const ident = parseIdent(identText);
    const details = parseDetails(detailsText);
    const side = this.sides[ident.side];
    const slot = ident.slot ?? 0;
    const previous = side.active[slot];
    if (previous) {
      previous.slot = null;
      previous.boosts = {};
      previous.volatiles = {};
      previous.choiceLock = null;
      previous.protectStreak = 0;
      // Temporary formes revert on switching out; Mega Evolution is permanent.
      if (!previous.megaEvolved) previous.species = previous.baseSpecies;
    }
    const mon = this.findPokemon(ident.side, ident.name, details.species);
    mon.revealed = true;
    mon.slot = slot;
    mon.level = details.level;
    mon.gender = details.gender || mon.gender;
    if (!mon.megaEvolved) mon.species = details.species;
    mon.activeTurns = 0;
    mon.moveActions = 0;
    mon.protectStreak = 0;
    mon.lastMove = null;
    mon.boosts = {};
    mon.volatiles = {};
    mon.choiceLock = null;
    this.applyCondition(mon, condition);
    side.active[slot] = mon;
  }

  private onMove(identText: string, moveName: string, kw: Record<string, string>): void {
    const mon = this.getPokemon(identText);
    const id = toId(moveName);
    this.lastMover = mon;
    if (!kw.still || mon.volatiles['twoturnmove']?.move !== id) delete mon.volatiles['twoturnmove'];
    // Moves called by other effects (Metronome, Instruct, lock-in continuation) aren't new actions.
    if (kw.from) return;
    mon.moveActions++;
    if (!mon.moves.includes(id) && dex.moves.get(id).exists) mon.moves.push(id);
    mon.ppUsed[id] = (mon.ppUsed[id] ?? 0) + 1;
    mon.protectStreak = PROTECT_MOVES.has(id) && mon.lastMove !== null && PROTECT_MOVES.has(mon.lastMove) ?
      mon.protectStreak + 1 : PROTECT_MOVES.has(id) ? 1 : 0;
    mon.lastMove = id;
    if (mon.item && dex.items.get(mon.item).isChoice && !mon.choiceLock) mon.choiceLock = id;
  }

  side(id: SideID): TrackedSide {
    return this.sides[id];
  }

  foe(id: SideID): TrackedSide {
    return this.sides[id === 'p1' ? 'p2' : 'p1'];
  }
}
