# Your first run

In this tutorial you run a ranger and a priest farming squigtoads for 30 game minutes, look at the run on the
dashboard, then record a run and watch it in the game's own page. It takes about ten minutes.

You need ChronAL installed (README: Install): `chronal install` done, `chronal` on your PATH.

## 1. Write a setup

A run is described by one JSON file, a setup. `chronal example` prints an annotated one: comment lines explain each
key, and `grep` drops them so the rest is plain JSON.

```sh
mkdir -p ~/chronal-try && cd ~/chronal-try
chronal example | grep -v '^\s*//' > my.json
```

Open `my.json`. The parts that matter now:

- `run`: 30 game minutes after a 1 minute warm-up, seed 1; `until` would end it early if `Ran1` reached level 45.
- `characters`: `Ran1`, a level 40 ranger with a +7 bow, and `Pri1`, a level 40 priest, both placed at the
  squigtoads on `main`.
- `code`: both run ChronAL's example bot (`codes/example/`): `Ran1` its `fighter` slot, `Pri1` its `priest` slot.
- `params.farm`: where to farm, which the example bot reads.
- `party`: `Ran1` invites `Pri1`.
- `accounts.main.storage` and `steer`: the bot reads the browser storage key `mode`; it starts as `"farm"`, and a
  steering step sets it to `"rest"` at 20 minutes (counted after the warm-up), as a player would on a control panel. Resting, the bot waits in
  town.

## 2. Check it

```sh
chronal run my.json --check
```

This loads and resolves the setup without running it, and prints one JSON line: `"ok": true`, each character's class
and CODE hash. A mistake (a typo in a key, a missing file) is listed here instead, every problem at once.

## 3. Run it

```sh
chronal run my.json
```

The game's server boots (a few seconds), the characters log in, then 31 game minutes go by in about 20 seconds of
real time. It prints what it started (the characters, their CODE, where its snapshot and setup files go), the steering
as it happens, then how fast it ran and a line per character (level, xp gained and per hour after the warm-up, kills,
deaths, gold gained, map, the bot's mode at the end, its party):

```
ranger + priest @ squigtoad: boot + login 4091 ms | ping 18 ms | Ran1 (ranger L40, fighter 9cf6fc26), Pri1 (priest L40, priest f1b0e40b) | party
live: .../live/ranger_priest_squigtoad--1790871128083.json
setup: .../live/ranger_priest_squigtoad--1790871128083.setup.json
steer at 20m mode="rest": storage main
steer at 25m @Pri1 run set_message('steered'): code Pri1
30.0 vmin after 1 warm-up: 88x (20.4 s real)
Ran1         L42 xp 2.48M (5.0M/h) kills 17 deaths 2 gold +188752 main rest party Ran1
Pri1         L41 xp 1.36M (2.7M/h) kills 5 deaths 2 gold +113432 main rest party Ran1
```

Your speed depends on your machine; the numbers depend only on the setup (its seed included), the CODE and the
versions of ChronAL and the game: run it again and they are the same. (The example bot is simple: level 40 characters at squigtoads die now and then.)

The run also wrote its snapshots to ChronAL's `live/` folder, which the dashboard reads.

## 4. Look at it on the dashboard

```sh
chronal dash
```

Open http://localhost:8089/ (from another machine: `ssh -N -L 8089:localhost:8089 <you>@<that machine>` first).

- The sidebar lists your runs: one row, "ranger + priest @ squigtoad", grey for done.
- Click the row: the run's page opens beside the list. Its **Characters** tab has each character's sheet (gear,
  conditions, stats), **Data** panels of DPS per character, XP/h over game time, damage by skill and more (add your
  own), **Monsters** the kills and deaths per monster.
- The XP/h panel marks the steering step at 20 minutes; after it the xp line goes flat (they rest in town).
- The **Run** tab has the setup it ran and how fast it ran.

The 1 minute warm-up is played but not measured: the graphs' 0:00 is its end, and the dashboard's numbers are the
printout's.

## 5. Run it again, recorded

A recorded run can be watched afterwards in the game's own page.

1. On the run's page, click **Rerun**. The New sim page opens with the run's settings, from the next seed.
2. Set **Seed** to 1 (the first run's) and tick **Record a replay**.
3. Click **Start**.

The new run shows up in the list as a "starting" row (with its log), then as running (green), and is done about half
a minute later. It is the same run as the first (same seed and CODE), now with a recording of each character.

## 6. Watch the replay

1. Click the new run's row.
2. Click **Replay** at the top of its page.

The game's page loads (the first time takes a few seconds while the dashboard starts the game's web backend) and
plays the run from the start, as `Ran1` sees it. Above it:

- a button per character switches whose view you watch, at the same moment;
- the bar at the top of the game has the time, the speed, pause and a scrubber. The replay starts at 1x (game time
  as it passed): drag the speed up to the run's own to watch it faster. **Hide the game** folds the game away and
  keeps a bar with the same controls.

Below the game, the run's tabs stay: click a point on a graph and the replay jumps to that moment; the Characters tab
shows each sheet at the replay's moment.

## Next

- Run your own CODE instead of the example bot: [Run your own CODE](../how-to/run-your-code.md).
- Start from your live characters: [Start from your live characters](../how-to/start-from-live.md).
- Every key of the setup: [the setup format](../reference/setup.md).
