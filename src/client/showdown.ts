import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { PokemonSet } from '../ps.js';
import type { FormatInfo } from '../data/format.js';
import type { MetaSnapshot } from '../data/meta.js';
import { packTeam } from '../data/sets.js';
import type { Agent } from '../ai/agent.js';
import { PlayerSession } from '../battle/session.js';
import { toId } from '../battle/protocol.js';

export const DEFAULT_SERVER = 'wss://sim3.psim.us/showdown/websocket';
const LOGIN_URL = 'https://play.pokemonshowdown.com/action.php';

export interface ClientOptions {
  username: string;
  /** Omit for an unregistered name. */
  password?: string;
  server?: string;
  /** For local servers started with --no-security: take the name without an assertion. */
  skipLogin?: boolean;
  format: FormatInfo;
  team: PokemonSet[];
  makeAgent: () => Agent;
  meta?: MetaSnapshot;
  /** Accept incoming challenges in this format. */
  acceptChallenges?: boolean;
  /** Only accept challenges from these users (ids); empty = anyone. */
  allowFrom?: string[];
  log?: (message: string) => void;
}

export interface BattleOutcome {
  room: string;
  won: boolean | null;
  opponent: string;
}

function makeRng(): () => number {
  return Math.random;
}

/** Proxy agent from HTTPS_PROXY, unless the server is local or listed in NO_PROXY. */
function proxyAgentFor(url: string): HttpsProxyAgent<string> | undefined {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;
  const host = new URL(url).hostname;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(s => s.trim()).filter(Boolean);
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const excluded = noProxy.some(p => host === p || (p.startsWith('.') && host.endsWith(p)) || host.endsWith(`.${p}`));
  return local || excluded ? undefined : new HttpsProxyAgent(proxy);
}

/**
 * Minimal Pokémon Showdown client: logs in, accepts challenges / challenges users / searches the
 * ladder, and plays each battle with a fresh agent through the same session code used locally.
 */
export class ShowdownClient {
  private ws: WebSocket | null = null;
  private readonly sessions = new Map<string, PlayerSession>();
  private readonly opponents = new Map<string, string>();
  private loggedIn!: Promise<void>;
  private resolveLogin!: () => void;
  private readonly outcomeListeners: ((o: BattleOutcome) => void)[] = [];
  private readonly userid: string;

