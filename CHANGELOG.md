# Changelog

What changed in each ChronAL release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version
(0.x.0) adds features and may change a format or an output; its **Upgrading** section says what to change. A patch
version (0.x.y) only fixes.

ChronAL's formats carry their own versions: setups `chronal-setup/1`, snapshots `schema` 2 (`schema_minor` grows as
fields are added), state exports `chronal-export/1`, recordings `chronal-rec/1`.

## [Unreleased]

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

[Unreleased]: https://github.com/MtlSnkAI/chronal/compare/v0.1.1...develop
[0.1.1]: https://github.com/MtlSnkAI/chronal/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MtlSnkAI/chronal/releases/tag/v0.1.0
