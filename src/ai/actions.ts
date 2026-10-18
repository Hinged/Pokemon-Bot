import type { BattleRequest, RequestActive } from '../battle/protocol.js';

export interface SlotOption {
  kind: 'move' | 'switch' | 'pass';
  /** Choice fragment for this slot, e.g. `move 2 1 mega`, `switch 4`, `pass`. */
  choice: string;
  moveId?: string;
  /** 1-based move slot. */
  moveIndex?: number;
  /** Showdown target location: foes are 1/2, our own slots are -1/-2. */
  target?: number;
  mega?: boolean;
  /** 1-based index into `request.side.pokemon`. */
  switchIndex?: number;
}

export interface TargetInfo {
  /** Which foe slots hold a Pokémon that can be targeted. */
  foeAlive: boolean[];
}

function isFainted(condition: string): boolean {
  return condition.endsWith(' fnt') || condition.startsWith('0 ');
}

export function activeCount(request: BattleRequest): number {
  return request.active?.length ?? request.forceSwitch?.length ?? 1;
}

function targetsFor(moveTarget: string | undefined, slot: number, count: number, request: BattleRequest, info?: TargetInfo): number[] | null {
  if (count === 1) return null;
  const ally = slot === 0 ? 1 : 0;
  const allyMon = request.side.pokemon[ally];
  const allyAlive = !!allyMon && !isFainted(allyMon.condition);
  const foes = [1, 2].filter((_, i) => info?.foeAlive[i] ?? true);
  const foeTargets = foes.length ? foes : [1];
  switch (moveTarget) {
    case 'normal':
    case 'any':
      return foeTargets.concat(allyAlive ? [-(ally + 1)] : []);
    case 'adjacentFoe':
      return foeTargets;
    case 'adjacentAlly':
      return allyAlive ? [-(ally + 1)] : [];
    case 'adjacentAllyOrSelf':
      return allyAlive ? [-(ally + 1), -(slot + 1)] : [-(slot + 1)];
    default:
      return null;
  }
}

function switchOptions(request: BattleRequest, count: number): SlotOption[] {
  const out: SlotOption[] = [];
  request.side.pokemon.forEach((p, i) => {
    if (i < count || p.active || isFainted(p.condition) || p.reviving) return;
    out.push({ kind: 'switch', choice: `switch ${i + 1}`, switchIndex: i + 1 });
  });
  return out;
}

function moveOptions(active: RequestActive, slot: number, count: number, request: BattleRequest, info?: TargetInfo): SlotOption[] {
  const out: SlotOption[] = [];
  active.moves.forEach((m, i) => {
    if (m.disabled) return;
    if (m.pp !== undefined && m.pp <= 0 && m.id !== 'struggle') return;
    const targets = targetsFor(m.target, slot, count, request, info);
    if (targets && !targets.length) return;
    const variants = active.canMegaEvo ? [false, true] : [false];
    for (const mega of variants) {
      const suffix = mega ? ' mega' : '';
      if (!targets) {
        out.push({ kind: 'move', choice: `move ${i + 1}${suffix}`, moveId: m.id, moveIndex: i + 1, mega });
      } else {
        for (const t of targets) {
          out.push({ kind: 'move', choice: `move ${i + 1} ${t}${suffix}`, moveId: m.id, moveIndex: i + 1, target: t, mega });
        }
      }
    }
  });
  return out;
}

const PASS: SlotOption = { kind: 'pass', choice: 'pass' };

/** Legal options for each active slot of a request. */
export function slotOptions(request: BattleRequest, info?: TargetInfo): SlotOption[][] {
  const count = activeCount(request);
  if (request.forceSwitch) {
    const switches = switchOptions(request, count);
    return request.forceSwitch.map(must => (must && switches.length ? switches : [PASS]));
  }
  if (!request.active) return [[PASS]];
  return request.active.map((active, slot) => {
    const mon = request.side.pokemon[slot];
    if (!mon || isFainted(mon.condition) || mon.commanding) return [PASS];
    const moves = moveOptions(active, slot, count, request, info);
    const switches = active.trapped || active.maybeTrapped ? [] : switchOptions(request, count);
    const all = moves.concat(switches);
    return all.length ? all : [PASS];
  });
}

/** Whether a combination of slot options can be submitted together. */
export function isValidCombo(combo: SlotOption[]): boolean {
  let megas = 0;
  const switches = new Set<number>();
  for (const opt of combo) {
    if (opt.mega) megas++;
    if (opt.switchIndex !== undefined) {
      if (switches.has(opt.switchIndex)) return false;
      switches.add(opt.switchIndex);
    }
  }
  return megas <= 1;
}

/** All valid joint choices from per-slot candidate lists. */
export function combos(perSlot: SlotOption[][]): SlotOption[][] {
  let acc: SlotOption[][] = [[]];
  for (const options of perSlot) {
    const next: SlotOption[][] = [];
    for (const prefix of acc) for (const opt of options) next.push([...prefix, opt]);
    acc = next;
  }
  const valid = acc.filter(isValidCombo);
  return valid.length ? valid : acc.slice(0, 1);
}

/**
 * Makes a forced-switch choice valid: slots can't bring in the same Pokémon, and a slot may only
 * pass when no healthy Pokémon is left to send in.
 */
export function fixForcedSwitch(combo: SlotOption[], available: SlotOption[]): SlotOption[] {
  const used = new Set<number>();
  return combo.map(opt => {
    if (opt.switchIndex === undefined) return opt;
    if (!used.has(opt.switchIndex)) {
      used.add(opt.switchIndex);
      return opt;
    }
    const other = available.find(o => o.switchIndex !== undefined && !used.has(o.switchIndex));
    if (!other) return PASS;
    used.add(other.switchIndex!);
    return other;
  });
}

export function choiceString(combo: SlotOption[]): string {
  return combo.map(o => o.choice).join(', ');
}

export function randomChoice(request: BattleRequest, rng: () => number): string {
  if (request.teamPreview) {
    const order = request.side.pokemon.map((_, i) => i + 1);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return `team ${order.join('')}`;
  }
  const all = slotOptions(request);
  if (request.forceSwitch) {
    const picked = all.map(opts => opts[Math.floor(rng() * opts.length)]);
    return choiceString(fixForcedSwitch(picked, all.flat()));
  }
  const valid = combos(all);
  return choiceString(valid[Math.floor(rng() * valid.length)]);
}

/** `team 3142`-style choice from 0-based team indices. */
export function teamChoice(order: number[]): string {
  return `team ${order.map(i => i + 1).join('')}`;
}