  constructor(private readonly options: ClientOptions) {
    this.userid = toId(options.username);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  async connect(): Promise<void> {
    const server = this.options.server ?? DEFAULT_SERVER;
    this.loggedIn = new Promise(resolve => (this.resolveLogin = resolve));
    this.ws = new WebSocket(server, { agent: proxyAgentFor(server) });
    this.ws.on('message', data => this.onMessage(data.toString()));
    this.ws.on('close', () => this.log('disconnected'));
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', () => resolve());
      this.ws!.once('error', reject);
    });
    await this.loggedIn;
    this.send('', `/utm ${packTeam(this.options.team)}`);
  }

  close(): void {
    this.ws?.close();
  }

  onOutcome(listener: (o: BattleOutcome) => void): void {
    this.outcomeListeners.push(listener);
  }

  private send(room: string, message: string): void {
    this.ws?.send(`${room}|${message}`);
  }

  /** Challenge a user to a game in the configured format. */
  challenge(user: string): void {
    this.send('', `/utm ${packTeam(this.options.team)}`);
    this.send('', `/challenge ${user}, ${this.options.format.id}`);
  }

  /** Queue for a ladder game. */
  searchLadder(): void {
    this.send('', `/utm ${packTeam(this.options.team)}`);
    this.send('', `/search ${this.options.format.id}`);
  }

  get activeBattles(): number {
    return this.sessions.size;
  }

  private async login(challstr: string): Promise<void> {
    const { username, password } = this.options;
    if (this.options.skipLogin) {
      this.send('', `/trn ${username},0,`);
      return;
    }
    const body = password ?
      new URLSearchParams({ act: 'login', name: username, pass: password, challstr }) :
      new URLSearchParams({ act: 'getassertion', userid: this.userid, challstr });
    const res = await fetch(LOGIN_URL, { method: 'POST', body });
    const text = await res.text();
    let assertion = text;
    if (password) {
      const json = JSON.parse(text.replace(/^\]/, '')) as { assertion?: string; actionsuccess?: boolean };
      if (!json.assertion) throw new Error(`Login failed for ${username}: ${text.slice(0, 200)}`);
      assertion = json.assertion;
    }
    if (!assertion || assertion.startsWith(';')) {
      throw new Error(`Login failed for ${username}: ${assertion.slice(0, 200) || 'empty assertion'} (registered names need a password)`);
    }
    this.send('', `/trn ${username},0,${assertion}`);
  }

  private onMessage(raw: string): void {
    if (process.env.PS_DEBUG) this.log(`<< ${raw.slice(0, 300)}`);
    let room = '';
    let lines = raw.split('\n');
    if (lines[0].startsWith('>')) {
      room = lines[0].slice(1);
      lines = lines.slice(1);
    }
    if (room.startsWith('battle-')) {
      this.onBattleMessage(room, lines);
      return;
    }
    for (const line of lines) {
      const parts = line.split('|');
      switch (parts[1]) {
        case 'challstr':
          this.login(parts.slice(2).join('|')).catch(err => {
            this.log((err as Error).message);
            this.close();
          });
          break;
        case 'updateuser':
          if (toId(parts[2]) === this.userid && (parts[3] === '1' || this.options.skipLogin)) {
            this.log(`logged in as ${parts[2].trim()}`);
            this.resolveLogin();
          }
          break;
        case 'updatechallenges':
          // Older servers summarise pending challenges in one message.
          for (const [user, format] of Object.entries((JSON.parse(parts.slice(2).join('|')) as { challengesFrom: Record<string, string> }).challengesFrom)) {
            this.onChallenge(user, format);
          }
          break;
        case 'pm': {
          // `|pm| SENDER| RECEIVER|/challenge FORMAT|...`
          const [sender, receiver, message = ''] = parts.slice(2).map(s => s.trim());
          if (message.startsWith('/challenge ') && toId(receiver) === this.userid && toId(sender) !== this.userid) {
            this.onChallenge(sender, message.slice('/challenge '.length).split('|')[0].trim());
          }
          break;
        }
        case 'popup':
          this.log(`server: ${parts.slice(2).join('|').replace(/\|\|/g, '\n')}`);
          break;
      }
    }
  }

  private onChallenge(user: string, format: string): void {
    if (!this.options.acceptChallenges) return;
    const allowed = !this.options.allowFrom?.length || this.options.allowFrom.includes(toId(user));
    if (toId(format) !== this.options.format.id || !allowed) {
      this.log(`declining ${format} challenge from ${user}`);
      this.send('', `/reject ${user}`);
      return;
    }
    this.log(`accepting challenge from ${user}`);
    this.send('', `/utm ${packTeam(this.options.team)}`);
    this.send('', `/accept ${user}`);
  }

  private onBattleMessage(room: string, lines: string[]): void {
    let session = this.sessions.get(room);
    if (!session && lines.some(l => l.startsWith('|init|battle'))) {
      session = new PlayerSession({
        agent: this.options.makeAgent(),
        format: this.options.format,
        team: this.options.team,
        meta: this.options.meta,
        rng: makeRng(),
        send: (choice, rqid) => this.send(room, `/choose ${choice}${rqid ? `|${rqid}` : ''}`),
        log: m => this.log(`[${room}] ${m}`),
      });
      this.sessions.set(room, session);
      this.send(room, '/timer on');
      this.log(`battle started: ${room}`);
    }
    if (!session) return;
    for (const line of lines) {
      if (line.startsWith('|player|')) {
        const name = line.split('|')[3];
        if (name && toId(name) !== this.userid) this.opponents.set(room, name);
      }
      // Open team sheets are offered at team preview; accept so both sides see sheets.
      if (line.startsWith('|uhtml|otsrequest|')) this.send(room, '/acceptopenteamsheets');
    }
    session.receive(lines.join('\n'));
    const end = lines.find(l => l.startsWith('|win|') || l === '|tie');
    if (end) {
      const won = end === '|tie' ? null : toId(end.slice(5)) === this.userid;
      const opponent = this.opponents.get(room) ?? '?';
      this.log(`battle ${room} vs ${opponent}: ${won === null ? 'tie' : won ? 'won' : 'lost'}`);
      this.sessions.delete(room);
      this.send(room, '/leave');
      for (const listener of this.outcomeListeners) listener({ room, won, opponent });
    }
  }
}
