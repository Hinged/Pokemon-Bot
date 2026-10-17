import { describe, expect, it } from 'vitest';
import { dex } from '../src/data/format.js';
import { megaForm } from '../src/data/sets.js';
import { toId } from '../src/battle/protocol.js';
import { seededRandom } from '../src/ai/agent.js';
import { planTeamPreview } from '../src/ai/teampreview.js';
import { buildTeams } from '../src/teambuilder/builder.js';
import { sampleMetaTeam } from '../src/teambuilder/sample.js';
import type { PokemonSet } from '../src/ps.js';
import { meta } from './helpers.js';

function checkClauses(team: PokemonSet[]): void {
  expect(team).toHaveLength(6);
  const bases = team.map(s => dex.species.get(s.species).baseSpecies);
  expect(new Set(bases).size).toBe(6);
  const items = team.map(s => toId(s.item)).filter(Boolean);
  expect(new Set(items).size).toBe(items.length);
  for (const set of team) {
    const total = (Object.values(set.evs) as number[]).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(66);
    expect(set.moves.length).toBeGreaterThan(0);
  }
}

describe('team sampling', () => {
  it('draws legal ladder-like teams', () => {
    const rng = seededRandom(3);
    for (let i = 0; i < 20; i++) {
      const team = sampleMetaTeam(meta, rng);
      checkClauses(team);
      expect(team.filter(s => megaForm(s)).length).toBeLessThanOrEqual(2);
    }
  });
});

describe('team builder', () => {
  it('builds distinct legal teams around a core', () => {
    const reports = buildTeams({ meta, core: ['Rillaboom', 'Salamence-Mega'], results: 2, poolSize: 40, threatCount: 20 });
    expect(reports.length).toBe(2);
    for (const r of reports) {
      checkClauses(r.team);
      expect(r.members).toContain('Rillaboom');
      expect(r.members).toContain('Salamence-Mega');
      expect(r.threats).toHaveLength(20);
    }
    const [a, b] = reports.map(r => r.members);
    expect(a.filter(m => !b.includes(m)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('team preview', () => {
  it('brings four with the leads first', () => {
    const rng = seededRandom(9);
    const ours = sampleMetaTeam(meta, rng);
    const theirs = sampleMetaTeam(meta, rng);
    const plan = planTeamPreview(ours, theirs, { pick: 4, activeCount: 2, meta });
    expect([...plan.order].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.matchups).toHaveLength(6);
    expect(plan.matchups[0]).toHaveLength(6);
  });
});
