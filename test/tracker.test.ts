import { describe, expect, it } from 'vitest';
import { parseCondition, parseIdent } from '../src/battle/protocol.js';
import { BattleTracker } from '../src/battle/tracker.js';

const LOG = `|gametype|doubles
|player|p1|Alice||
|player|p2|Bob||
|poke|p1|Rillaboom, L50, M|
|poke|p1|Salamence, L50, F|
|poke|p2|Incineroar, L50, M|
|poke|p2|Gholdengo, L50|
|teampreview|4
|start
|switch|p1a: Rillaboom|Rillaboom, L50, M|207/207
|switch|p1b: Salamence|Salamence, L50, F|172/172
|switch|p2a: Incineroar|Incineroar, L50, M|100/100
|switch|p2b: Gholdengo|Gholdengo, L50|100/100
|-ability|p2a: Incineroar|Intimidate|boost
|-unboost|p1a: Rillaboom|atk|1
|-unboost|p1b: Salamence|atk|1
|-fieldstart|move: Grassy Terrain|[from] ability: Grassy Surge|[of] p1a: Rillaboom
|turn|1
|detailschange|p1b: Salamence|Salamence-Mega, L50, F
|-mega|p1b: Salamence|Salamence|Salamencite
|move|p1b: Salamence|Tailwind|p1b: Salamence
|-sidestart|p1: Alice|move: Tailwind
|move|p1a: Rillaboom|Fake Out|p2b: Gholdengo
|-damage|p2b: Gholdengo|79/100
|move|p2a: Incineroar|Flare Blitz|p1a: Rillaboom
|-damage|p1a: Rillaboom|20/207
|-damage|p2a: Incineroar|88/100|[from] Recoil
|-status|p2b: Gholdengo|par
|upkeep
|turn|2`;

describe('protocol helpers', () => {
  it('parses conditions including Champions HP colour hints', () => {
    expect(parseCondition('150/207 par')).toEqual({ hp: 150, maxhp: 207, status: 'par', fainted: false });
    expect(parseCondition('20/100y')).toMatchObject({ hp: 20, maxhp: 100 });
    expect(parseCondition('0 fnt')).toMatchObject({ hp: 0, fainted: true });
  });

  it('parses idents', () => {
    expect(parseIdent('p2b: Gholdengo')).toEqual({ side: 'p2', slot: 1, name: 'Gholdengo' });
    expect(parseIdent('p1: Rillaboom')).toEqual({ side: 'p1', slot: null, name: 'Rillaboom' });
  });
});

describe('BattleTracker', () => {
  const tracker = new BattleTracker();
  tracker.receive(LOG);
  const ril = tracker.sides.p1.team.find(m => m.name === 'Rillaboom')!;
  const mence = tracker.sides.p1.team.find(m => m.name === 'Salamence')!;
  const gold = tracker.sides.p2.team.find(m => m.name === 'Gholdengo')!;
  const incin = tracker.sides.p2.team.find(m => m.name === 'Incineroar')!;

  it('tracks HP, status and boosts', () => {
    expect(tracker.turn).toBe(2);
    expect(ril.hp).toBe(20);
    expect(ril.boosts.atk).toBe(-1);
    expect(gold.hp).toBe(79);
    expect(gold.status).toBe('par');
    expect(incin.hp).toBe(88);
  });

  it('tracks Mega Evolution and revealed moves', () => {
    expect(mence.megaEvolved).toBe(true);
    expect(mence.species).toBe('Salamence-Mega');
    expect(tracker.sides.p1.megaUsed).toBe(true);
    expect(incin.moves).toContain('flareblitz');
    expect(ril.moveActions).toBe(1);
  });

  it('times field effects from their first countdown turn', () => {
    // Set at battle start: first ticks down at the end of turn 1.
    expect(tracker.field.terrain).toMatchObject({ id: 'grassyterrain', turn: 1 });
    // Set during turn 1's actions: also ticks at the end of turn 1.
    expect(tracker.sides.p1.conditions.tailwind).toMatchObject({ id: 'tailwind', turn: 1 });
    expect(tracker.sides.p1.active.map(m => m?.name)).toEqual(['Rillaboom', 'Salamence']);
  });
});
