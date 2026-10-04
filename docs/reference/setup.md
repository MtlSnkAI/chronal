# The setup format (chronal-setup/1)

One JSON file describes a run completely: the characters (class, account, start state, place, CODE, data for the
CODE), the party, the accounts (bank, age, browser storage), the world, the run's length and seed, and steering.
`chronal run` runs it; `chronal example` prints an annotated one; `chronal new` and the dashboard's New sim write them.

```jsonc
{
  "format": "chronal-setup/1",
  "name": "ranger + priest @ squigtoad",   // the card title; default: the file name
  "strategy": null,                        // free text; default: made from the roster, party, farms, notes, extras
  "notes": null,                           // free text, part of the default strategy
  "run": { "duration": "30m", "warmup": "0m", "seed": 1, "until": null, "check": "1s", "grid_ms": 30000 },
  "world": { "roi": null, "threads": true, "age": "0m", "ping": 18, "start": "2026-01-01T00:00:00Z", "seasons": [], "events": [], "spawns": [] },
  "defaults": { "account": "main", "fps": 10, "code": { "dir": "lib", "entry": "main" } },
  "accounts": { "main": { "age_days": 0, "bank": { "from": "../Me.json" }, "storage": { "mode": "farm" } } },
  "characters": [
    { "name": "Ran1", "class": "ranger", "account": "main", "role": null, "fps": 10, "at": "main:-1175:422",
      "state": { "from": "../Ran1.json", "level": 60, "slots": { "mainhand": { "name": "firebow", "level": 7 } } },
      "code": { "entry": "Ran1" },
      "params": { "farm": { "map": "main", "x": -1175, "y": 422, "monsters": ["squigtoad"] } },
      "extra": ["log_on = true;"], "note": "firebow test" }
  ],
  "party": { "members": ["Ran1"], "leader": "Ran1", "form": "harness" },
  "code_names": { "MyRanger": "Ran1" },
  "steer": [{ "name": "boss", "when": "c.Ran1.kills.squigtoad >= 500", "storage": { "mode": "boss" } },
            { "after": "boss", "at": "10m", "code": "set_message('back')" }]
}
```

- Paths are relative to the setup file's folder (absolute ones work too). The comments above are for reading: a setup
  is plain JSON.
- Unknown keys are errors, so a typo never passes silently. `chronal run <setup> --check` lists every problem at once.
- Durations: `"500ms"`, `"90s"`, `"30m"`, `"2h"`, `"1d"`, or a number of minutes.

## run

| key | default | |
|---|---|---|
| `duration` | `"30m"` | measured game time, after the warm-up |
| `warmup` | `"0m"` | game time the characters play before the run starts: not measured (the run's 0:00 is its end: graphs, meters, counters, steering times) |
| `seed` | `1` | seeds every random number generator: the same seed and CODE give the same run |
| `until` | `null` | a condition (Conditions, below): the run ends early once it holds; `t` is game s since the warm-up |
| `check` | `"1s"` | game time between checks of `until` and the steering conditions; `"100ms"` to `"10m"` |
| `grid_ms` | `30000` | the step of the snapshot's grid (the dashboard's graphs), at least 10000 |

## world

