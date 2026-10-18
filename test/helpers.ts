import type { PokemonSet } from '../src/ps.js';
import { loadMeta } from '../src/data/meta.js';
import { seededRandom } from '../src/ai/agent.js';
import { sampleMetaTeam } from '../src/teambuilder/sample.js';

export const meta = loadMeta();

export function metaTeams(seed: number): [PokemonSet[], PokemonSet[]] {
  const rng = seededRandom(seed);
  return [sampleMetaTeam(meta, rng), sampleMetaTeam(meta, rng)];
}
