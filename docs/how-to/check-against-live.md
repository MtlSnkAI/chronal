# Check the sim against live

Run the same CODE on a live server and in the sim, and compare what both record. This is how the measurement in
[how close the sim is](../explanation/fidelity.md) was made; repeat it with your own character, spot or server.

The tools are in `tools/fidelity/`: `fidelity.js` (the CODE, for both sides), `sim.js` (sim runs matched to a live
run) and `compare.js` (the two side by side).

## 1. Prepare the live side

- **A fighter and a spot.** `fidelity.js` farms one spot: `preset` at its top, one of its `PRESETS` (iceroamer and
  arcticbee in winterland, ...). The measurement used a L64 ranger in +8 gear at iceroamers. The spot's map and
  monsters must be the same on live and in the game the sim runs: `chronal pull` warns when they differ, and the
  pull's `game-diff.json` lists every entry that does.
- **The settings** at the top of `fidelity.js`: `minutes` (the measured window: 10, then 20), `runs` (how many in a
  row), `sell` (drops sold at the potion seller; what the bag held at the start is kept).
- **Only this fighter online** among the account's characters (merchants may stay): Lone Wolf triples xp, gold and
  luck for a lone fighter, and the sim starts the fighter alone.
- **No buffs from other players** (wait until they run out): the sim has no other players.
- **A quiet server, and nobody at the spot.**
- **The game visible, or its browser's background throttling off.** A browser runs a hidden page's timers about once a
  second or less often, so the CODE reacts late, takes more damage and may die. In Firefox, `about:config` (best in a
  profile of its own, `about:profiles`): `dom.min_background_timeout_value` 4,
  `dom.timeout.enable_budget_timer_throttling` false, `dom.min_background_timeout_value_without_budget_throttling` 4.
  Chrome or Chromium: start it with `--disable-background-timer-throttling --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding`.

## 2. Pull, then run it on live

Pull the account just before (`chronal pull`, or the dashboard's Settings, Pull now): the sim starts from it. Load
`fidelity.js` into a CODE slot of the character and start it.

Each run goes to the nearest potion seller (sells, buys potions, heals to full), walks to the spot, warms up for 2
minutes, then measures for `minutes`. Its record downloads as `fidelity-<name>-<start>.json`; let the browser download
several files. After the last run the character waits at the seller. Every record also stays in the game's local
storage: `show_json(get("fidelity_last"))` in the CODE, or `fidelity_download()` for the last one as a file.

## 3. Match each run in the sim

```sh
node tools/fidelity/sim.js --live fidelity-<name>-<start>.json --seeds 1-6
```

From the record: the spot, warm-up and window, the world's clock at the same server hour (night, the server's hours
0-5, slows monsters), the live ping, the seasons the live server had on, the account's age then (the New Player
bonus follows it), the character's level (a pull a level behind: the rest as pulled). Merchant's Luck from a merchant
of the account: that merchant joins the sim run beside the fighter and casts it (buffs from other players can't be
had). The character comes from the newest pull holding it (`--pull ACCOUNT/TIME` to choose). The runs go to
`<live_dir>/fidelity`, apart from the dashboard's runs; running a name again replaces its runs.

Monsters grow while they live: at a spot nobody farmed before the live run (the record's monster levels at the
window's start say so), give the sim's world time first, `--world-age 30m` or `1h`, until `compare.js`'s monster
level matches.

## 4. Compare

```sh
node tools/fidelity/compare.js --name <the name sim.js printed> fidelity-<name>-<start>.json
```

First what made the live run unlike the sim's world: other players near, monsters others killed, buffs the sim
can't have, a throttled CODE loop, a window that didn't end, a character whose stats differ from the pull's. Then per
metric over the window: the sim's mean and spread over the seeds, the live value, live / sim, and z, how many of the
sim's standard deviations away the live value is (beyond 2: outside what the seeds spread over).