| key | default | |
|---|---|---|
| `threads` | `true` | one thread per character plus the server's (fast); `false`: everything in one thread ([How the sim works](../explanation/sim.md)) |
| `roi` | `null` | freeze monsters out of every player's reach to save server CPU: `"box50"`, `"900"`, `"box50,m300"` ([How the sim works](../explanation/sim.md)) |
| `age` | `"0m"` | game time the world runs with no characters before they log in |
| `ping` | `18` | the round trip to the server in ms, as the game's `character.ping` |
| `start` | `"2026-01-01T00:00:00Z"` | the world's clock as it boots, a time with its zone (UTC: `Z`) |
| `seasons` | `[]` | the server's season switches on: `holidayseason`, `lunarnewyear`, `valentines`, `halloween`, `egghunt` |
| `ugrace` | `null` | the server's upgrade grace per level (`S.ugrace`, at the level an upgrade goes to; the grace formula takes `min(6, ugrace / 3)`): `null` a new realm's (24 at every level, the sim's every boot; a live realm carries what its players' upgrades make of it), a number, a list per level 0-24, or `{ "<level>": n }` over the 24s. Upgrades only: compounds have no server-wide grace |
| `ugrace_fixed` | `false` | `true`: held at those values (a busy realm's steady state: other players' upgrades keep it there) |
| `anniversary` | `true` | the anniversary event (the game server ships it on, "until manually disabled"): its baker on main, the anniversarygift and slice drops; `false`: none |
| `events` | `[]` | dailies or nightlies forced: `[{ "event": "goobrawl", "at": "20m" }]` (`crabxx`, `goobrawl`, `abtesting`, `icegolem`, `franky`), at game time after the warm-up |
| `spawns` | `[]` | a custom world: monsters put in it, `[{ "monster", "at": "map:x:y", "count", "radius", "level", "stats": { "hp", "attack", "armor", "resistance", ... }, "hp": "endless", "respawn": "5s" \| "no", "clear": 250 }]` |

- **age:** the server's own level-up loop runs meanwhile, so the characters meet monsters at the levels a server up
  that long, that nobody farmed, has (after 2 h: squigs and goos at L12, squigtoads at L6; a fresh boot has them all at
  L1). It changes the outcome, so it is part of the setup's identity (`setup_key`), not a run knob. The sim runs it at
  about 2000x. Nobody is in game meanwhile: rates count from the login, and the snapshot records `world.age_ms` and the
  monster levels (`world.mlevels`).
- **ping:** each message takes 0.4-0.6x the ping one way. It sets how soon CODE hears that a cooldown ended, so it
  moves the outcome: CODE on a 100 ms loop loses a tick per attack once cooldown + ping crosses a multiple of 100 ms.
  Live: about 3-5 ms from a server next to the game's, about 18 from a good home connection, 50 and more from a slow
  one. A lower ping runs slower (shorter lockstep windows).
- **start:** the server's events follow its hour, UTC - 5 (the sim's server is US): night is its hours 0-5 (monsters
  move slower and may sleep), a daily starts at 13 and 20 (crabxx, goobrawl or abtesting, in an order the seed shuffles),
  a nightly at 23 (icegolem or franky), once the server has been up 2 minutes (`lib/schedule.js`). The default,
  2026-01-01 00:00 UTC, is the server's 19:00: a 30 minute run crosses nothing, a daily comes at 01:00 UTC. The
  dashboard's New sim shows what a run crosses.
- **spawns:** a custom world, not as on live: said on the run's label and page. Each spawn puts `count` monsters of a
  game type (its look and stats) within `radius` px of `at`, made by the server as its own (`new_monster`), when it
  boots: `level` (at least; its level-up loop levels them on), `stats` over the type's (`hp`, `xp`: the monster's own;
  `attack`, `armor`, `resistance`, `frequency`, `speed`, `avoidance`: kept as the server keeps a monster's own stats),
  `hp: "endless"` (it never dies: a target dummy, for damage per second), `respawn` (game time after a death; `"no"`;
  default its type's), `clear` (the map's own monsters within that many px of the spot removed for good: an arena of
  its own). The CODE decides what to fight: the example bot farms `params.farm.monsters` at `params.farm`'s spot
  (New sim's World sets them).
- **seasons, events:** not as on live now, so said on the run's label and page. A season is on from the boot (its
  drops, monsters and events: halloween's, holidayseason's snowman...); a forced event starts at its time as the
  server's schedule starts one (its `var events`), whatever the clock says. Both change the outcome: part of the
  setup's identity.

## defaults

