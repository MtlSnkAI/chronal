# Live snapshot schema v2.3

What a run writes into a live dir while it runs, and what the dashboard (`dashboard/server.js`) and
`tools/live_check.js` read. `sim/live.js` writes it for every `chronal run` run (the live dir: `--live DIR`, else
config `live_dir`; `--no-live`: none).

A snapshot says `schema: 2, schema_minor: 3`. The input of a run, the run setup (`chronal-setup/1`), is described in
docs/reference/setup.md; `chronal example` prints an annotated one.

## 1. Files in a live dir

| file | what | written |
|---|---|---|
| `<id>.json` | the snapshot | whole (tmp + rename), every real second, and a final one at the end (`done: true`) |
| `<id>.grid.ndjson` | the fixed game-time grid (section 8) | a header line, the base's line, then a line per `grid.step_ms` of game time; a last line at the end |
| `<id>.items.ndjson` | the items' events (section 8, below the grid) | a line per loot, upgrade, compound, handover from the base on |
| `<id>.setup.json` | the resolved setup of the run (section 9) | once, at the start |
| `<id>.ctl` | the dashboard's requests to the run (section 4) | by the dashboard; removed by the run when it ends |
| `<id>.state/<label>/<Name>.json`, `index.json` | the run's state exports ([state exports](export.md)): `end` at its end, others on request | whole, when written |
| `<id>.rec/<name>.rec.gz`, `.rec.idx` | a character's replay recording (`chronal run --record`; docs/reference/recording.md) | gzip members of ~30 game s as the run goes, an index line per member; not part of the snapshot (the dashboard lists them as `rec`) |
| `code/<sha16>.json`, `code/<sha16>.js` | the CODE store (section 9) | once per content, shared by the dir's runs |

- `<id>` is the tag with every run of characters other than letters, digits, `_`, `.` and `-` replaced by `_` (at
  most 80), `--`, and the start time in ms: `/^[\w.-]+--\d+$/`. Only `*--<digits>.json` files are runs. The run
  reserves its `<id>.json` with an exclusive create: when a running or removed run has that id (the same tag started in
  the same ms), the digits go up by one until one is free, so they are the start ms plus the runs that took it before.
