# Commands

`chronal <command> [options]`; `chronal help` lists them. Exit codes: 0 done, 1 failed, 2 usage or setup problems
(every problem listed). `chronal --version` prints its version: `package.json`'s (a release, its tag `vX.Y.Z`), with
`+<commit>` in a checkout off that tag and `.<hash>` of uncommitted changes (e.g. `0.6.1+ccad481`), as snapshots record
it (`versions.chronal`).

| command | |
|---|---|
| [`run`](#chronal-run) | run a setup in the sim |
| [`example`](#chronal-example) | print an annotated setup |
| [`new`](#chronal-new) | compose a setup from pulls, templates, CODE sets; check or run it |
| [`ps`](#chronal-ps) | the runs running |
| [`stop`](#chronal-stop) | stop runs |
| [`dash`](#chronal-dash) | the dashboard |
| [`install`](#chronal-install) | get the game the sim runs |
| [`pull`](#chronal-pull) | pull your live account, or another player's public page |
| [`library`](#chronal-library) | the CODE library ([reference](library.md)) |
| [`code-sets`](#chronal-code-sets) | list the CODE sets |
| [`g-data`](#chronal-g-data) | cache the game's data (the dashboard's item tooltips) |

## chronal run

```
chronal run <setup.json | <id>.setup.json> [--duration 2h] [--warmup 2m] [--world-age 2h] [--ping 18] [--seed N]
            [--age-days N] [--tag T] [--live DIR | --no-live] [--result out.json] [--no-build] [--current-code]
            [--record] [--check] [--code-set NAME [--missing NAME=SLOT|idle|exclude,...]] [--trust] [--export DIR | --no-export]
chronal run --code my.js [--dir DIR] --class ranger [--name N] [--level 40] [--at map:x:y] [--farm type[,type]] [--duration 30m] [...]
```

| option | |
|---|---|
| `--check` | load and resolve the setup (CODE built), print one JSON line, run nothing |
| `--duration`, `--warmup`, `--seed` | override the setup's `run` |
| `--world-age`, `--ping` | override the setup's `world` |
| `--age-days N` | every account's age |
| `--tag T` | the dashboard card's title (default: the setup's name) |
| `--live DIR` | where snapshots go (default: config `live_dir`); `--no-live`: none (then no conditions or steering by condition) |
| `--record` | a replay recording per character ([recordings](recording.md)); threads mode only |
| `--result out.json` | the numbers as JSON (below) |
| `--no-build` | skip the setups' build commands (env `CHRONAL_NO_BUILD=1` too) |
| `--current-code` | for a run's `<id>.setup.json`: the CODE its source gives now instead of the stored |
| `--start ISO` | the world's clock as it boots (`world.start`, e.g. `2026-10-31T18:00Z`) |
| `--code-set NAME` | every character's CODE from that set ([CODE sets](library.md#code-sets)); `--missing` for characters it has no entry for. With a run's `<id>.setup.json`: its characters and states as they were, their CODE from the set (e.g. a new version of the one it ran); not with `--current-code`, `--missing ...=exclude` not for it |
| `--trust` | trust others' CODE not trusted yet without asking ([trust](library.md#trust)) |
| `--export DIR` | where the run's state exports go (default `<id>.state/` beside the snapshot; [state exports](export.md)); `--no-export`: none |
| `--code FILE --class C` | a one-character setup without a file: `--dir` its slots, `--name`, `--level`, `--at`, `--farm` (sets `params.farm`) |

- `<id>.setup.json` (a run's side file, beside its snapshot) runs that run again: its stored CODE and start states.
- It prints its pid. SIGINT / SIGTERM, `chronal stop` or the dashboard's Stop end the run at the next game minute with
  its final numbers (with `--no-live` too); a second signal exits at once. `chronal new --run` and the fidelity tool's
  `sim.js` pass SIGINT / SIGTERM on to their runs and start no more.
- A CODE that asks for a slot its setup doesn't give fails the run (exit 1).
- Warnings and errors (the sim's, its pages' and their CODE's: `[sim <name> CODE] ...`, `[sim <name> page] ...`) print
  once each per page; repeats are counted at the end ("[sim] <name>: 15 more of: ..."), and every one stays in the
  snapshot's game log. A page's "Weird resolve_deferred issue: <call>" is the game's own: an answer to a socket event
  its CODE (or the game's `disconnect()`) sent itself, without the game's function.
- At its end (done, stopped or halted) the run writes its state ([state exports](export.md)) to `<id>.state/end/`; the
  dashboard's Export state and a steering entry's `export` write one while it runs.
- `--result`: `{ seed, warm, minutes, vmin, speed, real_s, halted, setup, live, state, characters: { <name>: ... }, fighter,
  merchant }` (`state`: the end state's directory); per character, named as the snapshot names them: `level`,
  `start_level`, `xp_gained` and `xp_h`, `xp` and `max_xp` (in its level), `gold`, `gold_gained`, `kills`, `deaths`,
  `map`, `mode`, `lonewolf`, `gear` and `gear_stat`, its stats at the end (`goldm`, `luckm`, `xpm`: as they were then,
  conditions such as citizens' auras and mluck in), `mult_avg` (their mean over the measured part; null without live
  snapshots), `online`, `outside` (an account out of the totals); `fighter` is the first non-merchant's.

## chronal continue

```
chronal continue <run id | <id>.json | <id>.setup.json> [--label end] [--live DIR] [--duration D] [--seed N] [--start ISO]
                 [--seasons a,b | none] [--at end | spawn] [--reseed ACCOUNT,...] [--save FILE] [--run [-- run options]]
```

A setup that goes on from a run's state export ([state exports](export.md)): long progressions as stages. Writes it to
`--save` (default `<id>.state/<label>/continue.setup.json`) and prints its path; `--run` runs it (`chronal run`, with the
options after `--`).

| option | |
|---|---|
| `--label` | which export (default `end`: the one the run wrote at its end) |
| `--duration`, `--seed` | the new run's (else the run's) |
| `--start ISO` | the world's clock (default: the export's time, so New Player phases, events and seasons' windows go on) |
| `--seasons a,b \| none` | the new run's seasons (a season window ends between stages) |
| `--at spawn` | every fighter at its map's first spawn instead of where it was (it would be back in a fight before its CODE runs again) |
| `--reseed A,B` | those accounts as the run's setup gave them (e.g. a market account that starts each stage fresh) |

Not carried: the run's world age, warm-up, forced events and steering (the first stage's); the CODE is what its source
gives now (dir, file, entry, appends, extras, build), not the run's stored copy.

## chronal example

Prints an annotated setup (ChronAL's example bot: a ranger and a priest at the squigtoads). Its comments are whole
lines, so `chronal example | grep -v '^\s*//' > my.json` leaves plain JSON.

## chronal new

Writes a setup the way the live game is set up (who is logged in, from what state, running what CODE), always saved
(below), then checks or runs it. The dashboard's New sim does the same.

```
chronal new --chars Merch,Ranger,Priest                          # continue from now: the latest pull's states, places, CODE
chronal new --template setups/party.json --run                   # a template, its exported states refreshed from the pull
chronal new --char Mage1:mage:60 --gear Mage1:mainhand=firestaff+7 --code-set mine
chronal new --char Mage1:mage:60 --gear-set Mage1=mage-mid --gear Mage1:orb=jacko+5
chronal new --template t.json --sweep-gear-set Ranger=ranger-mid,ranger-late --seeds 1,2,3 --run
chronal new --template t.json --sweep-gear Ranger:mainhand=bow+8,firebow+7 --seeds 1,2,3 --duration 30m --run
chronal new --template t.json --sweep-code-set mine,mine@HEAD~1 --seeds 1,2,3 --run
chronal new --player SomeName --chars Merch,SomeName,TheirPriest --missing TheirPriest=idle
chronal new --chars Ranger,Priest --storage mode='"farm"' --steer '20m mode="boss"' --steer '25m@Priest run use_skill("partyheal")'
```

| option | |
|---|---|
| `--template FILE` | start from a setup |
| `--pull latest\|ACCOUNT\|ACCOUNT/TIME\|DIR` | the pull to take states, bank, age and CODE from (default: the latest) |
| `--player ACCOUNT\|ACCOUNT/TIME\|DIR` | another player's public page (taken with `chronal pull --player`), repeatable |
| `--chars A,B,...` | who, in order: the template's, else the pull's, else the players' pages' characters of those names |
| `--char NAME:CLASS[:LEVEL]` | a character from scratch |
| `--offline A,...` | on its account but not in game (CODE may start it) |
| `--state NAME=pull\|template\|fresh`, `--level NAME=N`, `--at NAME=map:x:y` | one character's start |
| `--gear NAME:SLOT=ITEM[+LEVEL][:STAT]\|none` | a gear slot, checked as the game's `can_equip_item` decides |
| `--gear-set NAME=SET` | a gear set worn: every slot but the elixir (one the set leaves out: empty); `--gear` goes on top. Built in: `<class>-early`, `-mid`, `-late` (a list shared on the game's Discord, which may be out of date; items that take a stat scroll have the class's main stat); yours: config `gear_sets_dir` (`<name>.json`, `{ "format": "chronal-gear-set/1", "name", "class", "gear": { "<slot>": "<item spec>" } }`; New sim saves them) |
| `--account KEY`, `--account-of NAME=KEY`, `--account-age KEY=DAYS`, `--account-bank KEY=none\|ACCOUNT`, `--age-days N` | accounts |
| `--party A,B,...[/harness\|code\|none]`, `--no-party` | the party (default: the template's, else the fighters, formed by CODE; on the example bot by the sim's invites) |
| `--code-set NAME`, `--missing NAME=SLOT\|idle\|exclude,...` | the CODE (default: the template's, else the pull's, else the example bot: the built-in set `example`) |
| `--code-name CODENAME=NAME`, `--no-code-names` | names of characters in the CODE ([code_names](setup.md#code_names)) |
| `--prelude NAME=CODE` | CODE run before that character's entry |
| `--storage KEY=VALUE`, `--local-storage KEY=TEXT` | every account's browser storage at the start (VALUE: JSON, else text; `null` unsets) |
| `--steer "AT[@NAME] KEY=VALUE"`, `--steer "AT[@NAME] run CODE"`, `--steer JSON` | steering steps (replace the template's list) |
| `--until EXPR`, `--check-every 1s` | `run.until`, `run.check` |
| `--start ISO`, `--season NAME`, `--event NAME@AT` | `world.start`, a season on, a daily or nightly forced at a game time (e.g. `goobrawl@20m`) |
| `--anniversary on\|off` | `world.anniversary` (left out: as the game ships it) |
| `--spawn JSON`, `--param NAME\|*=JSON` | a custom world's spawn (`world.spawns`, e.g. `'{"monster":"bigbird","at":"main:-200:300","hp":"endless"}'`); params merged into a character's (`*`: every one's), e.g. `'*={"farm":{"map":"main","x":-200,"y":300,"monsters":["bigbird"]}}'` |
| `--sweep-gear-set NAME=A,B,...`, `--sweep-gear NAME:SLOT=A,B,...`, `--sweep-code-set A,B,...` | one setup per value (per combination), in a folder: a sweep. A set compared is worn in place of that character's `--gear-set` and `--gear` (`--sweep-gear` goes on top of it) |
| `--duration`, `--warmup`, `--seed`, `--ping`, `--world-age` | run and world settings |
| `--name NAME`, `--save PATH`, `--force` | where: `--save` (a file, a folder for a sweep), else config `setups_dir`; an existing file stays unless `--force`; the default name is the template's (else `now`) and the pull's time (else now) as `MMDD-HHMM` in UTC |
| `--check` | write and resolve each setup |
| `--run [--seeds 1,2,3] [--jobs N] [--live DIR \| --no-live] [--no-build]` | run each setup for each seed, `--jobs` at a time, then a table of the means |
| `--trust` | trust others' CODE without asking |

- A pulled character starts as pulled where it was (main's spawn when that place isn't in the sim's game). Every account
  holding a pulled state takes the pull's bank and age.
- Another player's characters play on their own account: no bank, 40 days old, at main's spawn (a public page shows no
  place, inventory or gold: each takes those of your pull's character of its class, else a new character's). Their
  CODE: the run's, with its character names mapped to the run's.
- The game's limits are checked: 3 characters and 1 merchant in game per account, 3 besides merchants per IP.
- The printout lists the CODE each character runs and why, names in CODE, the storage keys the CODE reads that no
  account sets, and warnings.

## chronal ps

```
chronal ps [--dir LIVE] [--all]
```

The runs running in the live dir (default: config `live_dir`) and its folders (`<folder>/<id>`): id, state (`running`; `stalled`: its process runs, no
snapshot for 15 s), pid, speed, game minutes, tag. `--all`: every run (also `done`, `stopped`, `failed`).

## chronal stop

```
chronal stop <run id | <id>.json ...> [--dir LIVE] [--force [--wait 10]]
chronal stop --tag T [--all] | --all
```

Asks each run to stop, as the dashboard's Stop: a request in `<id>.ctl` it takes at its next poll (about once a real
second); it ends at its next game minute with its final numbers and its end state. `--tag T`: the running runs with
that tag (several need `--all`); `--all` alone: every running run. `--force`: SIGTERM to the run's process, only when
it is verified on this host (pid, start time, cwd), then SIGKILL if it hasn't ended after `--wait` seconds. Exit 1 when
no run matches or one couldn't be asked or signalled.

## chronal dash

```
chronal dash [--port 8089] [--host 127.0.0.1] [--dir LIVE]
chronal dash --gc-code [--dir LIVE]        # delete the CODE in <dir>/code/ (and each folder's) that no setup file uses
```

From another machine: `ssh -N -L 8089:localhost:8089 <user>@<this machine>`, then http://localhost:8089/.
[The dashboard](dashboard.md).

## chronal install

```
chronal install [--update | --latest | --check]
```

Installs the game the sim runs, at the commits this chronal is tested with (`upstream.json`):
- clones the game's three repos (`adventureland_mongodb`, `common_engine`, `adventureland_secretsandconfig`) into config
  `upstream` when missing, and checks each out (detached) at its pinned commit, fetching it when the clone doesn't
  have it yet;
- copies the game into `runtime/app` (the repos stay untouched: the game rewrites files as it runs), runs
  `npm install` there when its `package.json` changed, and writes its settings (`runtime/secretsandconfig`: a local
  server, this install's own keys);
- records what it installed in `runtime/installed.json`, and writes its game data for the dashboard
  (`chronal g-data`). `chronal run` and the dashboard warn when that isn't the
  pin (after updating chronal to a release that moves the pin, or after `--latest`): run `chronal install` again.

Options:
- `--update`: fetch the repos first.
- `--latest`: upstream's newest commits instead of the pins, for trying a newer game. Untested with this chronal:
  runs may fail or differ.
- `--check`: installs nothing. Per repo the pinned, installed and upstream's newest commits, and how many commits
  upstream is ahead of the pin (it fetches the repos).

A chronal release moves the pin: its changelog says so, and runs on the new game don't group with earlier ones
(snapshots record the game's commit, `versions.game`, and it is part of the setup key). A weekly check (the repo's
GitHub Actions, `.github/workflows/upstream.yml`) runs the tests on upstream's newest game. When they fail it opens a
new issue each week (label `upstream`) and closes the week before's; when they pass it closes the open one.

## chronal pull

```
chronal pull [--account NAME] [--no-code] [--no-game-check]   # every character, the bank, the CODE slots
chronal pull --add FILE... [--into PULLDIR]                   # snippet exports over the latest pull's
chronal pull --list                                           # the pulls and the players' pages taken
chronal pull --player NAME                                    # another player's public page
chronal pull --top [TEXT]                                     # the site's top 500 characters (name or class has TEXT)
```

Reads your account through Adventure Land's token API (the one the VS Code extension uses; it changes nothing) into
`<pulls_dir>/<account>/<time>/`. The token: env `CHRONAL_AL_TOKEN`, else the first line of config `al_token_file`
(default `config/al_token`, where the dashboard's Settings saves it); create one at https://adventure.land/vscode. `CHRONAL_AL_API` overrides the API's address, `CHRONAL_AL_SITE` the site.

A pull folder:

| file | |
|---|---|
| `pull.json` | what was pulled (`chronal-pull/1`): characters, bank, CODE, the account's age, the game check, warnings |
| `<Name>.json` | a character as the export snippet writes it (`chronal-export/1`), the bank inside; `state.from` takes it |
| `<Name>.api.json` | the API's copy of a character a snippet export replaced (`--add`) |
| `bank.json` | the pull's bank |
| `code/<slot>.js`, `code/slots.json` | every CODE slot by name (a character's own slot is named after it) |
| `game-diff.json` | the game data entries live differs in from the sim's game |

- **Freshness:** the API serves the game's saved state: an online character's is at most about 24 s old, a bank open
  in game may be stale, a character mid-upgrade has its result only on the server. The pull warns of each.
- **Snippet exports** (`snippets/export-state.js`, run in the character's CODE on live) are exact; `--add` puts them
  over the pull's characters, and one exported inside the bank becomes the pull's bank. The snippet copies the export
  to the clipboard (JSON; over 64 KB: `chronal-export:gz:` and the gzipped JSON in base64), else downloads
  `<Name>.json`; `--add`, a setup's `state.from` and the dashboard's Add export take either.
- **The game check:** live's game data (items, monsters, skills, classes, maps...) against the sim's game, entry by
  entry; a difference beyond wording is a warning (the sim may not match live).
- **Another player** (`--player NAME`): their account's public page (`adventure.land/player/<name>`) into
  `<players_dir>/<account>/<time>/`, a folder of the same kind: each character's class, level, gear and looks, nothing
  else (no inventory, gold, bank, place, account age or CODE). What the sim's game lacks is left out, with a warning.

## chronal library

[The CODE library](library.md).

## chronal code-sets

```
chronal code-sets [--names A[:class],...]
```

Lists the CODE sets a setup can take (`--names`: which entry each would run for those characters, `Pri1:priest` with
its class).
[CODE sets](library.md#code-sets).

## chronal g-data

Boots the game once and writes its `G` (the game data a browser gets) to `cache/G-<version>-<game commit>.json`, for
the dashboard's item tooltips and research tools; the installed game's is the one read (`chronal install` writes it).
The game's version number alone stays the same across its commits. Config `g_data` points at another one instead
(e.g. the live game's, saved as a file).
