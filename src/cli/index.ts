#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_FORMAT, FORMATS, getFormat, dex } from '../data/format.js';
import { fetchMeta, loadMeta, META_DIR, metaMon } from '../data/meta.js';
import { exportTeam, megaForm, parseTeam, setFromMeta, completeSet, type PokemonSet } from '../data/sets.js';
import { calcDamage, speedOf } from '../data/damage.js';
import { validateSps, STAT_IDS } from '../data/stats.js';
import { TeamValidator } from '../ps.js';
import { playMatch, replayHtml } from '../battle/runner.js';
import { seededRandom } from '../ai/agent.js';
import { makeAgent } from '../ai/agents/index.js';
import { planTeamPreview } from '../ai/teampreview.js';
import { buildTeams } from '../teambuilder/builder.js';
import { sampleMetaTeam } from '../teambuilder/sample.js';
import { ShowdownClient } from '../client/showdown.js';

const HELP = `champ — Pokémon Champions team builder and battle AI

Usage: npm run champ -- <command> [options]

Commands
  build      Build teams for the current meta
               --core "A,B"     Pokémon that must be on the team
               --exclude "C,D"  Pokémon to leave out
               --results N      number of teams to show (default 3)
               --simulate N     test the top team in N games vs sampled meta teams
               --out FILE       save the top team (Showdown export format)
  preview    Team preview advice: what to bring and lead
               --team FILE      your team (Showdown export)
               --opponent "A, B, C, D, E, F" | FILE
  calc       Damage calc with usage-stats sets (or --team FILE sets)
               champ calc "Garchomp-Mega-Z" "Earth Power" "Gholdengo"
  battle     Play local games between agents
               --team1 FILE|meta  --team2 FILE|meta  (meta = sample a ladder team)
               --agent1 search|greedy|random  --agent2 ...
               --games N  --budget MS  --replays DIR  --verbose
  validate   Check a team: Stat Points, Item/Species Clause, simulator legality
               --team FILE
  meta       Usage stats: "meta top [--n 30]" or "meta update [--month YYYY-MM] [--cutoff 1630]"
  play       Play on Pokémon Showdown with the search agent
               --user NAME  (password from PS_PASSWORD; omit for an unregistered name)
               --accept [--from user1,user2]   accept challenges
               --challenge USER                challenge a user
               --ladder N                      play N ladder games
               --team FILE  --budget MS
               --server URL --no-login         use a local server (started with --no-security)

Common options: --format ID (default ${DEFAULT_FORMAT}; known: ${Object.keys(FORMATS).join(', ')})
`;

function readTeam(path: string): PokemonSet[] {
  if (!existsSync(path)) throw new Error(`Team file not found: ${path}`);
  return parseTeam(readFileSync(path, 'utf8'));
}

function pad(text: string | number, width: number): string {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function speciesList(text: string): string[] {
  return text.split(/[,\n/]/).map(s => s.trim()).filter(Boolean);
}

async function cmdBuild(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      format: { type: 'string', default: DEFAULT_FORMAT },
      core: { type: 'string' },
      exclude: { type: 'string' },
      results: { type: 'string', default: '3' },
      simulate: { type: 'string' },
      out: { type: 'string' },
      pool: { type: 'string', default: '60' },
    },
  });
  const format = getFormat(values.format);
  const meta = loadMeta(format.id);
  console.log(`Building for ${format.name} (usage: ${meta.month}, ${meta.battles.toLocaleString()} battles, ${meta.cutoff}+ rating)\n`);
  const reports = buildTeams({
    meta,
    core: values.core ? speciesList(values.core) : [],
    exclude: values.exclude ? speciesList(values.exclude) : [],
    results: Number(values.results),
    poolSize: Number(values.pool),
  });
  reports.forEach((r, i) => {
    console.log(`=== Team ${i + 1}: ${r.members.join(', ')}  (score ${r.score})`);
    console.log(`Roles: ${r.roles.join(', ') || '—'}`);
    console.log(`Shared weaknesses: ${r.sharedWeaknesses.join(', ') || 'none'}`);
    console.log(`Speed: ${r.speedTiers.map(s => `${s.species} ${s.speed}`).join(' > ')}`);
    const weak = r.threats.filter(t => t.score < 0.2).slice(0, 6);
    if (weak.length) console.log(`Watch out for: ${weak.map(t => `${t.threat} (${(t.usage * 100).toFixed(0)}%)`).join(', ')}`);
    console.log('');
    console.log(exportTeam(r.team));
    console.log('');
  });
  if (values.out && reports[0]) {
    writeFileSync(values.out, exportTeam(reports[0].team) + '\n');
    console.log(`Saved team 1 to ${values.out}`);
  }
  if (values.simulate && reports[0]) {
    const games = Number(values.simulate);
    console.log(`Simulating ${games} games of team 1 vs sampled meta teams (greedy agents)...`);
    let wins = 0;
    for (let g = 0; g < games; g++) {
      const rng = seededRandom(500 + g);
      const opponent = sampleMetaTeam(meta, rng);
      const r = await playMatch({
        format, meta, seed: g, teams: [reports[0].team, opponent],
        agents: [makeAgent('greedy'), makeAgent('greedy')], names: ['built', 'meta'],
      });
      if (r.winner === 0) wins++;
      else if (r.winner === null) wins += 0.5;
    }
    console.log(`Win rate vs meta teams: ${((100 * wins) / games).toFixed(1)}% (${wins}/${games})`);
  }
}

