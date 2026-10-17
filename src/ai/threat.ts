import type { Battle, SimPokemon } from '../ps.js';
import type { SideID } from '../battle/protocol.js';
import { megaForm } from '../data/sets.js';
import { Heuristics } from './heuristics.js';

interface Attack {
  /** Best expected damage as a fraction of the defender's max HP. */
  frac: number;
  /** Best damage from a priority move (acts first regardless of Speed). */
  priorityFrac: number;
}

function key(p: SimPokemon, speciesName = p.species.name): string {
  return `${p.side.id}|${p.name}|${speciesName}`;
}

/**
 * Next-turn pressure each side exerts at a leaf position, from damage calcs precomputed at the
 * root: who can KO whom, and who moves first. This gives a one-turn search a sense of what the
 * following turn looks like (why Tailwind, Speed drops, paralysis and chip damage matter).
 */
export class ThreatModel {
  private readonly table = new Map<string, Attack>();

  constructor(root: Battle, readonly weight = 0.35) {
    const heuristics = new Heuristics(root);
    for (const side of root.sides) {
      const foeSide = root.sides.find(s => s !== side)!;
      for (const attacker of side.pokemon) {
        if (attacker.fainted) continue;
        const forms = [attacker.species.name];
        const mega = !attacker.species.isMega && attacker.canMegaEvo ? megaForm(attacker.set) : null;
        if (mega) forms.push(mega);
        for (const defender of foeSide.pokemon) {
          if (defender.fainted) continue;
          forms.forEach((form, i) => {
            let frac = 0;
            let priorityFrac = 0;
            for (const slot of attacker.moveSlots) {
              const move = root.dex.moves.get(slot.id);
              if (move.category === 'Status' || move.id === 'fakeout') continue;
              const d = heuristics.damage(attacker, defender, slot.id, i === 1).frac;
              frac = Math.max(frac, d);
              if (move.priority > 0 || (move.id === 'grassyglide' && root.field.terrain === 'grassyterrain')) {
                priorityFrac = Math.max(priorityFrac, d);
              }
            }
            this.table.set(`${key(attacker, form)}>${key(defender)}`, { frac, priorityFrac });
          });
        }
      }
    }
  }

  private lookup(attacker: SimPokemon, defender: SimPokemon): Attack | undefined {
    const defenderKey = key(defender, defender.baseSpecies.name);
    return this.table.get(`${key(attacker)}>${key(defender)}`) ??
      this.table.get(`${key(attacker)}>${defenderKey}`) ??
      this.table.get(`${key(attacker, attacker.baseSpecies.name)}>${key(defender)}`);
  }

  private sideThreat(battle: Battle, sideId: SideID): number {
    const us = battle[sideId];
    const them = battle[sideId === 'p1' ? 'p2' : 'p1'];
    const defenders = them.active.filter(p => p && !p.fainted && p.hp > 0);
    let total = 0;
    for (const attacker of us.active) {
      if (!attacker || attacker.fainted || attacker.hp <= 0) continue;
      if (attacker.status === 'slp' || attacker.status === 'frz') continue;
      let best = 0;
      for (const defender of defenders) {
        const attack = this.lookup(attacker, defender);
        if (!attack) continue;
        const hpFrac = defender.hp / defender.maxhp;
        const faster = attacker.getActionSpeed() > defender.getActionSpeed();
        const value = (d: number) => Math.min(d, hpFrac) + (d >= hpFrac ? 1 : 0);
        const v = Math.max(value(attack.frac) * (faster ? 1 : 0.55), value(attack.priorityFrac));
        if (v > best) best = v;
      }
      total += best;
    }
    return total;
  }

  /** Positive when `sideId` threatens more than it is threatened. */
  score(battle: Battle, sideId: SideID): number {
    if (battle.ended) return 0;
    return this.weight * (this.sideThreat(battle, sideId) - this.sideThreat(battle, sideId === 'p1' ? 'p2' : 'p1'));
  }
}
