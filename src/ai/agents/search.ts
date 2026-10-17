import type { Agent, AgentContext } from '../agent.js';
import { parseIdent, type BattleRequest } from '../../battle/protocol.js';
import { choiceString, combos, fixForcedSwitch, slotOptions } from '../actions.js';
import { searchTurn, type SearchOptions, type SearchResult } from '../search.js';
import { belief, previewChoice } from './common.js';

export interface SearchAgentOptions {
  search?: Partial<SearchOptions>;
  /** Called with each turn's analysis (for advisors and logging). */
  onSearch?: (result: SearchResult, request: BattleRequest) => void;
}

/**
 * Looks one turn ahead by simulating every pruned pair of joint actions in the real simulator,
 * then plays the equilibrium of the resulting matrix game.
 */
export class SearchAgent implements Agent {
  readonly name = 'search';

  constructor(private readonly options: SearchAgentOptions = {}) {}

  chooseTeamPreview(ctx: AgentContext): string {
    return previewChoice(ctx);
  }

  chooseAction(ctx: AgentContext, request: BattleRequest): string {
    if (request.forceSwitch) return this.chooseSwitch(ctx, request);
    const b = belief(ctx, request);
    const result = searchTurn(b, request, ctx.rng, this.options.search);
    this.options.onSearch?.(result, request);
    ctx.log?.(`turn ${ctx.tracker.turn}: ${result.choice} (value ${result.value.toFixed(2)}, ${result.simulations} sims, ${result.elapsedMs.toFixed(0)}ms)`);
    return result.choice;
  }

  /** Evaluates each replacement by searching the turn that would follow it. */
  private chooseSwitch(ctx: AgentContext, request: BattleRequest): string {
    const perSlot = slotOptions(request);
    const candidates = new Map<string, ReturnType<typeof fixForcedSwitch>>();
    for (const combo of combos(perSlot)) {
      const fixed = fixForcedSwitch(combo, perSlot.flat());
      candidates.set(choiceString(fixed), fixed);
    }
    if (candidates.size <= 1) return [...candidates.keys()][0] ?? 'pass';

    let best = { choice: '', value: -Infinity };
    for (const [choice, combo] of candidates) {
      const replacements = combo.map(opt =>
        opt.switchIndex ? parseIdent(request.side.pokemon[opt.switchIndex - 1].ident).name : null);
      try {
        const b = belief(ctx, request, replacements);
        const hypothetical = b.battle[ctx.side].activeRequest as unknown as BattleRequest;
        if (!hypothetical?.active) continue;
        const result = searchTurn(b, hypothetical, ctx.rng, {
          ourPerSlot: 4, foePerSlot: 4, ourJoint: 12, foeJoint: 10, samples: 1, play: 'best', ...this.options.search,
          timeBudgetMs: 1500,
        });
        if (result.value > best.value) best = { choice, value: result.value };
      } catch (err) {
        ctx.log?.(`switch lookahead failed for ${choice}: ${(err as Error).message}`);
      }
    }
    ctx.log?.(`switch: ${best.choice || 'fallback'} (value ${best.value.toFixed(2)})`);
    return best.choice || [...candidates.keys()][0];
  }
}