function opponentSets(spec: string, meta: ReturnType<typeof loadMeta>): PokemonSet[] {
  if (existsSync(spec)) return readTeam(spec).map(s => completeSet(s, meta));
  return speciesList(spec).map(name => {
    const entry = metaMon(meta, name) ?? meta.mons.find(m => dex.species.get(m.species).baseSpecies === dex.species.get(name).name && dex.species.get(m.species).isMega);
    if (!entry) throw new Error(`No usage data for ${name}; pass a team file instead`);
    return setFromMeta(meta, entry.species);
  });
}

function cmdPreview(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      format: { type: 'string', default: DEFAULT_FORMAT },
      team: { type: 'string' },
      opponent: { type: 'string' },
    },
  });
  if (!values.team || !values.opponent) throw new Error('preview needs --team FILE and --opponent "A, B, ..."');
  const format = getFormat(values.format);
  const meta = loadMeta(format.id);
  const ours = readTeam(values.team);
  const theirs = opponentSets(values.opponent, meta);
  const activeCount = format.gameType === 'doubles' ? 2 : 1;
  const plan = planTeamPreview(ours, theirs, { pick: format.pick, activeCount, meta });
  const name = (s: PokemonSet) => megaForm(s) ?? s.species;
  console.log(`Lead:  ${plan.order.slice(0, activeCount).map(i => name(ours[i])).join(' + ')}`);
  console.log(`Back:  ${plan.order.slice(activeCount, format.pick).map(i => name(ours[i])).join(', ')}`);
  console.log(`Bench: ${plan.order.slice(format.pick).map(i => name(ours[i])).join(', ')}\n`);
  console.log('1-on-1 matchups (+ good for you, - bad), with best move damage each way:');
  console.log(pad('', 18) + theirs.map(t => pad(name(t).slice(0, 15), 16)).join(''));
  ours.forEach((o, i) => {
    const cells = theirs.map((_, j) => {
      const m = plan.matchups[i][j];
      const sign = m.score >= 0 ? '+' : '';
      return pad(`${sign}${m.score.toFixed(1)} ${Math.round(m.ourBest?.pct ?? 0)}/${Math.round(m.theirBest?.pct ?? 0)}%`, 16);
    });
    console.log(pad(name(o).slice(0, 17), 18) + cells.join(''));
  });
  console.log('\nSpeed tiers (Mega forms where applicable):');
  const speeds = [
    ...ours.map(s => ({ who: 'you', species: name(s), speed: speedOf({ set: s, mega: !!megaForm(s) }) })),
    ...theirs.map(s => ({ who: 'opp', species: name(s), speed: speedOf({ set: s, mega: !!megaForm(s) }) })),
  ].sort((a, b) => b.speed - a.speed);
  console.log(speeds.map(s => `${s.speed} ${s.species} (${s.who})`).join('\n'));
  console.log('\nOpponent Stat Points are hidden; their spreads above are the most common ones on the ladder.');
  for (const note of plan.notes) console.log(note);
}

