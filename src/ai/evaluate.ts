import type { Battle, SimPokemon, Side } from '../ps.js';
import type { SideID } from '../battle/protocol.js';

/** Weights for the position evaluation. One healthy Pokémon is worth about 2 points. */
export interface EvalWeights {
  alive: number;
  hp: number;
  win: number;
  attackBoost: number;
  speedBoost: number;
  defenseBoost: number;
  tailwindPerTurn: number;
  screenPerTurn: number;
  trickRoomPerTurn: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  alive: 1.0,
  hp: 1.0,
  win: 20,
  attackBoost: 0.12,
  speedBoost: 0.1,
  defenseBoost: 0.06,
  tailwindPerTurn: 0.18,
  screenPerTurn: 0.08,
  trickRoomPerTurn: 0.15,
};

function isPhysical(p: SimPokemon): boolean {
  let physical = 0;
  let special = 0;
  for (const slot of p.moveSlots) {
    const move = p.battle.dex.moves.get(slot.id);
    if (move.category === 'Physical') physical++;
    else if (move.category === 'Special') special++;
  }
  return physical >= special;
}

function statusPenalty(p: SimPokemon): number {
  switch (p.status) {
    case 'slp': return 0.45;
    case 'frz': return 0.5;
    case 'par': return 0.3;
    case 'brn': return isPhysical(p) ? 0.4 : 0.12;
    case 'tox': return 0.25;
    case 'psn': return 0.12;
    default: return 0;
  }
}

function clampBoost(n: number | undefined): number {
  const v = n ?? 0;
  return Math.max(-3, Math.min(3, v));
}

function pokemonValue(p: SimPokemon, w: EvalWeights): number {
  if (p.fainted || p.hp <= 0) return 0;
  const hpFrac = p.hp / p.maxhp;
  let value = w.alive + w.hp * hpFrac;
  value -= statusPenalty(p) * (0.5 + 0.5 * hpFrac);
  if (p.isActive) {
    const offense = isPhysical(p) ? p.boosts.atk : p.boosts.spa;
    value += w.attackBoost * clampBoost(offense) * hpFrac;
    value += w.speedBoost * clampBoost(p.boosts.spe) * hpFrac;
    value += w.defenseBoost * (clampBoost(p.boosts.def) + clampBoost(p.boosts.spd)) * hpFrac;
    if (p.volatiles['substitute']) value += 0.15;
    if (p.volatiles['perishsong']) value -= (w.alive + w.hp * hpFrac) * (1 / Math.max(1, p.volatiles['perishsong'].duration ?? 1));
    if (p.volatiles['confusion']) value -= 0.1;
    if (p.volatiles['taunt']) value -= 0.05;
    if (p.volatiles['encore']) value -= 0.1;
    if (p.volatiles['yawn']) value -= 0.2;
    if (p.volatiles['leechseed']) value -= 0.12;
    if (p.volatiles['saltcure']) value -= 0.15;
  }
  return value;
}

function aliveSpeeds(side: Side): number[] {
  return side.pokemon.filter(p => !p.fainted && p.hp > 0).map(p => p.getStat('spe', true, true));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function sideValue(side: Side, w: EvalWeights): number {
  let value = 0;
  for (const p of side.pokemon) value += pokemonValue(p, w);
  const alive = side.pokemon.filter(p => !p.fainted && p.hp > 0).length;
  const scale = Math.min(1, alive / 2);
  const cond = side.sideConditions;
  if (cond['tailwind']) value += w.tailwindPerTurn * (cond['tailwind'].duration ?? 1) * scale;
  for (const screen of ['reflect', 'lightscreen', 'auroraveil']) {
    if (cond[screen]) value += w.screenPerTurn * (cond[screen].duration ?? 1) * scale;
  }
  return value;
}

/** Static evaluation of a position from one side's point of view (positive = good for `sideId`). */
export function evaluate(battle: Battle, sideId: SideID, w: EvalWeights = DEFAULT_WEIGHTS): number {
  const us = battle[sideId];
  const them = battle[sideId === 'p1' ? 'p2' : 'p1'];
  if (battle.ended) {
    if (!battle.winner) return 0;
    const won = battle.winner === us.name;
    // Prefer quicker wins and slower losses; keep the material margin as a tiebreak.
    const margin = sideValue(us, w) - sideValue(them, w);
    return (won ? w.win : -w.win) + margin * 0.1;
  }
  let score = sideValue(us, w) - sideValue(them, w);
  const trickRoom = battle.field.pseudoWeather['trickroom'];
  if (trickRoom) {
    const ours = median(aliveSpeeds(us));
    const theirs = median(aliveSpeeds(them));
    const sign = ours < theirs ? 1 : ours > theirs ? -1 : 0;
    score += sign * w.trickRoomPerTurn * (trickRoom.duration ?? 1);
  }
  return score;
}
