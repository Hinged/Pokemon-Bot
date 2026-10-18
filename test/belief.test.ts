import { describe, expect, it } from 'vitest';
import { getFormat } from '../src/data/format.js';
import { playMatch } from '../src/battle/runner.js';
import { buildBelief } from '../src/battle/belief.js';
import { GreedyAgent } from '../src/ai/agents/greedy.js';
import { meta, metaTeams } from './helpers.js';

/**
 * At every decision of real games, the belief battle rebuilt from the protocol must agree with the
 * simulator's true state on everything a player can observe.
 */
describe('belief battle', () => {
  it('reproduces the observable state of real games', async () => {
    const format = getFormat();
    const mismatches: string[] = [];
    let checks = 0;
    for (let g = 0; g < 6; g++) {
      const teams = metaTeams(100 + g);
      await playMatch({
        format, meta, seed: g, teams, agents: [new GreedyAgent(), new GreedyAgent()],
        onDecision: (side, request, session, truth) => {
          if (request.forceSwitch || request.teamPreview) return;
          const b = buildBelief(request, { format, side, team: teams[side === 'p1' ? 0 : 1], tracker: session.tracker, meta });
          checks++;
          const where = `game ${g} turn ${truth.turn} (${side} view)`;
          for (const s of ['p1', 'p2'] as const) {
            if (truth[s].pokemonLeft !== b.battle[s].pokemonLeft) mismatches.push(`${where}: ${s} Pokémon left`);
            truth[s].active.forEach((real, i) => {
              const bel = b.battle[s].active[i];
              if (!real || !bel || real.fainted) return;
              if (real.species.name !== bel.species.name) mismatches.push(`${where}: species ${real.species.name}/${bel.species.name}`);
              if (Math.abs(real.hp / real.maxhp - bel.hp / bel.maxhp) > 0.03) mismatches.push(`${where}: ${real.name} HP`);
              if (real.status !== bel.status) mismatches.push(`${where}: ${real.name} status`);
              for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
                if (real.boosts[k] !== bel.boosts[k]) mismatches.push(`${where}: ${real.name} ${k} boost`);
              }
              if ((real.activeMoveActions === 0) !== (bel.activeMoveActions === 0)) mismatches.push(`${where}: ${real.name} Fake Out availability`);
              if (real.item !== bel.item) mismatches.push(`${where}: ${real.name} item`);
            });
            for (const [id, cond] of Object.entries(truth[s].sideConditions)) {
              if (b.battle[s].sideConditions[id]?.duration !== cond.duration) mismatches.push(`${where}: ${s} ${id}`);
            }
          }
          const field = truth.field;
          if (field.weather !== b.battle.field.weather) mismatches.push(`${where}: weather`);
          if (field.terrain !== b.battle.field.terrain) mismatches.push(`${where}: terrain`);
          if (field.terrain && field.terrainState.duration !== b.battle.field.terrainState.duration) mismatches.push(`${where}: terrain turns`);
          for (const [id, state] of Object.entries(field.pseudoWeather)) {
            if (b.battle.field.pseudoWeather[id]?.duration !== state.duration) mismatches.push(`${where}: ${id}`);
          }
        },
      });
    }
    expect(checks).toBeGreaterThan(30);
    expect(mismatches).toEqual([]);
  });
});
