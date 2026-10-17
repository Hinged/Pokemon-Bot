import { describe, expect, it } from 'vitest';
import { getFormat } from '../src/data/format.js';
import { playMatch } from '../src/battle/runner.js';
import { makeAgent } from '../src/ai/agents/index.js';
import { combos, isValidCombo, slotOptions } from '../src/ai/actions.js';
import type { BattleRequest } from '../src/battle/protocol.js';
import { meta, metaTeams } from './helpers.js';

const format = getFormat();

const FAST_SEARCH = { timeBudgetMs: 300, ourJoint: 12, foeJoint: 8, samples: 1 };

async function score(a: string, b: string, pairs: number): Promise<{ score: number; errors: string[] }> {
  let total = 0;
  const errors: string[] = [];
  for (let p = 0; p < pairs; p++) {
    const teams = metaTeams(300 + p);
    for (const swap of [false, true]) {
      const r = await playMatch({
        format, meta, seed: p * 2 + (swap ? 1 : 0),
        teams: swap ? [teams[1], teams[0]] : teams,
        agents: [makeAgent(a, FAST_SEARCH), makeAgent(b, FAST_SEARCH)],
      });
      errors.push(...r.errors);
      total += r.winner === 0 ? 1 : r.winner === null ? 0.5 : 0;
    }
  }
  return { score: total / (pairs * 2), errors };
}

describe('action enumeration', () => {
  it('builds legal doubles choices with targets and Mega Evolution', () => {
    const request = {
      active: [
        { moves: [{ move: 'Fake Out', id: 'fakeout', pp: 16, maxpp: 16, target: 'normal' }, { move: 'Protect', id: 'protect', pp: 16, maxpp: 16, target: 'self' }], canMegaEvo: true },
        { moves: [{ move: 'Hyper Voice', id: 'hypervoice', pp: 16, maxpp: 16, target: 'allAdjacentFoes' }] },
      ],
      side: {
        name: 'a', id: 'p1',
        pokemon: [
          { ident: 'p1: A', details: 'A', condition: '100/100', active: true },
          { ident: 'p1: B', details: 'B', condition: '100/100', active: true },
          { ident: 'p1: C', details: 'C', condition: '100/100', active: false },
          { ident: 'p1: D', details: 'D', condition: '0 fnt', active: false },
        ],
      },
    } as unknown as BattleRequest;
    const [slot0, slot1] = slotOptions(request);
    const choices0 = slot0.map(o => o.choice);
    expect(choices0).toContain('move 1 1');
    expect(choices0).toContain('move 1 -2');
    expect(choices0).toContain('move 1 2 mega');
    expect(choices0).toContain('move 2');
    expect(choices0).toContain('switch 3');
    expect(choices0).not.toContain('switch 4');
    expect(slot1.map(o => o.choice)).toEqual(['move 1', 'switch 3']);
    const joint = combos([slot0, slot1]);
    expect(joint.every(isValidCombo)).toBe(true);
    expect(joint.some(c => c[0].choice === 'switch 3' && c[1].choice === 'switch 3')).toBe(false);
  });
});

describe('agents', () => {
  it('random agents only make legal choices', async () => {
    const { errors } = await score('random', 'random', 5);
    expect(errors).toEqual([]);
  });

  it('greedy beats random', async () => {
    const { score: s, errors } = await score('greedy', 'random', 5);
    expect(errors).toEqual([]);
    expect(s).toBeGreaterThanOrEqual(0.8);
  });

  it('search beats random', async () => {
    const { score: s, errors } = await score('search', 'random', 2);
    expect(errors).toEqual([]);
    expect(s).toBeGreaterThanOrEqual(0.75);
  });
});
