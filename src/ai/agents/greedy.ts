import type { Agent, AgentContext } from '../agent.js';
import type { BattleRequest } from '../../battle/protocol.js';
import { choiceString, fixForcedSwitch, isValidCombo, slotOptions, type SlotOption } from '../actions.js';
import { Heuristics } from '../heuristics.js';
import { belief, opponentOf, previewChoice } from './common.js';

/**
 * Picks each slot's best action by damage calc and rules of thumb, without looking ahead or
 * modelling the opponent. A useful sparring partner and baseline for the search agent.
 */
export class GreedyAgent implements Agent {
  readonly name = 'greedy';

  chooseTeamPreview(ctx: AgentContext): string {
    return previewChoice(ctx);
  }

  chooseAction(ctx: AgentContext, request: BattleRequest): string {
    const b = belief(ctx, request);
    const heuristics = new Heuristics(b.battle);
    const foeAlive = b.battle[opponentOf(ctx.side)].active.map(p => !!p && !p.fainted && p.hp > 0);
    const perSlot = slotOptions(request, { foeAlive });

    if (request.forceSwitch) {
      const picks = perSlot.map(options => {
        const scored = options.map(opt => {
          if (opt.kind !== 'switch') return { opt, score: -1 };
          const incoming = b.battle[ctx.side].pokemon.find(p => p.fullname === request.side.pokemon[opt.switchIndex! - 1].ident);
          return { opt, score: incoming ? -heuristics.threatTo(incoming, ctx.side) + incoming.hp / incoming.maxhp : 0 };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored[0].opt;
      });
      return choiceString(fixForcedSwitch(picks, perSlot.flat()));
    }

    const ranked = heuristics.rank(ctx.side, perSlot, request);
    const choice: SlotOption[] = ranked.map(options => options[0].opt);
    if (!isValidCombo(choice)) {
      // Two megas or the same switch target: keep the best slot's pick, re-pick the other.
      const order = ranked.map((options, slot) => ({ slot, score: options[0].score })).sort((a, b) => b.score - a.score);
      for (const { slot } of order.slice(1)) {
        const alt = ranked[slot].find(r => isValidCombo(choice.map((o, i) => (i === slot ? r.opt : o))));
        if (alt) choice[slot] = alt.opt;
      }
    }
    return choiceString(choice);
  }
}
