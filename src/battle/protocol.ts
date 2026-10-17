/** Helpers for Showdown's battle protocol (see SIM-PROTOCOL.md in pokemon-showdown). */

export type SideID = 'p1' | 'p2';
export type StatusID = '' | 'brn' | 'par' | 'slp' | 'frz' | 'psn' | 'tox';
export type BoostID = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';

export function toId(text: string | undefined | null): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Splits `|move|p1a: Foo|Tackle|p2a: Bar` into `['move', 'p1a: Foo', 'Tackle', 'p2a: Bar']`. */
export function splitLine(line: string): string[] | null {
  if (!line.startsWith('|')) return null;
  return line.slice(1).split('|');
}

/** Pulls `[from] ...`, `[of] ...` style keyword arguments off the end of a message. */
export function kwArgs(args: string[]): { args: string[]; kw: Record<string, string> } {
  const plain: string[] = [];
  const kw: Record<string, string> = {};
  for (const arg of args) {
    const m = /^\[(\w+)\]\s?(.*)$/.exec(arg);
    if (m) kw[m[1]] = m[2];
    else plain.push(arg);
  }
  return { args: plain, kw };
}

export interface Ident {
  side: SideID;
  /** Active slot index (0 = a, 1 = b) when the ident names a position. */
  slot: number | null;
  name: string;
}

export function parseIdent(ident: string): Ident {
  const m = /^(p[12])([a-c]?):\s*(.*)$/.exec(ident.trim());
  if (!m) {
    const side = ident.slice(0, 2) as SideID;
    return { side, slot: null, name: '' };
  }
  const slot = m[2] ? m[2].charCodeAt(0) - 'a'.charCodeAt(0) : null;
  return { side: m[1] as SideID, slot, name: m[3] };
}

export interface Details {
  species: string;
  level: number;
  gender: string;
}

export function parseDetails(details: string): Details {
  const parts = details.split(',').map(p => p.trim());
  const out: Details = { species: parts[0], level: 100, gender: '' };
  for (const part of parts.slice(1)) {
    if (/^L\d+$/.test(part)) out.level = Number(part.slice(1));
    else if (part === 'M' || part === 'F') out.gender = part;
  }
  return out;
}

export interface Condition {
  hp: number;
  maxhp: number;
  status: StatusID;
  fainted: boolean;
}

/**
 * Parses `150/207 par`, `75/100`, `0 fnt`, or Champions' `20/100y` (HP-bar colour hint suffix).
 */
export function parseCondition(condition: string): Condition {
  const [hpPart, status = ''] = condition.trim().split(/\s+/);
  if (status === 'fnt' || hpPart === '0') return { hp: 0, maxhp: 100, status: '', fainted: true };
  const [hpText, maxText = '100'] = hpPart.split('/');
  const hp = parseInt(hpText, 10);
  const maxhp = parseInt(maxText, 10);
  return {
    hp: Number.isFinite(hp) ? hp : 0,
    maxhp: Number.isFinite(maxhp) && maxhp > 0 ? maxhp : 100,
    status: (['brn', 'par', 'slp', 'frz', 'psn', 'tox'].includes(status) ? status : '') as StatusID,
    fainted: false,
  };
}

/** Strips `move: `, `ability: `, `item: ` prefixes from effect names and converts to an id. */
export function effectId(effect: string | undefined): string {
  return toId((effect ?? '').replace(/^(move|ability|item):\s*/i, ''));
}

/** Request JSON the simulator sends to a player (`|request|{...}`). */
export interface RequestMove {
  move: string;
  id: string;
  pp?: number;
  maxpp?: number;
  target?: string;
  disabled?: boolean | string;
}

export interface RequestActive {
  moves: RequestMove[];
  trapped?: boolean;
  maybeTrapped?: boolean;
  canMegaEvo?: boolean;
  maybeDisabled?: boolean;
}

export interface RequestPokemon {
  ident: string;
  details: string;
  condition: string;
  active: boolean;
  stats: Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>;
  moves: string[];
  baseAbility: string;
  item: string;
  ability?: string;
  commanding?: boolean;
  reviving?: boolean;
}

export interface BattleRequest {
  rqid?: number;
  wait?: boolean;
  teamPreview?: boolean;
  maxChosenTeamSize?: number;
  forceSwitch?: boolean[];
  active?: RequestActive[];
  noCancel?: boolean;
  side: {
    name: string;
    id: SideID;
    pokemon: RequestPokemon[];
  };
}
