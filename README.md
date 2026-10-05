# ChronAL

Run your Adventure Land CODE, unmodified, against the game's own server and client on a virtual clock, as fast as
your CPU allows (often 100x and more). The same seed and CODE give the same run. A dashboard shows every run live,
compares runs, starts new ones, edits your CODE in the game's own editor and runs it again, and plays recorded runs
back in the game's own page.

Use it to try a farming spot, a gear set, a party or a new version of your CODE in minutes instead of days, before you
put it on your live characters.

ChronAL is not the live game: no other players, no lag spikes, and numbers that depend on exact timing (deaths,
damage taken, potions) can differ. [How close it is](docs/explanation/fidelity.md).

## How it works

```
setup.json --> chronal run --> the game's server     \  one process, one virtual clock:
(characters,                   + a game client        |  every timer jumps straight to
 CODE, states,                   per character        |  the next one, nothing sleeps
 party, length)                  running your CODE    /
                                       |
                                       v
                     live/<id>.json (snapshots)  --> chronal dash --> your browser
                     live/<id>.rec/ (recordings)     (charts, compare, rerun, replay)
```

- A **setup** (one JSON file) describes a run: the characters, their CODE and start states, the party, the accounts,
  the length and the seed.
- `chronal run` boots the game's real `server.js` and one real game client per character (headless), and runs your
  CODE in them, as the game's CODE editor would.
- While it runs it writes a **snapshot** about once a second: what each character did, measured from the server's
  own state. The dashboard reads them.

More: [How the sim works](docs/explanation/sim.md).

## Requirements

- Linux, Node.js 24 or newer, git.
- Per run: a CPU core per character plus one for the server, and about 1.5 GB of memory for 3-4 characters.

## Install

```sh
git clone <this repo> chronal && cd chronal
npm install
npm link            # puts `chronal` on your PATH (or use: node chronal.js ...)
chronal install     # downloads the game's code into upstream/ and prepares runtime/
```

## Try it

```sh
chronal example | grep -v '^\s*//' > my.json   # a ranger and a priest farming squigtoads
chronal run my.json                            # 31 game minutes in about half a minute
chronal dash                                   # open http://localhost:8089/
```

The [first run tutorial](docs/tutorials/first-run.md) walks through this, then a recorded run and its replay.

## Documentation

**Start here**
- [Your first run](docs/tutorials/first-run.md): run the example, read the dashboard, record and replay a run.

**Guides**
- [Run your own CODE](docs/how-to/run-your-code.md): one file, a folder of slots, a build step, reporting.
- [Start from your live characters](docs/how-to/start-from-live.md): pull your account, compose a run from it.
- [Compare runs](docs/how-to/compare-runs.md): seeds, sweeps of gear or CODE, reruns, the dashboard's Compare.
- [Run someone else's CODE](docs/how-to/run-others-code.md): the CODE library, trust, fitting.
- [Steer a run](docs/how-to/steer-a-run.md): storage, steering steps, stopping on a condition.
- [Check the sim against live](docs/how-to/check-against-live.md): the same CODE on a live server and in the sim, compared.
- [Measure a realm's upgrade grace](docs/how-to/measure-upgrade-grace.md): read a live realm's `S.ugrace` for `world.ugrace`.

**Reference**
- [Commands](docs/reference/cli.md), [settings](docs/reference/config.md), [the setup format](docs/reference/setup.md)
- [The CODE library](docs/reference/library.md), [what CODE reports](docs/reference/reporting.md)
- [The dashboard](docs/reference/dashboard.md), [snapshots](docs/reference/snapshot.md), [recordings](docs/reference/recording.md)

**Background**
- [How the sim works](docs/explanation/sim.md): virtual clocks, threads, determinism, what differs from live.
- [How close it is to a real server](docs/explanation/fidelity.md).

## Layout

| folder | what |
|---|---|
| `sim/` | the sim (`chronal run`) |
| `lib/` | setups, steering, CODE sets, the CODE library, recordings, pulls, settings |
| `dashboard/` | the dashboard (`chronal dash`): its server, and `app/` its page |
| `viewer/` | replays of recorded runs in the game's own page, served by the dashboard |
| `codes/` | `example/`: the example bot (a fighter for any class, a priest, a merchant; the CODE set `example`); `idle.js` |
| `snippets/` | `export-state.js`, to export a live character's state |
| `tools/` | development tools; `fidelity/`: the CODE and scripts that check the sim against live |
| `docs/` | the documentation |
| `test/` | `npm test` |

## License

[MIT](LICENSE). Bundled in `dashboard/app/vendor/`, each under its own license: Preact (MIT), htm (Apache-2.0) and
CodeMirror's search add-ons (MIT) ([LICENSES.txt](dashboard/app/vendor/LICENSES.txt)).

The game itself is not part of ChronAL: `chronal install` downloads [Adventure Land](https://adventure.land)'s own
repositories, which come under their own license (AdventureLandOnlyUse, in each repository).
