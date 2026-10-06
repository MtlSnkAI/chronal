# Changelog

What changed in each ChronAL release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version
(0.x.0) adds features and may change a format or an output; its **Upgrading** section says what to change. A patch
version (0.x.y) only fixes.

ChronAL's formats carry their own versions: setups `chronal-setup/1`, snapshots `schema` 2 (`schema_minor` grows as
fields are added), state exports `chronal-export/1`, recordings `chronal-rec/1`.

## [Unreleased]

### Fixed

- New sim: a pull's warnings are small chips on one line: its characters online in one ("online: MtlSnk, MtlSnkRan"),
  each other warning by its first words, the whole text on hover. A whole sentence per chip filled several lines.
- The weekly upstream check uses actions/checkout and actions/setup-node v7 (Node 24): v4 ran on Node 20, which GitHub
  deprecates.
- The weekly upstream check opens a new issue each week its tests fail and closes the week before's (it commented on
  one open issue, which could be a user's report).
- chronal's measuring code no longer fails silently: a hook around a game function (or a probe, a sample) that throws,
  or a chest's gold under Angel's aura that doesn't match the server's formula, is printed once and listed in the
  snapshot (`hook_errors`, schema 2.9; `notes.chronal`); `tools/live_check.js` checks it. The tests (`npm test`, the
  weekly upstream check) fail on one, so a game change that breaks a hook shows up.
