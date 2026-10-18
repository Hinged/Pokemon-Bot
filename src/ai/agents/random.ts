import type { Agent, AgentContext } from '../agent.js';
import type { BattleRequest } from '../../battle/protocol.js';
import { randomChoice } from '../actions.js';

/** Picks uniformly among legal choices. The floor every other agent should beat. */
export class RandomAgent implements Agent {
  readonly name = 'random';

  chooseTeamPreview(ctx: AgentContext, request: BattleRequest): string {
    return randomChoice(request, ctx.rng);
  }

  chooseAction(ctx: AgentContext, request: BattleRequest): string {
    return randomChoice(request, ctx.rng);
  }
}
