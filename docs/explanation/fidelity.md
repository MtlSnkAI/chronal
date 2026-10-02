# How close the sim is to a real server

The sim is not the live game. It runs the game's own server and client code, but in one process, on a virtual
clock, with no network between them, so anything that depends on real timing, real latency or other players can
differ. This page records the measurements of that difference: against the live game, and before that against an
engine with real browsers.

## Against live (2026-10-02)

A ranger L64-65 alone at a winterland spot ran the same CODE on live servers and in the sim: plain attacks, kiting,
potions by fixed thresholds. The CODE records the same numbers on both sides over a 10 or 20 minute window after a 2
minute warm-up ([the tools and steps](../how-to/check-against-live.md)). Each live run had 6 sim seeds matched to it:
the character as pulled (at its live level), the server's hour, the measured ping and the account's age. The runs
below had the game window visible (its timers never throttled, below) and no other players at the spot. Live as a
share of the sim:

| metric | iceroamers, EU, 19 ms (3 x 20 min) | arcticbees, EU, 18 ms (2 x 10 min) | arcticbees, US, 93 ms (2 x 10 min) | arcticbees, ASIA, 171 ms, night (10 min) |
|---|---|---|---|---|
| kills per hour | 99-100% | 101-102% | 99-100% | 100% |
| damage per hit | 100% | 100% | 100% | 100% |
| time to kill | 101-102% | 98-99% | 100-101% | 98% |
| shots per kill | 100-101% | 99-100% | 100% | 98% |
| evaded shots | 92-106% | - | - | - |
| damage taken | 96-98% | too few hits | too few hits | too few hits |
| hp and mp potions | 99-101% | 100% (mp) | 100% (mp) | 97% (mp) |
| gold per hour | 97-98% | 90-92% | 83-102% | 108% |
| xp per kill | 99% (102% with grown monsters) | 99-102% | 98-100% | 98% |
| kiting steps | 107-112% | 73-78% | 102-130% | 100% |

Kills, damage and xp per kill lie within the spread of the sim's seeds or 1-2% off it, at 19, 93 and 171 ms of ping,
by day and at night (the server's hours 0-5, when monsters slow down).
Gold varies 9-15% between seeds. Arcticbees hardly hit back (about 50 hits an hour), so their damage taken and
kiting say little. What differs, and why:
- **Lone Wolf and New Player drop for moments on live.** The server re-reads an account's characters from its
  database when its cached copy runs out, and until the answer comes those conditions are off: 2-10 s per window on
  EU and US, 18-22 s per 10 minutes on ASIA, so xp per kill was 1-2% lower. The sim's database answers at once and the
  conditions never drop: for an account that has them, the sim's xp and gold read 1-2% high.
- **At iceroamers live stepped away from monsters 7-12% more often**, without taking more damage. Why is not known.
- **A hidden game window makes the live side wrong.** A browser runs a hidden page's timers about once a second
  (Firefox may delay them up to 15 s), so the CODE reacts late: earlier 10 minute runs whose window was hidden for
  1-19% of the time took up to 13% more damage and drank up to 16% more hp potions, and a long stretch can kill.
  Compare live runs only with the window visible or the browser's background throttling off.
- **Monsters grow while they live.** A spot nobody farmed has monsters of higher levels, while a fresh sim world starts
  them at level 1. Such live runs matched the sim once the sim's world had run first (`world.age`): 1 hour at
  iceroamers, 30 minutes at arcticbees, which grow faster, and 12 hours for arcticbees of levels 10-20 (kills 102%,
  damage taken 100%, time to kill 95%; the levels of a live spot can only be approached this way).
- **The sim has no other players.** A run with others at the spot (they killed a third of its arcticbees, a paladin's
  aura was on the ranger) had 10% less xp per kill and twice the hits taken, and is left out above. No buffs from them
  either: Newcomers' Blessing adds 10% xp, gold and luck; Merchant's Luck adds luck (a merchant of the account can
  give it in the sim too). Citizens wander at random on both sides; Caroline in winterland heals players within
  320 px of her.

## Against an engine with real browsers (2026-10-01)

Before the sim was the only engine, ChronAL had a second one: the real game server, web backend and one headless
browser per character, on a warped clock at up to 10x. It was closer to live (real sockets, real browser timers, one
event loop per character) and much slower. On 2026-10-01 the same setup ran in both:

- A party farming spookytown: ranger L64 (leader), paladin L61, priest L60, plus a merchant L40 restocking them.
  The CODE forms the party; no steering.
- 30 game minutes per run, no warm-up, a fresh world, ping 18 ms.
- The sim: seeds 1-5, about 56x. The browser engine: seeds 1-3, 7.5-8x on average.

Per game hour, mean +- sd over the seeds; the last column is browser engine / sim:

| character | metric | sim | browser engine | ratio |
|---|---|---|---|---|
| ranger | xp | 10.06M +- 0.29M | 10.25M +- 0.57M | 102% |
| | kills | 1.1k +- 49 | 1.1k +- 76 | 106% |
| | damage done | 2.04M +- 53k | 2.10M +- 112k | 103% |
| | damage taken | 38.4k +- 8.2k | 26.2k +- 3.9k | 68% |
| | hp potions | 58 +- 13 | 38 +- 2 | 65% |
| | income | 800k +- 21k | 841k +- 47k | 105% |
| paladin | xp | 9.25M +- 55k | 9.20M +- 337k | 99% |
| | kills | 313 +- 31 | 296 +- 10 | 95% |
| | damage taken | 1.06M +- 41k | 1.02M +- 60k | 96% |
| | heal done | 959k +- 32k | 905k +- 27k | 94% |
| | hp potions | 13 +- 4 | 44 +- 30 | 333% |
| priest | xp | 4.45M +- 66k | 4.41M +- 168k | 99% |
| | kills | 311 +- 6 | 287 +- 8 | 92% |
| | heal done | 130k +- 19k | 129k +- 32k | 99% |
| merchant | deaths (per run) | 0 | 1 every run | - |
| | damage taken | 186 +- 256 | 2.8k +- 860 | 1528% |

Combat time, mana potions and credits matched within 3% for every fighter.

### What it means

- Party xp and income per hour agree within 1-5%, inside or near the spread between seeds.
- Kills per hour differ by up to 8% per character.
- Damage taken and hp potion use differ by a third or more (the ranger took 32% less in the browser engine, the
  paladin drank 3x the hp potions, both on small counts).
- The merchant died once in every browser-engine run (prats and scorpions on its restock path) and never in the sim.
- Why these differ is not known. Treat survival, damage taken and potion use in the sim as rough.
- The browser engine was not live either, so these numbers bound the sim's error against it, not against live.
  Check a setup that matters against live characters before relying on it.