- The sim's socket.io server has the game's newer calls: `engine` (the game defers its socket writes to the end of a
  tick) and `to()` (it sends to lists of sockets, and a roulette bet to a room): every real sim failed on the game
  from 98783128, and a roulette bet failed already on 90052162. Fix by @Thefonze74065
  ([#1](https://github.com/MtlSnkAI/chronal/issues/1)).

## [0.8.0] - 2026-10-06

### Upgrading

- Run `chronal install` once after updating: it records the game it installs (`runtime/installed.json`), and until
  then `chronal run` and the dashboard warn. It checks your upstream clones out at the pinned commits (detached) when
  they are elsewhere.
- Runs record the game's commit, and it is part of the setup key: runs from this version on don't group with earlier
  runs of the same setup. Snapshots: schema 2.8 (`versions.game`).

### Added

- A program running chronal's sim itself can start a character's thread from its own script: `addCharacter`, `declare`
  and `login` take `worker` (the script, kept through reloads and restarts) and `extra` (more `workerData`), and
  `sim/client_host.js` exports `makeWindow`, `run`, `exec` and `RUNNER_FILES`. The protocol: [How the sim
  works](docs/explanation/sim.md#a-hosts-own-client-thread). ([#2](https://github.com/MtlSnkAI/chronal/issues/2))
- `chronal install` installs the game at the commits this chronal is tested with (`upstream.json`; the game at
  90052162), not upstream's newest: a fresh install works with the release it comes with
  ([#1](https://github.com/MtlSnkAI/chronal/issues/1)). `--latest` installs upstream's newest (untested), `--check`
  shows how far upstream is ahead. `chronal run` and the dashboard warn when the game installed isn't the pin.
  Snapshots record the game's commit (`versions.game`, schema 2.8), shown with the run's versions and in Compare.
  ([cli](docs/reference/cli.md#chronal-install))
- A weekly check (GitHub Actions, `.github/workflows/upstream.yml`) runs the tests on the game's newest commits and
  opens an issue (label `upstream`) when they fail, saying which upstream commit broke which tests; it comments when
  they pass again. A game change that breaks chronal shows up before anyone moves the pin to it
  ([#1](https://github.com/MtlSnkAI/chronal/issues/1)).

### Changed

- Compare names a series in one short line: at most 3 of its changes from the baseline, the ones that change results
  first (characters, gear, CODE, run and world settings); the rest in its "+N" chip, listed by group. Versions, CODE
  names, the world's start date and account ages are only in that list. A run that shares less than half of its
  characters with the baseline shows its own label and "other setup: N differences". The charts' legends name each
  series by its name only, the full label on hover. ([dashboard](docs/reference/dashboard.md))

### Fixed

- Compare no longer lists settings a run's setup file from an older version leaves out as changes (world.anniversary
  true -> none, world.ugrace_fixed false -> none): a setting left out reads as its default. A change whose two sides
  read the same (world.ugrace none -> none) is not listed.

## [0.7.0] - 2026-10-06

### Added

- `chronal --version` prints chronal's version, and snapshots record it as `versions.chronal` (schema 2.7): a
  release's `0.6.1`, or `0.6.1+<commit>` from a checkout off a release tag (`.<hash>` with uncommitted changes). The
  dashboard shows it in a run's Versions (its Run tab), in Compare's list of what changed between runs (chronal none
  -> 0.7.0, against a run from before), and on the sim chip of a run whose sim differs from its name's other runs.
  ([cli](docs/reference/cli.md))

## [0.6.1] - 2026-10-06

### Fixed

- A recording keeps every session of a character: when its page loaded again (its CODE's `disconnect()`, or the
  server's after a third death by burn in one session) or it was started again, the recording started over and only
  the last session could be replayed. A replay now plays through each reload.
- Replays of runs where a character's page loaded again: a broken last line in its recording's index froze the replay
  at its first moment. The index now skips such lines, so these replays play (the sessions before the last one stay
  lost).
- The dashboard's replay no longer logs a 404 error in the browser's console for each character not in game yet at the
  replay's moment (its Characters sheet): the sheet is empty then.
- A replay's console no longer fills with "Weird resolve_deferred issue" errors: the recorded server answers to the
  recorded CODE's calls are quiet in the replay page.
- Replay pages no longer load the game's Google Analytics: a replay sent a pageview to Google for every character's
  frame.

## [0.6.0] - 2026-10-06

### Added

- Measure a live realm's upgrade grace: `tools/ugrace/probe.js` (CODE, for live and the sim) asks the server for the
  chance of upgrading each item in the bag, without upgrading anything, every few minutes for hours;
  `tools/ugrace/invert.js` solves the readings for the server's grace per level and prints a `world.ugrace` for a
  setup. See [Measure a realm's upgrade grace](docs/how-to/measure-upgrade-grace.md).
- `state.p.item_num` sets a character's lucky upgrade slot (0-41): an upgrade of the item in that bag slot gets a
  lower roll 6 times in 10. The server draws it once per character. ([setup](docs/reference/setup.md#characters))

### Fixed

- State exports keep the lucky upgrade slot: each stage of a continued run drew a new one.

## [0.5.0] - 2026-10-06

### Added

- `chronal ps` lists the live dir's runs and whether their processes run; `chronal stop <id> | --tag T [--all] |
  --all [--force]` stops them. A process is verified by its pid, start time and working directory before it gets a
  signal. ([cli](docs/reference/cli.md))
- `chronal run` prints its pid and stops at the next game minute on SIGINT or SIGTERM, also without live snapshots.
  `chronal new --run` and the fidelity sim pass the signals on to their runs and start no more.
- Folders in the live dir: runs one folder down show in the dashboard, `chronal ps` and `chronal stop` as
  `<folder>/<id>`. The runs list gets a Folder filter; a removed run goes to its folder's own `removed/`.
  ([dashboard](docs/reference/dashboard.md))

## [0.4.0] - 2026-10-06

### Added

- `world.ugrace` and `world.ugrace_fixed`: the server's upgrade grace per level (a number, a list or `{ level: n }`;
  default 24 at every level, a brand-new realm's), optionally held at those values. A live realm's is usually far
  lower, so a sim's upgrades succeed more often than live's unless a setup sets it.
  ([setup](docs/reference/setup.md#world))
- `world.anniversary`: the anniversary event on (the game server's default) or off. In a sim its baker and drops were
  always on.
- `world.seasons` entries take `from` and `to` (game times after the warm-up): seasons switch on and off as a run goes.
  The snapshot's world lists `seasons_on` and `season_switches`; a state export records the seasons on and
  `chronal continue` takes them.
- `accounts.<k>.ip`: accounts with one label play from one address, other labels from others (default: every account
  local, 127.0.0.1, as before). With different addresses a merchant gets trade xp from another account's buyer, and
  the per-IP fighter limit counts per address. `chronal new` gives another player's account its own address.
  ([setup](docs/reference/setup.md#accounts))

## [0.3.0] - 2026-10-06

### Upgrading

- `chronal run --result` names its fields as the snapshot does: `xp` is now `xp_gained`, and `xp` and `max_xp` are the
  xp within the level; `slots` is now `gear` and `gear_stat` (with the stat type). New: `mult_avg`, `outside`.
- Snapshots (schema 2.6): a character's chest gold is split into `gold_flow.chest` (the chest's own gold), `egold`
  (the monster's) and `enc` (encouragement receipts) instead of one `loot` flow; `income` sums the three.
  ([snapshot](docs/reference/snapshot.md))

### Added

- Market trades are recorded: a stand's sale and a filled buy order are an items event each, in both sides' ledgers,
  with their own gold flows (`stand`, `traded`). The dashboard's Items has a Traded tab. (schema 2.4)
- The game log in the snapshot: each character's last 30 lines, and counts of CODE errors and console errors. The
  dashboard's Game log fold fills, with an error mark and a CODE errors metric. (schema 2.5)
- Each upgrade and compound try records its scroll, offering, the server's chance, the roll, and the grace before it;
  the dashboard's Items shows them per try.
- `accounts.<k>.totals: false` keeps an account (e.g. a market account) out of the run's gold totals; its characters
  keep their own numbers. ([setup](docs/reference/setup.md#accounts))

## [0.2.0] - 2026-10-06

### Upgrading

- `chronal run` now writes every character's state at the end of a run, to `<id>.state/end/` beside the snapshot.
  `--no-export` skips it, `--export DIR` writes it elsewhere.

### Added

- State exports and `chronal continue`: an export holds each character's exact state (raw items and gear, server-side
  state, the whole bank, shells, link, age, the pages' storage). The dashboard's Export state and a steering entry
  write one while a run goes, and the snapshot lists them (schema 2.3); `chronal continue <id>` makes the next stage's
  setup from one, `--run` runs it. ([export](docs/reference/export.md))
- Setups set a character's server-side state: `state.p` (upgrade grace, tracker kill counts, achievements, first-time
  flags) and `state.s` (conditions), and an account's shells (`accounts.<k>.cash`). An export's tracker counts are
  imported, so their stat bonuses come along; `chronal pull` keeps the shells.
  ([setup](docs/reference/setup.md#characters))
- Steam- and Mac App Store-linked accounts (`accounts.<k>.linked`): the Newcomers' Blessing and first-drop bonus,
  encouragement grouped by the link, and the linked per-IP allowance. ([setup](docs/reference/setup.md#accounts))

## [0.1.1] - 2026-10-06

### Fixed

- Two runs of one tag that started in the same millisecond shared all their files. Run ids now never collide, and
  `chronal new --run` gives each seed of a multi-seed run its own tag (one seed keeps the setup's).
- 6 or more characters online at the start all get into the game (the server's per-IP rule disconnected the 6th);
  a page that loads again during the warm-up no longer crashes the run.
- An exported character starts with the export's gear only: a starter helmet, shoes or weapon no longer comes back
  in a slot the export leaves empty.
- A bank keeps its unlocked rooms and claimed rewards, and packs in `bank_b` or `bank_u` unlock those rooms (a
  pulled bank's inner rooms refused its merchant). A bank key ChronAL doesn't take is a warning.
- The server's random numbers from `crypto` come from the run's seed: the Cave of Many Dreams, the tavern's games and
  generated maps repeat per seed. Runs that use them differ from 0.1.0's.
- The client's `G` is what the game's `/data.js` serves: drops, upgrades, compounds and monster gold were missing,
  and items, monsters, sets and classes carried fields only the server has. `chronal g-data` writes that `G`.
- The server's messages to all realms (level 80, blessings, a first login) reach the players; its calls to other
  addresses fail in one line instead of a stack trace.
- The items log: an ingot's or a nugget's roll without a scroll is a `shiny` event, not a +1 upgrade; a merchant's buy
  orders are not counted as items it holds.
- Skill casts: a skill's cooldown restart is not another cast (invis, pickpocket, fishing and mining counted twice).
- The fidelity tools find runs whose names have dots, skip a run's file that isn't written yet, and no longer fail on
  an earlier run's recording.

## [0.1.0] - 2026-10-03

The first release: Adventure Land's real game server and clients on a virtual clock, running your CODE unmodified and
headless at 100x and more, with a dashboard, replays, and fidelity checks against live.

[Unreleased]: https://github.com/MtlSnkAI/chronal/compare/v0.8.0...develop
[0.8.0]: https://github.com/MtlSnkAI/chronal/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/MtlSnkAI/chronal/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/MtlSnkAI/chronal/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/MtlSnkAI/chronal/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/MtlSnkAI/chronal/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/MtlSnkAI/chronal/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MtlSnkAI/chronal/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MtlSnkAI/chronal/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/MtlSnkAI/chronal/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MtlSnkAI/chronal/releases/tag/v0.1.0
