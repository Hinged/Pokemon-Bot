# Pokémon Champions Bot

A team builder and battle AI for **Pokémon Champions** VGC (doubles, bring 6 pick 4, Regulation M-C).

It runs on the Pokémon Showdown simulator's `champions` mod, so battle mechanics match Champions: level 50, Stat Points instead of EVs, Mega Evolution, open team sheets, and Champions' sleep, freeze and paralysis rules. Team building and opponent modelling use Smogon's ladder usage stats: September 2026, Reg M-C, 1.6M battles at 1630+ rating.

## What it can do

| | |
|---|---|
| **Build teams** | Searches for teams that answer the most-used threats. Each team is scored on damage-calc matchups, VGC roles (Fake Out, speed control, Intimidate, redirection), shared weaknesses, and which Pokémon actually get paired together on the ladder. |
| **Team preview advice** | Given your six and the opponent's six, recommends which four to bring and which two to lead. Shows a matchup table and speed tiers. |
| **Play battles** | A search AI simulates every candidate pair of moves (yours and theirs) in the real simulator and plays the game-theoretic equilibrium. It can play locally or on Pokémon Showdown. |
| **Damage calcs / validation** | Champions-accurate calcs through `@smogon/calc`, plus team checks for Stat Points, Item Clause and Species Clause. |

### About playing the actual Champions game

Pokémon Champions on Switch and mobile has no API for bots, and automating the official game would break its terms of service. So the bot does two things:

1. **It plays on Pokémon Showdown**, which runs Champions formats. That's where you can test it, and it's the same ruleset.
2. **It advises you for your own games:** team building, what to bring and lead, speed tiers and calcs. A turn-by-turn advisor is the next step (see the roadmap).

## Quick start

Requires Node 20+.

```bash
npm install
npm run champ -- help
```

```bash
# Build teams for the current meta (optionally around a core)
npm run champ -- build
npm run champ -- build --core "Garchomp-Mega-Z, Rillaboom" --out teams/mine.txt --simulate 50

# What to bring / lead against a team you see at preview
npm run champ -- preview --team teams/sample-regmc.txt \
  --opponent "Sneasler, Kingambit, Indeedee-F, Basculegion, Farigiraf, Golisopod-Mega"

# Damage calc with the ladder's most common sets
npm run champ -- calc "Garchomp-Mega-Z" "Earth Power" "Gholdengo"

# Check a team
npm run champ -- validate --team teams/sample-regmc.txt

# Watch the AI play: search agent vs greedy agent on sampled ladder teams, saving replays
npm run champ -- battle --agent1 search --agent2 greedy --games 4 --replays replays/

# Usage stats: show / refresh (Smogon publishes monthly)
npm run champ -- meta top --n 30
npm run champ -- meta update --month 2026-10
```

### Playing on Pokémon Showdown

```bash
# Accept challenges from you only (registered account: export PS_PASSWORD=...)
npm run champ -- play --user MyBotName --team teams/sample-regmc.txt --accept --from mymainaccount

# Challenge someone, or play N ladder games
npm run champ -- play --user MyBotName --team teams/sample-regmc.txt --challenge someuser
npm run champ -- play --user MyBotName --team teams/sample-regmc.txt --ladder 5
```

Use a dedicated account for the bot. Don't flood the ladder, and don't present it as a human. The default search budget is about 8s per turn, which is well inside the VGC turn timer.

To test without touching the public server, run a local Showdown server (`node node_modules/pokemon-showdown/pokemon-showdown start 8000 --no-security`). Then add `--server ws://localhost:8000/showdown/websocket --no-login --format gen9championsvgc2026regmb`.

## How the battle AI works

```
Showdown protocol ──► BattleTracker ──► belief battle ──► search ──► choice
 (local or online)    what we can see   full simulator     simulate
                      HP, status,       state rebuilt      our × their
                      boosts, field…    from what we       joint actions
                                        know + usage       → matrix game
                                        stats for          → Nash
                                        hidden info
```