- The dashboard's own files: `.dash.json` (card settings), `.launches.json` (launch registry), `.remove-when-done.json`;
  directories `removed/` (removed runs, with their grid, ctl, setup files and recordings; the CODE store stays), `logs/` (sim
  launch logs), `.launch/` (New sim's setup files of launches).

## 2. Conventions

- **The base:** the run's start (its 0:00): the first probe (every 100 game ms, at a lockstep window's end) that finds
  every character in game once the warm-up (`run.warmup_ms`) is over, a game time, the same for the same seed (the
  single-thread Sim probes once per real second); a snapshot is written at it (the history's row at t 0). Boot, the
  world's age (`world.age_ms`), login and the warm-up come before it; steering times (`steer[].t`) count from it. Every counter below is cumulative since the base unless it says
  otherwise; `measured_ms` is the game time since it. Per-hour rates are over `measured_ms`.
- **Units:** every `*_ms` is game ms. `t`, `t_out`, `t_back`, `first`, `last` are measured game seconds (integers;
  timeline rows and grid lines 1 decimal). `world.clock` and grid `v` are absolute virtual (world clock)
  ms. Shares are 0..1.
- **Raw and net:** an amount `{ raw, net }` has `raw` = what the server reported (the hit's damage, the heal's
  amount) and `net` = what it changed (the target's hp lost or gained: overkill and overheal removed). Overkill
  (`dmg.overkill`) and overheal (`heal.overheal`) are `raw - net`. The dashboard shows raw everywhere (overkill and
  overheal are meters of their own); `precision` says how each was measured.
- **Missing and null:** a missing key was not measured (shown "-", never 0); `null` means the field exists but has no
  value for this run or character (e.g. `modes` of a CODE that reports none).
- **Clamps:** every time counter (`alive_ms`, `combat_ms`, `party_ms`, a condition's `ms`, the sum of `modes`) is at
  most `measured_ms`.
- **Keys:** skills are the hit's source (`attack`, `burn`, a skill name); monsters their `G.monsters` type; players
  their character name; items their `G.items` key.

## 3. Top level

| field | meaning |
|---|---|
| `id`, `tag` | the file id; the card title (`--tag`, else the setup's name, else `<script> s<seed>`) |
| `strategy` | readable text of the run: the setup's `strategy`, else made from its roster, farms, notes and extras (" (no party)" once measured: the fighters were never all in one party) |
| `script` | `"chronal run"` |
| `versions` | `{ sim, code, code_hash }`: git version of the simulator (`<commit>[+<diff hash>]`: the last commit of the files that change what a run does, and a hash of their uncommitted diff; `sim/`, `lib/` and `codes/` but `sim/g_data.js`, `lib/compose.js`, `lib/pull.js`, `lib/example.js` and `lib/install.js`), git version of the first character's CODE directory ("?" outside a repo; a run without a setup: null), hash over every character's CODE (section 9) |
| `setup` | `{ format, file, name, from, hash }` (section 9); absent for runs without a setup |
| `setup_key` | hash of what defines the run (section 9: the setup without its run knobs, name, strategy and notes, plus the simulator version; a run without a setup: null): runs of one setup with other seeds or durations share it |
| `schema`, `schema_minor` | `2`, `3` |
| `precision` | how each family was measured (below) |
| `history_cols` | column names of the history rows (section 7) |
| `roster` | the run's characters in run order (section 5) |
| `started`, `updated` | ISO times (real) of the start and of this snapshot |
| `done` | `true` in the final snapshot |
| `proc`, `control`, `launch`, `end`, `run` | run control and how to run it again (section 4) |
| `virtual_ms`, `measured_ms`, `real_ms` | game ms since the start (after the world's age: `world.age_ms` is not in it), game ms since the base, real ms since the start |
| `trips_available` | whether merchant trips are measured (`false` in the single-thread Sim) |
| `speed` | `{ now, avg, median, min, max }`: game ms per real ms, now (since the previous snapshot; null when done), over the measured part, and the median, lowest and highest of the snapshots' |
| `load` | `{ now, avg }`: per thread the share of real time it was busy (the busiest limits the speed) (threads mode) |
| `gold` | `{ start, now }`: every character's gold plus each account's bank gold, at the base and now |
| `kills` | `{ total, by_type, others }`: monsters the run's characters killed since the base (last hits); `others`: `{ total, by_type, by: { <killer>: n } }`, the server's other kills (the game's fighting NPCs, e.g. Baron and Cunn; a killer is an NPC's name, a monster's type or `?`) |
| `deaths` | `{ total, groups, recent }`: groups by character, map, ~100 px and killer (`{ name, map, x, y, by, n, first, last, level }`, at most 60), the last 10 (`{ name, level, map, x, y, by, t }`) |
| `party` | section 5 |
| `merchant` | section 5; `null` without a merchant |
| `world` | `{ clock, globals, age_ms, mlevels }`: the virtual clock, the server's `{ goldm, luckm, xpm }` (below) |
| `grid` | `{ step_ms, cols, file, lines, gen, tail }` (section 8); `null` when there is none (null in the single-thread Sim) |
| `players` | one entry per character in game (section 6) (fighters by name, then the merchant) |
| `notes` | runner notes: `chronal` (a CODE getter the sim stopped calling, below) |
| `steer` | the setup's steering, each firing (docs/reference/setup.md): `[{ t, i, name?, why, at, character, what, note?, did, errors }]`; `t` game s since the base, `i` its step's index in the setup's `steer`, `why` what fired it (`"at 20m"`, `"when <condition>"`, `"30s after boss"`), `at` the setup's, `character` null for every one, `what` its keys and values or CODE as a line, `did` (`"storage <account>"`, `"code <name>"`), `errors` what it couldn't (`"<name>: not in game"`, `"<name>: its CODE is not running"`, a thrown error's message); `[]` without steering; a time fires at its exact game time, a condition on the `run.check` grid (`start.js steerer`) |
| `state` | the run's state exports ([state exports](export.md)): `{ exports: [{ label, at, t, dir }], pending }`; `at` the world clock (ISO), `t` game s since the base, `dir` relative to the live dir; `pending` the label of one asked for and not written yet |
| `banks` | each account's bank now: `{ <account>: { gold, free } }` (free: the empty slots of its packs); `{}` outside a setup's run; the server's copy (a mounted one inside the bank first) |

**world**

- `age_ms`: game ms the world ran with no characters before they logged in (the setup's `world.age`, less for a run
  stopped during it; 0: they logged in at the boot).
- `start`: the world's clock as it booted (ISO, UTC; the setup's `world.start`); `seasons`: the season switches it set.
- `forced`: the events the setup forced, as they fired: `[{ event, at_ms, t }]` (`t`: game s since the base).
- `events`: the dailies and nightlies seen on, each `{ from, to }`: game s since the base when a snapshot first and last
  saw it on (null: before the base).
- `mlevels`: `{ base, end }`, the monster levels at the base and at the end (the final snapshot), each `{ <instance>: {
  <type>: { n, avg, max } } }` or null (not read yet): per instance (a map's own instance is named like the map) the
  monsters alive by `G.monsters` type, their count, mean level (2 decimals) and highest level. Instances without such
  monsters are left out, and so are the types the server's level-up loop never levels (`cute`, `peaceful` or
  `stationary`: critters, pets, dummies, cave NPCs), read from the server's instances.

**precision**

| key | value |
|---|---|
| `dmg_done`, `dmg_taken`, `heal` | `"net"` (net measured) |
| `overkill`, `overheal`, `items`, `gold`, `gold_other` (hooks), `mana_by_skill` | `"exact"` |
| `sample_ms` | `250`, `null` in the single-thread Sim |
| `modes` | `"exact"`, `"coarse"` (single-thread Sim) |
| `grid` | `"exact"`, `null` without a grid |
| `attrib` | `"exact"`, `null` in the single-thread Sim |

## 4. Run control and provenance

```js
proc: { pid, host, start /* field 22 of /proc/self/stat, null off Linux */, cwd, cmdline /* raw /proc/self/cmdline, latin1 */,
        log /* where stdout goes when it is a regular file, else null */ },
control: { file: "<id>.ctl", stop /* the run takes stop requests */, ack /* seq of the last request applied */ },
launch: { key, rerun_of } | null,       // env CHRONAL_LAUNCH_KEY, CHRONAL_RERUN_OF: the dashboard launch that started it
end: { reason: "complete" | "stopped" | "failed", detail } | null,
run: {
  root,                                  // realpath of the chronal checkout that ran it
  script,                                // "chronal run"
  seed, duration_ms, warmup_ms, until,   // the plan (a setup's run block); null = until stopped / not set
},
```
- **Control file** `<id>.ctl`: `{ seq, stop?: true, at }`, written whole by the dashboard. The run reads it at its
  snapshot cadence (a stop halts it at the next game minute) and sets `control.ack` to the `seq` it applied. The run
  removes the file when it ends.
- **end / done:** `done: true` with `end.reason` `complete` (detail null, or `"until: <condition> at <N> game min"`
  when `run.until` ended it) or `stopped` (detail `"dashboard"`, the
  signal, or `"SIGTERM x2"` for a second signal) is final. A process that exits without closing (an exception) writes
  `end: { failed, "exit <code>" }` with `done: false` from its exit hook, and a run whose CODE asks for a slot its setup
  doesn't give (`require_code` / `load_code`) closes with `end: { failed, "<character>: require_code(\"<name>\"): ..." }`
  and `done: false` too (the dashboard shows both as failed). No `end` and a dead process: killed.

## 5. roster, party, merchant

```js
roster: [ { name, type, level, role, code, gear_hash,     // run order
            account, party, code_hash, online? } ],       // runs of a setup
party: { members, merchant, merchant_in_party, formed_ms, party_ms, groups, history },
merchant: { name, trips: [ { t_out, t_back, met, served } ], per_fighter: { <fighter>: { trips, meetings, deliveries, pickups,
            sent, received, gold_sent, gold_received, mluck } } } | null,
```
- `roster[]`: `type` the class; `level` the start level;
  `role` the setup's explicit role, else by class (priest healer, warrior and paladin tank, merchant merchant, else
  dps; never the CODE's, since the roster enters `setup_key`); `code` the entry (a slot name or the entry file's name);
  `gear_hash` hashes the gear at the base (`{ gear, gear_stat }` as `players[]` lists them);
  `account` the setup's account key; `party` whether the setup's `party.members` has it; `code_hash` its CODE's hash;
  `online` false only for a character that wasn't in game at the start (the setup's `online: false`: CODE starts it).
- `party.history` sums the fighters with a row at that `t` (one that left keeps its last values; one not in game yet
  has none).
- `party.members`: the roster's fighters (every character but the merchant); `merchant` its merchant's name or null;
  `merchant_in_party`: the merchant was seen in a server party with a fighter; `formed_ms`: measured ms from the base to
  the first sample with every member in one server party (0: already at the base; null: never, or fewer than 2
  members); `party_ms`: ms with every member in one party; `groups`: `{ <leader>: [names] }`, the server parties
  holding a run character; `history`: the fighters' history rows summed at the same `t` (level = the lowest).
- `merchant.trips`: the last 50 finished supply trips that met a fighter: out of town (main beyond 800 px of 0,0, not
  a bank map) until back (within 600 px), `met` the fighters it came within 400 px of, `served` per fighter what it
  handed over or took while out (`{ sent: { item: q }, received, gold_sent, gold_received }`). `per_fighter`: `trips`
  (finished trips that met it), `meetings` (approaches into 400 px), `deliveries` / `pickups` (finished trips that
  handed it something / took something), the items and gold sent and received (anywhere, in town too), `mluck` casts
  on it.

## 6. players[]

**Core**

| field | meaning |
|---|---|
| `name`, `type`, `level`, `start_level` | the class, the level now and at the base |
| `xp`, `max_xp`, `xp_gained` | xp in the level, the level's xp, xp gained since the base (across levels, net of death losses) |
| `gold`, `map`, `x`, `y`, `rip`, `free` | now: gold, place, dead, free inventory slots |
| `hpots`, `mpots`, `pots` | potions drunk since the base (hp, mp); `pots` by item |
| `kills`, `deaths` | last hits and deaths since the base |
| `trips`, `outings`, `town_visits` | the merchant's supply trips that reached a fighter and its trips out of town; a fighter's returns to town (respawns excluded) |
| `out_share`, `maps` | share of the run's game time out of town, per map |
| `gear`, `gear_stat` | `{ slot: "name+level" }` in the game's slot order; stat scroll types by slot |
| `stats` | the game's character sheet (the XP bar's panel) at the snapshot: `{ max_hp, max_mp, attack, heal, frequency, str, int, dex, vit, for, armor, resistance, courage, mcourage, pcourage, speed, mp_cost, lifesteal, manasteal, dreturn, reflection, evasion, miss, crit, critdamage, apiercing, rpiercing, goldm, xpm, luckm, tax }`, the keys the character has (live.js `STATS`) |
| `history` | history rows (section 7) |
| `measured_ms` | the run's measured ms |
| `online`, `sessions` | in game now; its sessions `[[t_in, t_out \| null], ...]` in game s from the base (online at the base: `[0, ...]`). A character that left (`stop_character`; between the two sessions of a page that reloaded after a disconnect) keeps its row as it left: counts, gear and conditions frozen, its history and grid rows flat, its modes up to its logout; one that logged in after the base counts from its login (history from then) |
| `inventory` | the bag: `[{ name, q, level, stat_type, p } | null]` |
| `hp`, `mp`, `s`, `mode` | now: hp and mp, the condition keys on it (`character.s`, sorted), its CODE's `chronal.mode` (null: none, or not in game) |
| `kills_by`, `last_kill` | its last hits by monster type since the base (`kills` = their sum); the last one's t (game s since the base; null: none) |
| `role` | the setup's explicit role, else the CODE's `chronal.role`, else by class |
| `code_status`, `modes_from` | the last status the CODE reported (`chronal.status`, a JSON tree; over 64 KB `{ truncated: true, bytes }`), null without one; `"chronal"` or null |

**Measured since the base**

| field | meaning |
|---|---|
| `party` | `{ name, share, ms, xp }`: its server party (the leader's name) and xp share now, ms in a party, xp received through party splits |
| `buffs` | `{ lonewolf, mluck, xpm, goldm, luckm }`: shares of the measured time with Lone Wolf and with mluck, the multipliers now |
| `alive_ms`, `combat_ms` | ms alive, ms in combat (a hit, miss or heal dealt or received within the last 3 s) |
| `credits` | kill credits (the server's count; merchants in a party get them too) |
| `casts` | `{ skill: n }`: successful uses (a reuse cooldown that starts later, on reappearing from invis or on a pickpocket, fishing or mining success, is not another use) |
| `dmg` | `done { raw, net }`; `by_skill { k: { raw, net, hits, crits, misses, casts } }`; `by_target { type: { raw, net, hits } }`; `taken { raw, net }`; `taken_by { cause: { raw, net, hits } }` (cause: monster type, player, `burn`, `dreturn`, `reflect`...; hits include fully absorbed ones); `taken_mp` (the mana shield's part); `avoided { miss, evade, avoid }`; `overkill` = done raw - net. Its own damage return counts as damage done (`dreturn`) |
| `heal` | `done`, `by_skill` (with `casts`), `by_target`, `received`, `received_by { <healer's name> | <potion> | regen_hp | lifesteal: { raw, net, hits } }`, `overheal` = done raw - net |
| `mana` | `spent`, `by_skill { skill: mp }`, `gained { pots, regen, steal, other }` (net) |
| `items` | `looted`, `consumed` (drunk, used, craft inputs), `bought { i: { q, gold } }`, `sold { i: { q, gold } }`, `sent { i: { to: q } }`, `received { i: { from: q } }`, `upgraded { i: { ok, fail, lost } }`, `compounded { i: { ok, fail } }`, `exchanged` (inputs), `crafted`, `mluck_dupes` (the merchant's copies), `from_exchange`, `other` (other gains, e.g. market parcels) and `held` (what it holds now minus at the base, by name: bag, gear, stand, and the bank for the merchant) |
| `gold_flow` | in: `loot`, `sold`, `stand`, `received`, `other`; out: `bought` (Ponty and bank packs included), `craft` (craft and dismantle), `sent`, `other_out`; `banked` = deposits - withdrawals. `gold - gold_start = loot + sold + stand + received + other - bought - craft - sent - other_out - banked` |
| `income` | loot + sold + stand |
| `chests` | `{ opened, dry, stale, gone }`: chests it opened; dry (opened from beyond 400 px) and stale (older than 8 min) pay with goldm 1; gone: already opened |
| `gold_start`, `xp_award`, `xp_lost` | gold at the base; xp awarded by kills (level-ups inside); xp lost to deaths |
| `modes` | `{ mode: ms }`: time per CODE mode (`chronal.mode`), each rounded to the ms, their sum at most `measured_ms`; null for a CODE that reports none |
| `server` | the server's own totals since the base `{ mdamage, cgold, xp }` (what `live_check` reconciles against) |

**Buffs and conditions** (null in the single-thread Sim)

| field | meaning |
|---|---|
| `conditions` | `{ key: { ms, n, max_ms, kind, v? } }`: every condition key (`p.s`) plus the pseudo keys `elixir`, `party`, `fear`, `booster`: ms on, intervals (less than 1 s apart = one), the longest; `kind` "buff" / "debuff" / "other" (citizen0aura, citizen4aura, newcomersblessing, elixir, party, booster, encouragement_* buff; fear, realmfatigue debuff; else the game's `G.conditions` flags); `v` only for citizen0aura (luck), citizen4aura (gold), mluck (the caster), encouragement_* (`"gold/xp/luck pPHASE"`), paladin_aura_* (`"caster rRANK"`) and the pseudo keys (elixir name, `"xpN luckN goldN"`, fear level, booster name) |
| `mult_avg` | time-weighted `{ xpm, goldm, luckm, enc_xp, enc_gold, enc_luck }` |
| `on` | for citizen0aura, citizen4aura, mluck, encouragement_new / lonewolf / returning, party, fear, poisoned: `{ ms, xp, credits, rkills, items, chests, loot_gold, x10, x50, dmg, taken, heal, hpots }` counted while the key was on (off = the totals minus on): its own amounts; `rkills` / `items` kills whose drop recipient it was and their chest items; `chests`, `loot_gold`, `x10`, `x50` chests it opened and the gold they paid everyone |
| `exact` | `{ angel_gold, angel_chests, angel_unmatched, kane_kills }`: gold paid only because the opener had Angel's aura (the server's formula at its goldm and at goldm - 2), the chests it was counted on, chests whose paid gold did not match the formula, kills made with Kane's aura |
| `timeline` | `{ gap_ms: 1000, cap: 200, key_cap: 40, dropped, dropped_by, since, rows }`: rows `[key, t_on, t_off | null, v]` (measured s) of every key as true intervals (the same key and value back within 1 s extends a row; fear keeps its highest level). At most 40 closed rows per key and 200 per character: past a cap the oldest closed row of that key (of the key with the most) goes; `since[key]` says from when a key's rows are complete (before it the grid's `c` has its uptime). `conditions` and `on` never come from rows |

## 7. History rows

`players[].history` and `party.history` are rows of `history_cols`:
`t, level, xp, hpots, mpots, kills, deaths, dmg, taken, heal, income, trips, dmg_raw, heal_raw, taken_raw`
(`t` measured s; the rest cumulative since the base; `dmg`, `taken`, `heal` net). Time-uniform: rows at least a step
apart, the last one the latest; over 300 rows the step doubles and the rows are thinned to it (row 0 kept).

## 8. The grid (`<id>.grid.ndjson`)

- Line 1: `{ "cols": [...], "step_ms": 30000, "id": "<id>" }`. Then the base's line (`t` 0), and a line per boundary of
  the game clock (every `step_ms`, from the setup's `run.grid_ms`, at least 10000): `{ t, v, r: { <name>: [cols...] }, c: {
  <name>: { <condition>: ms } } }`, `t` measured s, `v` the virtual clock's round time. The run's last line has
  `end: true` and equals the final snapshot.
- Columns (`grid.cols`), cumulative since the base: `level, xp, kills, credits, deaths, dmg, dmg_raw, taken, heal,
  heal_raw, income, loot_items, hpots, mpots, mana, gold` (gold now - gold at the base), `alive_ms, combat_ms,
  party_ms, c_citizen0aura, c_citizen4aura, c_mluck, c_lonewolf, c_party` (ms with that key on), `angel_gold`, `taken_raw`. Readers index by name. `c` has every condition with ms > 0 so far.
- Rows at the round times (within a lockstep window).
- Past 8 MB the file is rewritten keeping every other line older than the newest 24 game h (`grid.gen` + 1: readers
  start over). The snapshot keeps the last 10 lines inline (`grid.tail`, without `c`).

**The items' events (`<id>.items.ndjson`, `items_log: { file, lines, bytes, capped }`):** a line per event from the base
on, `t` measured s, `k` its kind, `who` the character:
- `loot`: `item`, `level` (when it has one), `q`;
- `upgrade`, `compound`: `item`, `from` and `to` (the levels tried), `ok`, `lost` (an upgrade's item gone);
- `stat`: a stat scroll's: `item`, `stat`, `ok`;
- `shiny`: an ingot's or a nugget's roll on an item with no scroll (its level stays): `item`, `level`, `offering`, `ok`
  (shiny);
- `give`: a handover: `to`, `item`, `level`, `q`; `gold`: `to`, `amount`.

Only appended to; past 16 MB a last `{ t, k: "cap" }` and no more (`capped`). The events add up to the ledgers
(`items.looted`, `upgraded`, `compounded`).

## 9. Setups: the snapshot's setup block, the side file, the CODE store

Every `chronal run` run runs a setup and writes, beside `<id>.json`:

```jsonc
// <id>.setup.json: the setup with everything resolved inline
{ "format": "chronal-setup/1",
  "resolved": { "at": "<ISO>", "by": "chronal run" | "tools/fingerprint.js",
                "from": "<the setup file it was loaded from>" | null },
  "name", "strategy", "notes"?, "run": { "duration", "warmup", "seed", "until", "check", "grid_ms" },
  "world": { "roi", "threads", "age", "ping" }, "party": { "members", "leader", "form" } | null,
  "code_names"?: { "<a name in the CODE>": "<a character of the run, or the same name>" },
  "steer"?: [ { "name"?, "at"?, "when"?, "for"?, "repeat"?, "window"?, "after"?, "character"?, "storage"?, "local_storage"?, "code"?, "note"? } ],
  "accounts": { "<key>": { "age_days", "bank": { "gold", "items0", ... } | null, "storage"?: { "<key>": <value> }, "local_storage"?: { "<key>": "<text>" } } },
  "characters": [ { "name", "class", "account", "role", "fps", "at": { "map", "x", "y" }, "params",
                    "state": { "level", "xp", "gold", "items", "slots", "skin"?, "cx"? } | null,
                    "code": { "entry", "slots": "<sha16>", "text": "<sha16>", "hash": "<sha8>" }, "note"? } ],
  "source": { "characters": { "<name>": { "code_dir", "recursive", "code_git", "entry", "file", "append", "extra", "prelude",
                                          "build", "fit"?, "state_from", "exported_at" } }, "accounts": { "<key>": { "bank_from" } } } }
```
- `state`: the character's start state (gear merged over the class's starter gear); a rerun starts from it.
- `code`: `slots` names the slot map in the store, `text` the composed entry, `hash` = sha8 of both. The store:
  `code/<sha16>.json` a slot map `{ name: text }` (JSON with sorted keys; sha1, 16 hex, of that text), `code/<sha16>.js`
  a composed entry (sha1 of its text). Content-addressed, written once, never moved with a run (`removed/` runs read
  `../code`); `chronal dash --gc-code` deletes what no side file uses.
- `world.ping`: the round trip to the server in ms (docs/reference/setup.md), default 18.
- `source`: where each character's CODE and state came from, for `chronal run <id>.setup.json --current-code`; `fit`: the
  code block's (docs/reference/library.md), the stored CODE is the fitted one.
- `code_names`: the CODE's names of characters as the run's (docs/reference/setup.md); the stored CODE is the mapped
  one, and a slot it renamed has the run's name: `code.entry` is that name, `source.characters[].entry` the slot on
  disk.
- `accounts.<key>.storage`, `local_storage`: the account's browser storage at the start (`get(key)`'s values; raw
  `localStorage` keys); `steer`: the steering steps, in their order (docs/reference/setup.md); `run.until`
  a condition as a step's `when`. All are in `setup_key`.
- The snapshot's `setup`: `{ format, file: "<id>.setup.json", name, from: resolved.from, hash }`, hash = sha8 of the
  side file's canonical JSON (sorted keys) without `resolved`.
- `versions.code_hash`: sha8 of the sorted `[name, code.hash]` pairs (every character's composed CODE, extras and
  party invites included). `setup_key`: sha8 of the side file without `resolved`, `source`, the run-only
  keys (`name`, `strategy`, `notes`, `run.*`) and the characters' `note`, plus the simulator version.
- `roster[]` of a setup's run carries `account`, `party`, `code_hash` (section 5).

## 10. What the CODE reports (chronal)

`modes`, `code_status`, `modes_from` and the CODE's part of `role` come only from the CODE's optional `chronal` object
(docs/reference/reporting.md); a CODE without it reports nothing (null; the role by class).
- The mode after every lockstep window, status and role every 10 game s at a window end (single-thread Sim: at its
  probe, once per real second). Every read goes through `report.js` `guarded()`: a getter that scheduled a timer,
  emitted, made a promise or wrote to the game log is not called again, its last value stands, and `notes.chronal` says
  so (`"<name>: <field> disabled (<why>)"`).

## 11. How it is measured

`sim/live.js`, on the server's main thread (nothing added to game objects, outcomes unchanged):

| family | how |
|---|---|
| damage | every "hit" as the server sends it (raw); net from the server's own damage and heal accounting |
| taken, heals received | the server's hp changes |
| heal done | raw and net at the server |
| mana | `consume_mp()` by skill |
| gold, items | per request: every character's gold and items before and after, by method |
| time counters, conditions | every 250 game ms |
| trips, time per map | every 100 game ms |
| kills | `kill_monster()` (last hits) |
| deaths | `rip()`, the killer from `defeated_by_a_monster()` |
| xp | `issue_monster_award()` before and after |
| grid | at the clock's round times |

## 12. Checking a snapshot

`node tools/live_check.js <dir>/<id>.json [RESULT.json]` reconciles a sim snapshot: damage net = the server's
`mdamage`, loot gold = its `cgold`, xp awards = its `xp`, the gold identity, held items = the item flows (skipped with
a note without `items.held`), by-skill and by-target sums, net <= raw, time counters <= measured, `on` against the
totals, Angel's gold, the timeline against `conditions`, the grid (its last row = the snapshot), history, party sums,
run control, `world.age_ms` and `world.mlevels` (their shape; base once measured, end once
done), and with a side file its format, characters = roster, hashes, CODE store and
`world.age` = `world.age_ms`.