function cmdCalc(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { format: { type: 'string', default: DEFAULT_FORMAT }, team: { type: 'string' }, nomega: { type: 'boolean' } },
  });
  const [attackerName, moveName, defenderName] = positionals;
  if (!attackerName || !moveName || !defenderName) throw new Error('usage: champ calc ATTACKER MOVE DEFENDER');
  const meta = loadMeta(getFormat(values.format).id);
  const fromTeam = values.team ? readTeam(values.team) : [];
  const find = (name: string) => fromTeam.find(s => dex.species.get(s.species).id === dex.species.get(name).id) ?? opponentSets(name, meta)[0];
  const attacker = find(attackerName);
  const defender = find(defenderName);
  const r = calcDamage({ set: attacker, mega: !values.nomega }, { set: defender, mega: !values.nomega }, moveName);
  console.log(r.desc || `${r.move} does no damage.`);
}

async function cmdBattle(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      format: { type: 'string', default: DEFAULT_FORMAT },
      team1: { type: 'string', default: 'meta' },
      team2: { type: 'string', default: 'meta' },
      agent1: { type: 'string', default: 'search' },
      agent2: { type: 'string', default: 'greedy' },
      games: { type: 'string', default: '4' },
      budget: { type: 'string', default: '2000' },
      seed: { type: 'string', default: '1' },
      replays: { type: 'string' },
      verbose: { type: 'boolean', default: false },
    },
  });
  const format = getFormat(values.format);
  const meta = loadMeta(format.id);
  const games = Number(values.games);
  const budget = Number(values.budget);
  let score = 0;
  for (let g = 0; g < games; g++) {
    const rng = seededRandom(Number(values.seed) * 1000 + g);
    const team = (spec: string) => (spec === 'meta' ? sampleMetaTeam(meta, rng) : readTeam(spec));
    const teams: [PokemonSet[], PokemonSet[]] = [team(values.team1), team(values.team2)];
    const names: [string, string] = [`${values.agent1} (1)`, `${values.agent2} (2)`];
    const start = performance.now();
    const r = await playMatch({
      format, meta, teams, names, seed: Number(values.seed) * 1000 + g, verbose: values.verbose,
      agents: [makeAgent(values.agent1, { timeBudgetMs: budget }), makeAgent(values.agent2, { timeBudgetMs: budget })],
    });
    if (r.winner === 0) score++;
    else if (r.winner === null) score += 0.5;
    const result = r.winner === null ? 'tie' : `${names[r.winner]} wins`;
    console.log(`Game ${g + 1}: ${result} in ${r.turns} turns (${((performance.now() - start) / 1000).toFixed(1)}s)`);
    console.log(`  ${names[0]}: ${teams[0].map(s => megaForm(s) ?? s.species).join(', ')}`);
    console.log(`  ${names[1]}: ${teams[1].map(s => megaForm(s) ?? s.species).join(', ')}`);
    if (r.errors.length) console.log(`  ${r.errors.length} protocol errors, first: ${r.errors[0]}`);
    if (values.replays) {
      mkdirSync(values.replays, { recursive: true });
      const file = join(values.replays, `game-${g + 1}.html`);
      writeFileSync(file, replayHtml(r.log, `${names[0]} vs ${names[1]} — game ${g + 1}`));
      console.log(`  replay: ${file}`);
    }
  }
  console.log(`\n${values.agent1} (1) scored ${score}/${games} against ${values.agent2} (2)`);
}

