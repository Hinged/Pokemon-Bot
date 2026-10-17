import type { PokemonSet } from '../ps.js';
import type { FormatInfo } from '../data/format.js';
import type { MetaSnapshot } from '../data/meta.js';
import type { Agent, AgentContext } from '../ai/agent.js';
import { randomChoice } from '../ai/actions.js';
import type { BattleRequest, SideID } from './protocol.js';
import { BattleTracker } from './tracker.js';

export interface SessionOptions {
  agent: Agent;
  format: FormatInfo;
  team: PokemonSet[];
  meta?: MetaSnapshot;
  rng: () => number;
  /** Sends a choice to the battle (`rqid` is echoed back for the online server). */
  send: (choice: string, rqid?: number) => void;
  log?: (message: string) => void;
  /** Known before the battle starts (local play); online play learns it from the first request. */
  side?: SideID;
}

/**
 * One player's view of one battle: feeds protocol into a tracker, holds the pending request, and
 * asks the agent for a decision once the tracker has caught up with that request.
 */
export class PlayerSession {
  readonly tracker = new BattleTracker();
  private pending: BattleRequest | null = null;
  /** Last request answered, for resending after an invalid choice. */
  private lastRequest: BattleRequest | null = null;
  private decidedTurn = -1;
  private deciding = false;
  private retries = 0;
  private teamRegistered = false;
  side: SideID | null;
  errors: string[] = [];

  constructor(private readonly options: SessionOptions) {
    this.side = options.side ?? null;
    if (this.side) this.registerTeam(this.side);
  }

  private registerTeam(side: SideID): void {
    if (this.teamRegistered) return;
    this.teamRegistered = true;
    this.tracker.setTeam(side, this.options.team);
  }

  get context(): AgentContext {
    if (!this.side) throw new Error('Side not known yet');
    return {
      format: this.options.format,
      side: this.side,
      team: this.options.team,
      tracker: this.tracker,
      meta: this.options.meta,
      rng: this.options.rng,
      log: this.options.log,
    };
  }

  /** Feeds one chunk of protocol for this player. */
  receive(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('|request|')) {
        const json = line.slice('|request|'.length);
        if (!json) continue;
        const request = JSON.parse(json) as BattleRequest;
        if (!this.side) {
          this.side = request.side.id;
          this.registerTeam(this.side);
        }
        this.tracker.syncRequest(request);
        this.pending = request.wait ? null : request;
        this.retries = 0;
      } else if (line.startsWith('|error|')) {
        this.onError(line.slice('|error|'.length));
      } else {
        this.tracker.handleLine(line);
      }
    }
    void this.maybeDecide();
  }

  private ready(request: BattleRequest): boolean {
    if (request.teamPreview) return this.tracker.foe(request.side.id).team.length > 0;
    if (request.forceSwitch) return true;
    // Online the request can arrive before the turn's log; wait for `|turn|` before deciding.
    return this.tracker.turn > this.decidedTurn;
  }

  private async maybeDecide(): Promise<void> {
    const request = this.pending;
    if (!request || this.deciding || !this.side || this.tracker.ended || !this.ready(request)) return;
    this.deciding = true;
    try {
      const ctx = this.context;
      let choice: string;
      try {
        choice = request.teamPreview ?
          await this.options.agent.chooseTeamPreview(ctx, request) :
          await this.options.agent.chooseAction(ctx, request);
      } catch (err) {
        this.errors.push(`agent error: ${(err as Error).stack ?? err}`);
        this.options.log?.(`agent ${this.options.agent.name} failed, playing a random legal move: ${(err as Error).message}`);
        choice = randomChoice(request, this.options.rng);
      }
      if (this.pending !== request) return;
      this.pending = null;
      if (request.active && !request.forceSwitch) this.decidedTurn = this.tracker.turn;
      this.lastRequest = request;
      this.options.send(choice, request.rqid);
    } finally {
      this.deciding = false;
      // A newer request may have arrived while the agent was thinking.
      if (this.pending && this.pending !== request) void this.maybeDecide();
    }
  }

  private onError(message: string): void {
    this.errors.push(message);
    this.options.log?.(`choice error: ${message}`);
    // "[Unavailable choice]" is followed by a fresh request; "[Invalid choice]" needs a resend.
    if (message.startsWith('[Invalid choice]') && this.lastRequest && this.retries < 3) {
      this.retries++;
      this.options.send(randomChoice(this.lastRequest, this.options.rng), this.lastRequest.rqid);
    }
  }
}
