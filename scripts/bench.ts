/**
 * Head-to-head benchmark: paired games on sampled meta teams (each team pairing is played twice
 * with sides swapped, which cancels out team strength).
 *
 *   npx tsx scripts/bench.ts search greedy --pairs 10 --shard 0
 */
import { parseArgs } from 'node:util';
import { loadMeta } from '../src/data/meta.js';
import { getFormat } from '../src/data/format.js';
import { playMatch } from '../src/battle/runner.js';
import { seededRandom } from '../src/ai/agent.js';
import { makeAgent } from '../src/ai/agents/index.js';
import { sampleMetaTeam } from '../src/teambuilder/sample.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pairs: { type: 'string', default: '5' },
    shard: { type: 'string', default: '0' },
    budget: { type: 'string', default: '1500' },
    format: { type: 'string', default: 'gen9championsvgc2026regmc' },
  },
});
const [a = 'search', b = 'greedy'] = positionals;
const format = getFormat(values.format);
const meta = loadMeta(format.id);
const pairs = Number(values.pairs);
const shard = Number(values.shard);
const budget = Number(values.budget);
let score = 0, games = 0, ties = 0, turns = 0;
const errors: string[] = [];
const start = performance.now();
for (let p = 0; p < pairs; p++) {
  const seed = 1000 * shard + p;
  const rng = seededRandom(seed);
  const teams = [sampleMetaTeam(meta, rng), sampleMetaTeam(meta, rng)] as const;
  for (const swap of [false, true]) {
    const agents = [makeAgent(a, { timeBudgetMs: budget }), makeAgent(b, { timeBudgetMs: budget })] as const;
    const r = await playMatch({
      format, meta, seed: seed * 2 + (swap ? 1 : 0),
      teams: swap ? [teams[1], teams[0]] : [teams[0], teams[1]],
      agents: [agents[0], agents[1]],
    });
    games++;
    turns += r.turns;
    if (r.winner === null) { ties++; score += 0.5; } else if (r.winner === 0) score++;
    errors.push(...r.errors);
  }
}
console.log(JSON.stringify({ a, b, shard, games, aScore: score, ties, avgTurns: +(turns / games).toFixed(1), secPerGame: +((performance.now() - start) / games / 1000).toFixed(1), errors: errors.length }));
if (errors.length) console.error(errors.slice(0, 5).join('\n'));