Merged into every character: `account`, `fps`, `code` (key by key: a character's `null` unsets one, e.g. `"entry":
null` to use a `file`), `at`, `state`, `params`, `extra`, `role`.

## characters

In run order (it seeds the client threads).

| key | default | |
|---|---|---|
| `name` | required | 1-12 letters and digits, unique ignoring case |
| `class` | required | `ranger`, `priest`, `warrior`, `mage`, `rogue`, `paladin`, `merchant` |
| `account` | `"main"` | characters with the same account share its bank, age and storage |
| `role` | by class | `dps`, `tank`, `healer`, `merchant` or `support`; else the CODE's (reporting.md), else priest healer, warrior and paladin tank, merchant merchant, the rest dps |
| `fps` | `10` | the client's frame rate (1-60); 10 is about 2.5x faster than 60 and tracked level and xp closely in tests |
| `at` | main's spawn | `"map:x:y"` or `{ map, x, y }` |
| `state` | a new character | the start state (below) |
| `code` | required | the CODE (below) |
| `params` | `null` | data for the CODE, read from `self.chronal.params` |
| `extra` | `[]` | CODE lines appended to the entry |
| `note` | `null` | free text |
| `online` | `true` | `false`: on its account but not in game at the start; CODE may start it (Switching characters, below) |

At most 3 characters and 1 merchant per account in game at the start, and at most 3 besides merchants in all (the
game's limits per account and per IP: the accounts of one `ip` label play from one, by default all of a run's; a
Steam- or MAS-linked account's fighters may be 36 from one IP, 3 per link). Their pages log in in setup order, at
most 5 not in game at once: the server disconnects an IP's other pages when more than 5 of its sockets have no
character yet, so more than 5 online characters start a few game seconds apart, as a browser's pages load on live.

**state** (all optional):
- `from`: an export (`chronal-export/1`: the snippet's, or a pull's `<Name>.json`), with `level`, `xp`, `gold`,
  `items`, `slots` on top (`slots` replace the export's gear).
- Without `from`: a new character: L1, 0 xp, 0 gold, 200 hpot0 and 200 mpot0, the class's starter gear (`slots`
  replace the starter weapon, helmet and shoes).
- Gear goes over the class's starter gear slot by slot, as the game makes a character: a given item replaces the
  starter's whole. With `from`, the gear is the export's (or the given `slots`) and nothing else: a starter slot it
  doesn't list starts empty.
- `skin`, `cx` (cosmetics `{ <place>: <cosmetic> }`): its looks, given or the export's; else the class's default look.
- `p`: its server-side state, which live never shows (modelling): `ugrace`, `cgrace` (15 numbers each: its upgrade and
  compound grace per level), `ograce`, `stats` (`{ monsters, monsters_diff, exchanges }`: the tracker's kill counts),
  `achievements`, `ap`, `firstbuff` (the holiday spirit taken), `encouragement_reached80`, `first`, `first_drop`, `dt`,
  `rewards`, `minutes`. Key by key over an export's tracker kill counts (the snippet exports them for a tracker holder).
- `s`: its conditions at the start (`{ <condition>: { ms, ... } }`), e.g. an mluck.
- A run's state export (`chronal run`'s `<id>.state/`, [state exports](export.md)) gives more: its server state (`p`,
  the stand included), its conditions and its hp, mp and death, as the run had them (`state.p` and `state.s` still go
  over them).
- Never taken from another export: conditions, the merchant stand. Never from any: the upgrade queue.

**params** standard keys: `farm: { map, x, y, monsters: [types] }` (the example bot reads it), `path: [{ to: level,
farm }]`; anything else passes through to the CODE.

## accounts

| key | default | |
|---|---|---|
| `age_days` | `0` | 0 = created at the run's start, so New Player (x5 xp at first, 40 days in 10-day phases, ends at L80) as a new player gets it; N = created N days before; from 40 on no New Player |
| `bank` | a new account's | `{ "from": <export> }` (its bank gold, packs, `unlocked` rooms and claimed `rewards`; other keys are left out, with a warning) or `{ "gold": 5000, "items0": [], ..., "unlocked": { "bank_b": true }, "rewards": [] }`; none: 1000 gold, two empty packs. A bank with packs in `bank_b` (items8-23) or `bank_u` (items24+) gets that room unlocked (an API pull's has no `unlocked`) |
| `cash` | the bank export's account cash, else 0 | the account's shells (a whole number) |
| `linked` | `null` (a web account) | `{ "platform": "steam" \| "mas", "pid": <id>, "newcomer": "auto" \| "claimed" }`: a Steam- or MAS-linked account (pid: a fixed 17 digits per account by default). Its logins have an auth id: the Newcomers' Blessing (+10 luck, gold and xp for 7 days, the first drop's 100k gold and items) for an account younger than 100 hours unless `"claimed"`, New Player and Lone Wolf grouped by the pid, and 3 x 12 fighters from one IP (3 per pid). A live export can't tell, so set it |
| `ip` | `"local"` | a label: accounts with one label play from one IP (`"local"`: the run's own, 127.0.0.1; another label its own address). The server tells IPs apart: its per-IP fighter limit counts each one's, and players of another IP are not "the same" (a merchant's trade xp from them, the send-gold fee, aggro, pvp). `chronal new` gives another player's account (a public page's) its own |
| `totals` | `true` | `false`: its characters' and its bank's gold out of the run's gold totals (the snapshot's `gold`, the party's sums, steering's `party`, `chronal new`'s rates), e.g. a market or observer account; its characters still have their own numbers. Not part of the setup key |
| `storage` | `{}` | what the CODE's `get(key)` returns at the start; `null` unsets |
| `local_storage` | `{}` | raw `localStorage` keys (text) |

Every account is verified and established (no anti-bot debuff).

## party

`members` (any characters, the merchant too), `leader` (default the first), `form`:
- `"harness"` (default): the leader's CODE gets a `send_party_invite` every 5 s and the others an `on_party_invite`
  that accepts the leader only (it replaces the CODE's own handler);
- `"code"`: the CODE forms the party;
- `"none"`: nobody invites.

Without `party`: no invites.

## CODE

```jsonc
"code": { "dir": "lib", "recursive": false, "entry": "Ran1", "file": null, "prelude": null, "append": ["adapter.js"],
          "build": { "cmd": ["node", "build.js"], "cwd": ".." }, "git": { "rev": "HEAD~2" },
          "fit": { "calls": { "2": "constants" }, "with": { "Ran1": ["helpers"] } } }
```

| key | |
|---|---|
| `dir` | every `*.js` directly in it is a slot named by its file name, as the game names slots, for `require_code(name)` / `load_code(name)` (found whatever the case) |
| `recursive` | `dir`'s subfolders too (not `.git`, `node_modules`, hidden ones); a second file of a name deeper in is `<its folder>-<name>` |
| `entry` | the slot the character runs; default: the slot named like the character |
| `file` | instead of `entry`: this file is the entry (then `dir` holds only modules) |
| `prelude` | CODE run before the entry, in the same text (globals, a config the CODE reads) |
| `append` | files whose text goes after the entry (e.g. an adapter that reports your CODE's state: [reporting](reporting.md)) |
| `build` | `{ cmd: [...], cwd }`: run once per distinct command before `dir` is read (`"node"` = this node), one at a time per folder (`.build-lock`); `--no-build` skips it |
| `git` | `{ repo, rev }`: read every path of the block from that git revision instead of the working tree (below) |
| `fit` | how CODE written for another account runs here ([the CODE library](library.md)) |

- A slot number (`load_code(2)`) fails the run: the sim knows slots by name (`fit.calls` names the slot of a number).
- A CODE that asks for a slot its setup doesn't give fails the run when it asks; `--check` warns of the literal names
  it finds missing.
- **Composition** (the same bytes every time): `self.chronal.params = <params>` (with `params`), the `prelude`, the
  entry, then each `append` file and each `extra` line, then the party harness.
- **git:** `repo` is a path in the repo (default the build's `cwd`, else `dir`, else `file`); `rev` a commit, branch or
  tag. The files are extracted once (`git archive`, read-only on the repo) into `cache/git/`, and the build hook runs
  there. The run records the commit, so a rerun with `--current-code` rebuilds that commit, whatever the branch says
  now.
- An entry that is an ES module (`import` / `export`) runs bundled with what it imports ([the CODE library](library.md)).

### Switching characters

CODE starts and stops characters of its account as a browser page does: `start_character(name, slot)`,
`stop_character(name)`, `get_active_characters()`, `command_character(name, snippet)` (threads mode only).
- A started character logs in at the next lockstep window; the promise resolves once it is in game.
- Its CODE: no slot (or its entry's name): its composed entry as the setup gives it; another slot: that slot's text.
- It may start its account's characters in the setup; those with `online: false` start there.
- After a logout the server saves the character before it can log in again: a quick restart waits, as on live.
- A page the server disconnects loads again 2.5 s later and logs its character in again, as the game's page does.

## code_names

CODE written for some characters names them (`fighters: ["MyRanger", "MyPriest"]`, `{ MyPriest: {...} }`).
`code_names: { <a name in the CODE>: <a character of the setup> }` runs it under the run's names; a name to itself
stays.

- **Mapped** (the CODE parsed): a string that is exactly the name (`'X'`, `"X"`, `` `X` `` without `${}`) and a property
  named so (`{ X: 1 }`, `a.X`, a method `X`; `{ X }` becomes `{ Y: X }`), in the files the CODE reads: its slots,
  entry file and appended files (not `prelude`, `extra` or `params`: the setup's own). A slot named after a mapped
  name takes the run's name, so `require_code`, `load_code` and the default entry find it.
- **Not mapped**, warned of: comments, a name inside a longer string or a template, in another case, a string that
  starts or ends one (`"My" + cls`), a file that can't be parsed.
- `chronal new` and the dashboard's New sim fill it in; a run's side file keeps it and the CODE as mapped.

## Storage, preludes and steering

What a player sets for their CODE besides the CODE: values in the browser's storage, a config in globals, and their
clicks on a control panel while it runs.

- **Storage:** per account (a player's characters share one browser). Each character's page gets its account's
  storage at the start; what one page `set`s the others don't see (threads mode: a page each).
- **Prelude:** `code.prelude`, see CODE.
- **Steering** (`steer`, in order): each step sets storage keys (`storage`, `local_storage`: its character's account's,
  without `character` every account's; `null` removes a key) and/or runs `code` in its character's CODE (without
  `character` every character in game), at the CODE's top level as the game's `command_character` does.

| key | |
|---|---|
| `name` | how `after` and `steps.<name>` refer to it |
| `at` | a game time since the run's start (the end of the warm-up: the graphs' 0:00), once; with `after`: the while after it |
| `when` | a condition (below), checked every `run.check` |
| `for` | `when` must hold that long first (`"5m"`) |
| `repeat` | `true`: fire again each time `when` holds anew |
| `window` | the window of the condition's rates (default `"10m"`) |
| `after` | fire after each firing of that step (`at` later) |
| `character` | whose CODE / account; none: everyone's |
| `storage`, `local_storage`, `code` | what it does |
| `export` | a label: the run's state now to `<id>.state/<label>/` ([state exports](export.md)) |
| `note` | free text |

A character not in game, or whose CODE isn't running, is reported. Each firing goes to the snapshot's `steer`, and the
dashboard marks it on the graphs. Times fire at their exact game time; conditions on the `run.check` grid. Checking
costs nothing measurable down to every 1 s, about 2% at 500 ms, 5-8% at 100 ms, and never changes what a run does.

### Conditions

An expression (JavaScript) of `c.<Name>` (each character), `party`, `t` (game s since the run's start, after the
warm-up), `world` and `steps`. It reads the run's own snapshot at that moment, counted since the run's start, so a
condition needs live snapshots (`--no-live` refuses one). Nothing is checked or fires during the warm-up.

| `c.<Name>.` | |
|---|---|
| `kills.<monster>`, `kills.total`, `deaths`, `rip`, `since_kill` | its last hits by type; deaths; dead now; game s since its last kill |
| `level`, `levels`, `xp`, `xp_gained`, `hp`, `max_hp`, `mp`, `max_mp` | now; levels gained; xp gained |
| `gold`, `gold_gained`, `bank_gold`, `bank_free` | its gold; its account's bank gold and free slots |
| `items.<item>`, `free`, `best.<item>` | held in its bag; free bag slots; its highest level of an item in bag and gear (-1: none) |
| `looted.<item>`, `looted.total`, `used.<item>`, `drunk`, `chests` | items looted, used, potions drunk, chests opened |
| `upgrades.ok` / `.fail` / `.total`, `compounds.*` | its upgrade and compound rolls |
| `trips`, `party`, `online`, `map`, `x`, `y`, `class` | the merchant's supply trips; its party's leader (else null); in game |
| `s.<condition>` | a condition on it now (`s.mluck`), the game's `character.s` keys |
| `mode`, `status` | its CODE's reported mode and status ([reporting](reporting.md)) |
| `rate.xp_h`, `rate.kills_h`, `rate.gold_h`, `rate.looted_h`, `rate.dmg_s`, `rate.taken_s` | over the step's `window` |
| `near.<monster>`, `near_level.<monster>` | in its view now: how many, the highest level (-1: none) |
| `log(/pattern/)` | its game log lines matching, since the start |
| `get("key")` | its storage's value now (a literal key) |

- `party`: every character together (the merchant too): the counts summed (`party.kills.total`, `deaths`, `levels`,
  `xp_gained`, `gold`, `items.*`, `looted.*`, `rate.*`...), `best.*` the highest, `since_kill` the fewest s, `size`,
  `online`, `dead` (how many), each account's bank once.
- `world.alive.<monster>`, `world.level.<monster>`: alive on the server, the highest level; `world.events.<event>`: a
  server event on.
- `steps.<name>`: `{ n, t }` once that step fired (its count, its last game s), else undefined.
- A count it doesn't have reads 0. A name a condition can't read (`kills.goo` without `c.<Name>.`), a field `c.<Name>`,
  `party` or `world` doesn't have (`c.Ran1.kils`), an unknown character or step is a setup problem (`--check` lists
  it). A condition that throws while running reads false; the run warns once.
- Examples: `c.Ran1.kills.squigtoad >= 500`, `party.kills.total >= 50`, `c.Mer.bank_free < 5`, `c.Ran1.rate.xp_h <
  400000` with `for: "5m"`, `!c.Ran1.s.mluck`, `c.Ran1.log(/Out of potions/) > 0`, `steps.boss && t >= steps.boss.t + 600`.

## The side file and the CODE store

Every run writes, beside its snapshot `<id>.json` in the live folder:
- `<id>.setup.json`: the setup with everything resolved inline (`resolved: { at, by, from }`, the final start states,
  each character's `code: { entry, slots, text, hash }`, and `source`: where each character's CODE and state came
  from). The dashboard's "Download setup.json" gives this file.
- `code/<sha>.json` (a slot map) and `code/<sha>.js` (a composed entry): content-addressed, written once, shared by the
  folder's runs; `chronal dash --gc-code` deletes what no side file uses.

`chronal run <id>.setup.json` runs it again with its stored CODE and states (the same seed and duration: the same
run); `--current-code` resolves each character's CODE from `source` again, build included. A side file saved
elsewhere reads its CODE from the store of `--live DIR`, else the configured live folder.

The snapshot's `setup_key` hashes the setup without its run knobs (`name`, `strategy`, `notes`, `run.*`), with the
sim's version: runs of one setup with other seeds or durations share it, and the dashboard groups them.
