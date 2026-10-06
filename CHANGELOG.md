# Changelog

What changed in each ChronAL release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version
(0.x.0) adds features and may change a format or an output; its **Upgrading** section says what to change. A patch
version (0.x.y) only fixes.

ChronAL's formats carry their own versions: setups `chronal-setup/1`, snapshots `schema` 2 (`schema_minor` grows as
fields are added), state exports `chronal-export/1`, recordings `chronal-rec/1`.

## [Unreleased]

### Fixed

- Replays of runs where a character's page loaded again: a broken last line in its recording's index froze the replay
  at its first moment. The index now skips such lines, so these replays play (the sessions before the last one stay
  lost).
- A recording keeps every session of a character: when its page loaded again (its CODE's `disconnect()`, or the
  server's after a third death by burn in one session) or it was started again, the recording started over and only
  the last session could be replayed. A replay now plays through each reload.
- A replay's console no longer fills with "Weird resolve_deferred issue" errors: the recorded server answers to the
  recorded CODE's calls are quiet in the replay page.

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

[Unreleased]: https://github.com/MtlSnkAI/chronal/compare/v0.6.0...develop
[0.6.0]: https://github.com/MtlSnkAI/chronal/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/MtlSnkAI/chronal/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/MtlSnkAI/chronal/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MtlSnkAI/chronal/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MtlSnkAI/chronal/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/MtlSnkAI/chronal/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MtlSnkAI/chronal/releases/tag/v0.1.0
