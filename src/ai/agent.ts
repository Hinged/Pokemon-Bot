import type { PokemonSet } from '../ps.js';
import type { FormatInfo } from '../data/format.js';
import type { MetaSnapshot } from '../data/meta.js';
import type { BattleRequest, SideID } from '../battle/protocol.js';
import type { BattleTracker } from '../battle/tracker.js';

/** Everything an agent may legitimately know when deciding. */
export interface AgentContext {
  format: FormatInfo;
  side: SideID;
  /** Our six, with full Stat Point spreads. */
  team: PokemonSet[];
  tracker: BattleTracker;
  meta?: MetaSnapshot;
  rng: () => number;
  log?: (message: string) => void;
}

export interface Agent {
  readonly name: string;
  /** Returns e.g. `team 3142` (first N are leads, first `pick` are brought). */
  chooseTeamPreview(ctx: AgentContext, request: BattleRequest): string | Promise<string>;
  /** Returns a full choice string, e.g. `move 1 2 mega, switch 3`. */
  chooseAction(ctx: AgentContext, request: BattleRequest): string | Promise<string>;
}

export function opponentOf(side: SideID): SideID {
  return side === 'p1' ? 'p2' : 'p1';
}

/** Deterministic PRNG (mulberry32) so games and decisions are reproducible from a seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