1. **Tracking** (`src/battle/tracker.ts`). The bot reads the same message stream a player sees: HP, status, boosts, volatiles, field and side conditions with turn counts, Megas and revealed moves and items. Open team sheets give it the opponent's moves, items, abilities and natures. Only Stat Points are hidden.
2. **Belief** (`src/battle/belief.ts`). It rebuilds a complete simulator battle matching that observation. The opponent's hidden Stat Points come from the most common ladder spread for their nature, and their unrevealed back line from usage. A test checks this against the true simulator state at every decision of real games. All observable state matches, including effect durations and Fake Out availability.
3. **Search** (`src/ai/search.ts`):
   - Score each slot's options with damage calcs and VGC heuristics, then prune to the best few joint actions for each side. Protect and switches are always kept.
   - Simulate every (our joint action, their joint action) pair for one turn in the real simulator, with damage rolls, crits, speed ties and accuracy. Then evaluate the position: material, HP, status, boosts, Tailwind/Trick Room/screens, plus a **threat term** for next-turn KO pressure and move order.
   - Resample the cells that decide the outcome (successive halving), then solve the resulting zero-sum matrix game with regret matching. The bot samples from the equilibrium strategy, so it doesn't fall into predictable double-Protect or always-attack-the-same-slot patterns.
4. **Team preview** (`src/ai/teampreview.ts`). Builds a 6×6 matchup matrix from calcs and speed, picks the four that best cover the opponent's likely picks, then the lead pair with the best support (Fake Out, speed control, Intimidate, redirection).

### Strength so far

Results on randomly sampled ladder teams, with each pairing played twice so both sides use each team:

| Matchup | Result |
|---|---|
| greedy vs random | 100% (10/10) |
| search vs greedy (1.5 s/turn) | **69% (33/48)** |

The greedy agent picks each slot's best move by calc and rules of thumb. Run your own with `npm run bench -- search greedy --pairs 10`.

## Project layout

```
src/
  data/         format constants, Champions stat formula, usage stats, sets, damage calc
  battle/       protocol parsing, tracker, belief builder, player session, local runner
  ai/           action enumeration, heuristics, evaluation, threat model, search, Nash solver,
                team preview, agents (search / greedy / random)
  teambuilder/  ladder-team sampler and the team builder
  client/       Pokémon Showdown websocket client
  cli/          `champ` command line
data/meta/      bundled usage snapshot (refresh with `champ meta update`)
teams/          sample team
test/           vitest suite (stats, tracker, belief accuracy, agents, builder, solver)
scripts/        benchmark
```

```bash
npm test            # ~1 minute
npm run typecheck
```

## Known limitations

- **Regulation data.** The published `pokemon-showdown` package includes the Champions mod up to Reg M-B. Mechanics are identical, so local simulation uses the M-B format, but `validate` can only warn (not error) about Pokémon and moves added in M-C. Aura Guard (Lucario-Mega-Z's ability) isn't in the bundled data yet.
- **One-turn lookahead.** The search looks one turn ahead, plus the threat term. It doesn't plan multi-turn sequences like "set Trick Room now, sweep later" beyond what the evaluation rewards.
- **Simulator speed.** About 4 ms per simulated turn, so a decision is roughly 1,000 simulations in 2–6 s.
- **Opponent modelling.** It assumes a strong (equilibrium) opponent and doesn't yet exploit a specific player's habits.

## Roadmap

- Turn-by-turn advisor for in-game Champions matches: enter what you see, get a recommended move with reasoning.
- Parallel search across CPU cores (worker threads), then deeper search (two-turn lookahead / MCTS).
- Tune evaluation weights from self-play and Showdown replays (the ladder publishes replays of high-rated games).
- Stat Point optimizer: hit speed benchmarks and survive specific attacks with the fewest points.
- Bayesian inference of opponent spreads from observed damage and move order.