function cmdValidate(args: string[]): void {
  const { values } = parseArgs({ args, options: { format: { type: 'string', default: DEFAULT_FORMAT }, team: { type: 'string' } } });
  if (!values.team) throw new Error('validate needs --team FILE');
  const format = getFormat(values.format);
  const team = readTeam(values.team);
  const problems: string[] = [];
  team.forEach(set => {
    for (const p of validateSps(set.evs)) problems.push(`${set.species}: ${p}`);
    if (STAT_IDS.some(s => (set.ivs?.[s] ?? 31) !== 31)) problems.push(`${set.species}: IVs are fixed at 31 in Champions`);
  });
  const warnings: string[] = [];
  const newer = format.simFormat !== format.id;
  const validator = TeamValidator.get(format.simFormat);
  for (const problem of validator.validateTeam(team) ?? []) {
    // The npm simulator can trail the live regulation; additions it doesn't know about aren't errors.
    if (newer && /does not exist|can't learn|is unobtainable|is banned/.test(problem)) warnings.push(problem);
    else problems.push(problem);
  }
  if (warnings.length) {
    console.log(`Not in the bundled ${format.simFormat} data (likely new in ${format.name}; verify in-game):`);
    for (const w of warnings) console.log(`  ~ ${w}`);
  }
  if (problems.length) {
    console.log(`${problems.length} problem(s):`);
    for (const p of problems) console.log(`- ${p}`);
    process.exitCode = 1;
  } else {
    console.log('Team is valid.');
  }
}

async function cmdMeta(args: string[]): Promise<void> {
  const [sub = 'top', ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      format: { type: 'string', default: DEFAULT_FORMAT },
      n: { type: 'string', default: '30' },
      month: { type: 'string' },
      cutoff: { type: 'string', default: '1630' },
    },
  });
  const format = getFormat(values.format);
  if (sub === 'update') {
    const now = new Date();
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const month = values.month ?? `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
    console.log(`Fetching ${format.statsId} usage for ${month} (${values.cutoff}+)...`);
    const snapshot = await fetchMeta(format.id, month, Number(values.cutoff));
    mkdirSync(META_DIR, { recursive: true });
    const file = join(META_DIR, `${format.statsId}.json`);
    writeFileSync(file, JSON.stringify(snapshot));
    console.log(`Saved ${snapshot.mons.length} Pokémon from ${snapshot.battles.toLocaleString()} battles to ${file}`);
    return;
  }
  const meta = loadMeta(format.id);
  console.log(`${format.name} — ${meta.month}, ${meta.battles.toLocaleString()} battles at ${meta.cutoff}+\n`);
  meta.mons.slice(0, Number(values.n)).forEach((m, i) => {
    const item = m.items[0] ? dex.items.get(m.items[0][0]).name : '';
    const moves = m.moves.slice(0, 4).map(([id]) => dex.moves.get(id).name).join(', ');
    console.log(`${pad(i + 1, 4)}${pad(m.species, 20)}${pad((m.usage * 100).toFixed(1) + '%', 8)}${pad(item, 16)}${moves}`);
  });
}

async function cmdPlay(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      format: { type: 'string', default: DEFAULT_FORMAT },
      user: { type: 'string' },
      team: { type: 'string' },
      accept: { type: 'boolean', default: false },
      from: { type: 'string' },
      challenge: { type: 'string' },
      ladder: { type: 'string' },
      budget: { type: 'string', default: '8000' },
      server: { type: 'string' },
      'no-login': { type: 'boolean', default: false },
    },
  });
  if (!values.user) throw new Error('play needs --user NAME (and PS_PASSWORD in the environment for registered names)');
  if (!values.team) throw new Error('play needs --team FILE');
  const format = getFormat(values.format);
  const meta = loadMeta(format.id);
  const team = readTeam(values.team);
  const budget = Number(values.budget);
  const client = new ShowdownClient({
    username: values.user,
    password: process.env.PS_PASSWORD,
    server: values.server,
    skipLogin: values['no-login'],
    format,
    team,
    meta,
    makeAgent: () => makeAgent('search', { timeBudgetMs: budget }),
    acceptChallenges: values.accept,
    allowFrom: values.from ? values.from.split(',').map(s => s.trim().toLowerCase()) : [],
    log: m => console.log(m),
  });
  await client.connect();
  let ladderLeft = values.ladder ? Number(values.ladder) : 0;
  let record = { wins: 0, losses: 0, ties: 0 };
  client.onOutcome(o => {
    if (o.won === true) record.wins++;
    else if (o.won === false) record.losses++;
    else record.ties++;
    console.log(`Record: ${record.wins}-${record.losses}${record.ties ? `-${record.ties}` : ''}`);
    if (ladderLeft > 0) {
      ladderLeft--;
      if (ladderLeft > 0) client.searchLadder();
      else client.close();
    } else if (!values.accept) {
      client.close();
    }
  });
  if (values.challenge) client.challenge(values.challenge);
  if (ladderLeft > 0) client.searchLadder();
  if (values.accept) console.log(`Waiting for ${format.id} challenges... (Ctrl+C to stop)`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'build': return cmdBuild(rest);
    case 'preview': return cmdPreview(rest);
    case 'calc': return cmdCalc(rest);
    case 'battle': return cmdBattle(rest);
    case 'validate': return cmdValidate(rest);
    case 'meta': return cmdMeta(rest);
    case 'play': return cmdPlay(rest);
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch(err => {
  console.error((err as Error).message);
  process.exitCode = 1;
});

