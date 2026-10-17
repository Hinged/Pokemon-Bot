import type { PokemonSet } from '../../ps.js';
import { dex } from '../../data/format.js';
import { metaMon } from '../../data/meta.js';
import { completeSet, setFromMeta } from '../../data/sets.js';
import { defaultSpread } from '../../data/stats.js';
import type { BattleRequest } from '../../battle/protocol.js';
import { buildBelief, type Belief } from '../../battle/belief.js';
import { opponentOf, type AgentContext } from '../agent.js';
import { teamChoice } from '../actions.js';
import { planTeamPreview } from '../teampreview.js';

/** The opponent's six as best we know them: open team sheet, else usage-stats sets for previewed species. */
export function opponentTeam(ctx: AgentContext): PokemonSet[] {
  const foe = ctx.tracker.foe(ctx.side);
  return foe.team.map(mon => {
    if (mon.set) return completeSet(mon.set, ctx.meta);
    if (ctx.meta && metaMon(ctx.meta, mon.baseSpecies)) return setFromMeta(ctx.meta, mon.baseSpecies);
    const species = dex.species.get(mon.baseSpecies);
    const spread = defaultSpread(species.name);
    return {
      name: '', species: species.name, item: '', ability: species.abilities['0'], moves: mon.moves,
      nature: spread.nature, evs: spread.sps, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      level: 50, gender: '',
    } as PokemonSet;
  });
}

export function previewChoice(ctx: AgentContext): string {
  const plan = planTeamPreview(ctx.team, opponentTeam(ctx), {
    pick: ctx.format.pick,
    activeCount: ctx.format.gameType === 'doubles' ? 2 : 1,
    meta: ctx.meta,
  });
  ctx.log?.(`team preview: ${plan.order.slice(0, ctx.format.pick).map(i => ctx.team[i].species).join(', ')}`);
  for (const note of plan.notes) ctx.log?.(note);
  return teamChoice(plan.order);
}

export function belief(ctx: AgentContext, request: BattleRequest, replacements?: (string | null)[]): Belief {
  return buildBelief(request, {
    format: ctx.format,
    side: ctx.side,
    team: ctx.team,
    tracker: ctx.tracker,
    meta: ctx.meta,
    replacements,
  });
}

export { opponentOf };
