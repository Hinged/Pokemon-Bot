/**
 * End-to-end check of the Showdown client: two bot accounts battle each other on a LOCAL server.
 *
 *   node node_modules/pokemon-showdown/pokemon-showdown start 8000 --no-security
 *   npx tsx scripts/selfplay-online.ts --port 8000
 *
 * (The npm simulator knows Reg M-B, so the teams are sampled from M-C usage and filtered to M-B legality.)
 */
import { parseArgs } from 'node:util';
import { TeamValidator, type PokemonSet } from '../src/ps.js';
import { getFormat } from '../src/data/format.js';
import { loadMeta } from '../src/data/meta.js';
import { seededRandom } from '../src/ai/agent.js';
import { sampleMetaTeam } from '../src/teambuilder/sample.js';
import { makeAgent } from '../src/ai/agents/index.js';
import { ShowdownClient } from '../src/client/showdown.js';

const { values } = parseArgs({ options: { port: { type: 'string', default: '8000' }, seed: { type: 'string', default: '42' } } });
const format = getFormat('gen9championsvgc2026regmb');
const meta = loadMeta('gen9championsvgc2026regmc');
const validator = TeamValidator.get(format.simFormat);
const rng = seededRandom(Number(values.seed));
const legalTeam = (): PokemonSet[] => {
  for (let i = 0; i < 1000; i++) {
    const team = sampleMetaTeam(meta, rng);
    if (!validator.validateTeam(team)) return team;
  }
  throw new Error('could not sample a legal team');
};

const server = `ws://localhost:${values.port}/showdown/websocket`;
const client = (name: string, agent: string, accept: boolean) => new ShowdownClient({
  username: name, server, skipLogin: true, format, team: legalTeam(), meta, acceptChallenges: accept,
  makeAgent: () => makeAgent(agent, { timeBudgetMs: 1000 }),
  log: m => console.log(`[${name}] ${m}`),
});

const searcher = client('ChampSearch', 'search', false);
const greedy = client('ChampGreedy', 'greedy', true);
await greedy.connect();
await searcher.connect();
const outcome = new Promise<void>(resolve => searcher.onOutcome(() => resolve()));
searcher.challenge('ChampGreedy');
await outcome;
searcher.close();
greedy.close();
