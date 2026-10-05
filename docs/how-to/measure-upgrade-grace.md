# Measure a realm's upgrade grace

Each realm keeps its own upgrade grace per level (`S.ugrace`). Every upgrade there moves it: a failure raises it at that
level and the ones below, and a success at a level resets that level to 0. A sim boots at 24 per level (a new
realm's), and `world.ugrace` sets other values ([setup](../reference/setup.md#world)). These tools read a live realm's
values, so a setup can use them.

The tools are in `tools/ugrace/`: `probe.js` (the CODE, for live and the sim) and `invert.js` (solves the readings).

## How it works

`upgrade(item, scroll, null, true)` only calculates. The server works out the chance with all its grace terms and
answers it. Nothing is consumed and nothing is rolled. With a scroll and no offering, the chance depends on:
- the item's base chance at that level (`G.upgrades`);
- the item's own grace (the answer includes it) and its grade;
- the character's own grace at that level and its offering grace;
- the server's term, `min(6, S.ugrace / 3)`.

For a character with no grace of its own, the server's term is the only unknown, and `invert.js` solves for it. Any
value of 18 or more gives the same chance, so the readings show it as `>=18`. Formulas: `tools/ugrace/invert.js`.

The lucky upgrade slot (a setup's `state.p.item_num`) lowers the roll, not the chance, so the readings don't see it.

## 1. Prepare a character on live

- **One with no upgrade grace of its own.** It must never have tried an upgrade itself, and never used an offering
  (also with compounds). A fighter usually qualifies. A merchant that upgrades does not: its grace is server-side and
  live never shows it.
- **Items to read with.** Upgradeable items at the levels you want: an item at +n reads level n+1, so +3 to +7 reads
  levels 4 to 8. Your merchant can upgrade them and send them over. Locked items are skipped.
  - The readings are clearest with normal-grade items (a plain coat, helmet, shoes...).
  - Level 9 and above need an item with some grace of its own: about 2 at +8, about 5 at +9. Without it, the chance
    sits at its floor and only gives an upper bound.
  - Below level 4 the chance sits at its cap and shows nothing.
- **A scroll of each grade the items need**, which stays in the bag:
  - `scroll0` for normal items below +7;
  - `scroll1` for normal items at +7 and +8, and for high-grade items (e.g. `coat1`) below +7.
- **Settings** at the top of `probe.js`: `every_s` (default 300: a reading of every item each 5 minutes), `hours`
  (default 24), `download_every`.

## 2. Run it on live

Load `probe.js` into a CODE slot of the character on the realm you want to measure, and start it. It walks to the
upgrade NPC in main (the server answers only near it) and reads every `every_s` seconds for `hours`.
- Its message shows the latest values, e.g. `ugrace L4:12 L5:>=18 L6:3`.
- Its record downloads as `ugrace-<name>-<start>.json` every `download_every` rounds and at the end; let the browser
  download several files.
- The record also stays in the game's local storage: `show_json(get("ugrace_last"))`, or `ugrace_download()` for it
  as a file.

A record holds readings from one realm. Measure each realm separately.

## 3. Solve the readings

```sh
node tools/ugrace/invert.js ugrace-MyFighter-2026-10-05T10-00-00-000Z*.json [--json]
```

Pass every download: each holds the whole record so far, and a reading held twice counts once.

It works per round: the items read at one time give one value. Per level it prints:
- the readings and the rounds;
- how many rounds it solved, and how many it only bounded (at the floor: S.ugrace at most a whole number) or couldn't
  read (at the cap);
- S.ugrace over the time (min, median, max; a floor round at its bound) and how often it was 18 or more;
- `mean`: the S.ugrace whose chance is the average chance over the rounds (a floor round at half its bound). The chance
  rises about linearly with the server's term `min(6, S.ugrace / 3)`, so this is the term's mean times 3; it gives the
  day's average chance where the median misses its spikes;
- a `world.ugrace` to paste into a setup: each level's `mean`, to 0.1 (a level only ever at the floor is left out).

Three checks flag readings that don't fit the formula:
- **items apart:** the items of one round must give the same value. They are read one after another, a fraction of a
  second apart, so now and then someone's upgrade changes it in between (by a whole number, in a few rounds of a
  day: EU IV had 1 in 277); often, or by a fraction, is a failed check;
- **off whole:** the server's values are whole numbers;
- **off:** the server's term lies between 0 and 6.

A failed check means the character has grace of its own, or live's formula differs from the local game copy's.

## 4. Use it in a setup

```json
"world": { "ugrace": { "4": 0.6, "5": 1.4, "6": 2.9, "7": 4, "8": 4.4 }, "ugrace_fixed": true }
```

(EU IV over 21 hours from 2026-10-05 12:10 UTC.) Levels the probe didn't read keep the sim's 24.

- `ugrace_fixed: true` holds these values: a busy realm where other players' upgrades keep it about there.
- `false` starts from them and lets the run's own upgrades move them.

A setup can run once with the lowest and once with the highest values read, to see how much the grace matters for an
upgrade plan.

## Check it in the sim

The same CODE runs in the sim. `chronal.params.ugrace_probe` overrides its settings, and its record is the
snapshot's `players[].code_status`, which `invert.js` reads directly. `test/ugrace_probe.test.js` runs it with
`world.ugrace` set and checks that it reads every level back exactly.
