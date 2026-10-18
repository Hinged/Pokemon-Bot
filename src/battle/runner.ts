import ps from 'pokemon-showdown';
import { makeSeed, type Battle, type PokemonSet, type PRNGSeed } from '../ps.js';
import type { FormatInfo } from '../data/format.js';
import type { MetaSnapshot } from '../data/meta.js';
import { packTeam, teamSheet } from '../data/sets.js';
import { seededRandom, type Agent } from '../ai/agent.js';
import type { BattleRequest } from './protocol.js';
import { PlayerSession } from './session.js';

export interface MatchOptions {
  format: FormatInfo;
  teams: [PokemonSet[], PokemonSet[]];
  agents: [Agent, Agent];
  names?: [string, string];
  seed?: number;
  meta?: MetaSnapshot;
  /** Give each side the other's team sheet (Champions VGC uses open team sheets). */
  openTeamSheets?: boolean;
  /** Declare a tie after this many turns. */
  maxTurns?: number;
  verbose?: boolean;
  /** Test hook: called before each decision with the true simulator state. */
  onDecision?: (side: 'p1' | 'p2', request: BattleRequest, session: PlayerSession, truth: Battle) => void;
}

export interface MatchResult {
  /** 0 or 1 for the winning side, null for a tie. */
  winner: 0 | 1 | null;
  turns: number;
  /** Full spectator log (for replays). */
  log: string;
  errors: string[];
}

function simSeed(seed: number): PRNGSeed {
  const rand = seededRandom(seed);
  return makeSeed([0, 0, 0, 0].map(() => rand() * 0x10000));
}

/** Plays one game between two agents in the local simulator. */
export async function playMatch(options: MatchOptions): Promise<MatchResult> {
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
  const names = options.names ?? [options.agents[0].name, options.agents[1].name];
  // The winner is reported by name, so the two must differ.
  if (names[0] === names[1]) names[1] = `${names[1]} 2`;
  const stream = new ps.BattleStream();
  const streams = ps.getPlayerStreams(stream);
  const sides = ['p1', 'p2'] as const;
  let ended = false;

  const sessions: PlayerSession[] = [];
  const agents = options.agents.map((agent, i): Agent => {
    const hook = options.onDecision;
    if (!hook) return agent;
    return {
      name: agent.name,
      chooseTeamPreview: (ctx, request) => agent.chooseTeamPreview(ctx, request),
      chooseAction: (ctx, request) => {
        if (stream.battle) hook(sides[i], request, sessions[i], stream.battle);
        return agent.chooseAction(ctx, request);
      },
    };
  });
  sessions.push(...sides.map((side, i) => {
    const playerStream = streams[side];
    return new PlayerSession({
      agent: agents[i],
      format: options.format,
      team: options.teams[i],
      meta: options.meta,
      rng: seededRandom(seed * 2 + i + 1),
      side,
      send: choice => {
        if (!ended) void playerStream.write(choice);
      },
      log: options.verbose ? (m: string) => console.error(`[${names[i]}] ${m}`) : undefined,
    });
  }));
  if (options.openTeamSheets ?? true) {
    sessions[0].tracker.setTeam('p2', teamSheet(options.teams[1]));
    sessions[1].tracker.setTeam('p1', teamSheet(options.teams[0]));
  }

  const maxTurns = options.maxTurns ?? 60;
  const logLines: string[] = [];
  let turns = 0;
  let winner: 0 | 1 | null = null;

  const done = (async () => {
    for await (const chunk of streams.omniscient) {
      for (const line of chunk.split('\n')) {
        logLines.push(line);
        if (line.startsWith('|turn|')) {
          turns = Number(line.slice(6));
          if (turns > maxTurns) void streams.omniscient.write('>forcetie');
        } else if (line.startsWith('|win|')) {
          winner = line.slice(5) === names[0] ? 0 : 1;
          ended = true;
        } else if (line === '|tie') {
          ended = true;
        }
      }
      if (ended) break;
    }
  })();

  sides.forEach((side, i) => {
    void (async () => {
      for await (const chunk of streams[side]) sessions[i].receive(chunk);
    })();
  });

  const spec = { formatid: options.format.simFormat, seed: simSeed(seed) };
  void streams.omniscient.write(
    `>start ${JSON.stringify(spec)}\n` +
    `>player p1 ${JSON.stringify({ name: names[0], team: packTeam(options.teams[0]) })}\n` +
    `>player p2 ${JSON.stringify({ name: names[1], team: packTeam(options.teams[1]) })}`,
  );

  await done;
  ended = true;
  void stream.writeEnd();
  return {
    winner,
    turns,
    log: logLines.join('\n'),
    errors: sessions.flatMap((s, i) => s.errors.map(e => `${names[i]}: ${e}`)),
  };
}

/** Wraps a battle log in Showdown's replay viewer so it can be opened in a browser. */
export function replayHtml(log: string, title: string): string {
  const safe = log.replace(/<\//g, '<\\/');
  return `<!DOCTYPE html>
<meta charset="utf-8" />
<title>${title.replace(/</g, '&lt;')}</title>
<div class="wrapper replay-wrapper" style="max-width:1180px;margin:0 auto">
<div class="battle"></div><div class="battle-log"></div><div class="replay-controls"></div><div class="replay-controls-2"></div>
<script type="text/plain" class="battle-log-data">${safe}</script>
</div>
<script src="https://play.pokemonshowdown.com/js/replay-embed.js"></script>
`;
}
