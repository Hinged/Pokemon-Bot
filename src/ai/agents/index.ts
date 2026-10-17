import type { Agent } from '../agent.js';
import type { SearchOptions } from '../search.js';
import { GreedyAgent } from './greedy.js';
import { RandomAgent } from './random.js';
import { SearchAgent } from './search.js';

export { GreedyAgent, RandomAgent, SearchAgent };

export const AGENT_NAMES = ['search', 'greedy', 'random'] as const;

export function makeAgent(name: string, search: Partial<SearchOptions> = {}): Agent {
  switch (name) {
    case 'search': return new SearchAgent({ search });
    case 'greedy': return new GreedyAgent();
    case 'random': return new RandomAgent();
    default: throw new Error(`Unknown agent "${name}" (choose from ${AGENT_NAMES.join(', ')})`);
  }
}
