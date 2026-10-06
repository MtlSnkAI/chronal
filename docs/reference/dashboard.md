# The dashboard

`chronal dash` serves a page that shows every run in the live folder as it runs, compares runs, starts new ones and
plays recorded runs back. It lists the live folder's runs and those in its folders, one level down (e.g.
`live/fidelity/`, where the fidelity tools write): a folder's run has the id `<folder>/<id>`. It runs in its own process and only reads the runs' files, so it costs the runs nothing.

## The page

A sidebar to go anywhere and the page open beside it, each page at its own URL (bookmark it, share it, use the
browser's back and forward):

| URL | page |
|---|---|
| `#/runs` | the Runs table |
| `#/runs/<run id>[/<tab>][?replay]` | a run's page (a group's: `g:<key>`) |
| `#/compare[/<tab>]?ids=<id>,<id>...` | Compare (the first is the baseline) |
| `#/new`, `#/new?from=<run id>[&runs=N]` | New sim; Rerun of a run (N seeds) |
| `#/new?pull=<id>`, `?account=<name>`, `?player=<id>` | New sim with that pull, crafted account or player's page |
| `#/code[/<set>[/<file>]]` | CODE |
| `#/gearsets[/<name>]` | Gear sets (one open) |
| `#/accounts` | Accounts |
| `#/settings` | Settings |

**The sidebar:** the colours by its name (light, dark, or your system's as it changes; kept in this browser;
`?theme=light` or `?theme=dark` before the `#` sets one for that page), where to go (Runs, New sim, CODE, Gear sets,
Accounts, Settings), then the runs list:
- a row per run, running and finished together: its state as a colour (running green, stalled: alive, no update for
  15 s; done grey, stopped amber: killed or stopped early; failed red), its party (a bar per character in its class
  colour; hover: class, name, level), its short label (the setup's name, then chips for what sets it apart from the
  other runs of that name: items, CODE, the sim's version (labelled with chronal's version when the run has one),
  warm-up, world age, ping, account age) and its game time;
- filters by state, folder (when the live folder has runs in folders) and name; sorting by any column;
- **Groups:** runs of one setup (`setup_key`), duration, warm-up and Until fold under a group row; their numbers come
  from the runs that didn't fail, each seed once (a run is deterministic per seed and CODE);
- **The queue:** a launch past the free sim threads (one per character plus the server's, up to
  `CHRONAL_THREADS_MAX`) waits as a row and starts, in order, as threads free up; it survives a restart of the
  dashboard;
- **A launch's row** (starting, queued, failed): a click opens its page, a Run tab with its progress and log (its
  "log" link opens the log too); once its run shows up, the page becomes the run's Run tab, the log still open;
- a click on a row opens its page; the checkboxes pick runs and groups (8 at most, a colour each), and **Compare**
  under the list compares them (2 or more runs; a group counts its runs). On the Compare page, the picks are its series.

**Runs** (the Runs table): every run the list's filters pass, with its rank by the headline metric, up to 6 more metric
columns (**Columns**: 33 metrics in 7 groups, saved for every page on that live folder), deaths, game time, seed and
start. **Remove finished** moves every finished and stopped run to `removed/` beside it (`live/removed/`,
`live/<folder>/removed/`).

**A run's page:** its seed, state, short label and rank, then its actions: **Replay** (a recorded run), **Rerun**,
**Stop run** and **Export state** (running: every character's state now to `<id>.state/`, [state exports](export.md)),
**Remove** (to the `removed/` beside it with its state exports; a running run is stopped first). Its tabs:
- **Characters**: a sheet per character as the game shows it (HP, MP and XP bars, gear with the game's tooltips,
  conditions, stats; More,
  Inventory, Game log folds: its last 30 lines, CODE errors in red; a red mark by its name counts them); with the
  replay shown they follow the replay's moment. Below, Items (from the run's
  items' events): Upgraded, per item and step (+X -> +Y: succeeded, failed, lost) and each try; Traded, per item and
  each sale at a stand or into a buy order (seller, buyer, price, tax); Looted, each loot
  (when, who, what).
- **Data**: the headline tiles, then panels you compose in 1 to 4 columns (Add a panel, Columns, Defaults), the same
  on every run, group and Compare page and saved for the dashboard. A panel's grip drags it to another place (the
  places marked while dragging, the one under the pointer highlighted; Esc puts it back; on the focused grip the arrow
  keys move it); its x removes it. A panel is a metric (XP, Damage, Damage taken, Healing, Healed, Overkill,
  Overheal, Mana spent, Kills, Potions, Gold, Loot; Level; Items), its **Total** or **Per second** / **Per hour**
  (named as itself: Damage or DPS), shown as **Meters** (per character and the party; a click on a row breaks it
  down), a **Breakdown** (the party's, by skill, target, source, item, monster, cause) or **Over time** (every
  character plus the party: the rate over a rolling window, or the total so far; steering steps as triangles). A
  series under the pointer (its line within 12 px, or its key) stands out, the others faded; a key's click hides it.
- **Buffs and debuffs**: a lane per condition per character; the citizens' auras on vs off.
- **Supply**: the merchant's trips, deliveries per fighter (each item at its level), potions received vs drunk, upgrade
  and compound rolls, each handover (when, from, to, what).
- **Monsters**: a row per monster type, the hunted ones first: the run's kills and kills per game hour, the server's
  other kills, how many there were and their levels at the base and at the end, the deaths each caused; then the
  deaths (where, by what, when).
- **Run**: the run's facts (its start time, seasons, the events it saw and forced, its versions: chronal's as
  `chronal --version` prints it, the CODE's and the sim's commits, ...), its setup (per character: start state, CODE, params, extras; accounts, party, steering;
  "Download setup.json"), its launch and log, the CODE's status tree.
- **Replay** (a recorded run): the game's own page playing the run over the tabs, a button per character, a bar with
  the time, the speed, pause and a scrubber; Hide the game folds it to a bar. Clicking a graph or a buff lane seeks it.
  [How replays work](recording.md).

**A group's page:** the same tabs over its runs: means with +/- sd. Rerun (its newest run that can), Remove (its runs).

**Compare:** the series in the URL (runs and groups). **Summary**: per headline metric each series' mean and its change
from the baseline, coloured only when Welch's t-test gives p < 0.05; per character; the timeline (mean and sd band);
every run as a dot; a sweep's metric against the swept setting. What a series changes from the baseline lists the
settings it differs in, the sim's commit and chronal's version included (`none` for a run from before 0.7.0). The other tabs: Detail's, per series. A click on a
series makes it the baseline.

**New sim** (the page): a setup composed as `chronal new` does, previewed on every change:
- Start from a template (config `setups_dir`) or none, a pull (Pull now with a token; Add export: Copy the snippet,
  run it in the character's CODE on live, then paste what it copies, or drop its file: that character exactly as on
  live over the pull's);
- Who is logged in, per account: each character In game, Offline or Out; New character; Add an account (a crafted
  one: its characters with their gear, CODE and age; a player's page taken); Add player (another player's public
  page). Edit opens a character: gear as the game's sheet with a picker (Compare items sweeps a slot), Gear set under
  it (its class's sets as small sheets: a click wears one, or with Into the inventory puts its items in the inventory
  while they fit, as many sets as fit; Compare sets runs each; the sheet saved as a set of yours, yours removed by
  their x), inventory, level, gold, state, place, CODE set and entry, account, prelude. An account of new characters only: Save as account
  (Update the account: a crafted one);
- CODE: a set for all and others to compare it with (none: the template's, the pull's, else ChronAL's example bot);
  the CODE picker (your sets, the library, pulls, ChronAL's; `set@rev`); Add CODE (a link, a folder, a paste, files);
  Others' CODE to trust; Names; Fit;
- Party; Run: duration, Seed and Runs (a run per seed from Seed up), Record a replay; Starts (the world's clock, UTC,
  with presets: the default, a daily or a nightly 10 minutes in, at night; and what the run's span crosses: night,
  dailies, nightlies, when); Events (seasons on, a daily or nightly forced at a game time; flagged on the run's label);
  World (a custom world: A dummy, An arena, a row per spawn: monster, spot, count, level, endless hp, attack, armor,
  resistance, respawn, clear; the example bot farms them: every character's `params.farm`; flagged "custom world");
  Advanced: warm-up, ping, world age, Storage, Steering, Check every, Until.
- Check resolves and builds every setup; Save writes them to `setups_dir`; Start runs each setup for each seed.

**Rerun** (the New sim page from a run): the run's setup file again, from the next seed, changed as you like: CODE
stored (the original's, from the live folder's CODE store) or current (resolved again from its source, built),
or another set (a CODE set's: a new version from the CODE page, a copy, any other: `chronal run <its setup file>
--code-set`), duration, Seed and Runs (a run per seed), Record a replay, and under Advanced the warm-up, world age, ping, account
age, the world's start, one setting swept over a list of values. The bar has the name, the dry run's warnings and Start. A batch skips
seeds that already ran to their end with that setup; an identical run (same seed, stored CODE and duration as one that
finished) is not started unless it is to be recorded.

**CODE:** a CODE set's files (its picker: your sets, the library, pulls, ChronAL's) in the game's own editor
(CodeMirror, its look: the pixel font at 24px, long lines wrapped), Check and Save (Ctrl+S); a file with a syntax
problem is saved only with Save anyway. In the editor: Ctrl+F find, Ctrl+G and Shift+Ctrl+G the next and previous,
Shift+Ctrl+F replace, Shift+Ctrl+R replace all, Alt+G go to a line (CodeMirror's search add-ons, vendored). What a
save does, as the page says for the set (`dashboard/code.js`):
- your folder or file (your sets file's, `dir:`, `file:`, the library's folder of this machine): written in place;
- CODE ChronAL keeps (the library's pasted or uploaded CODE, your copies): a new version, a commit, pinned
  (`<set>@<commit>`: an older one);
- ChronAL's example bot, a pull, others' CODE at a link's commit, a set at a git revision: your copy in the library
  (a name of yours; trusted when what it copies was yours or trusted);
- a set built by a build step: read-only (edit its sources).
**Runs with this CODE** (the runs whose setup files used the set, or the set a copy copies): Rerun and compare runs
each again with the CODE as saved (the folder now, `current_code`; else the set at its newest version, `code_set`) at
its own seed; once the new run has begun, Compare opens both. **Remove** (the library's CODE, asked again): its
library entry goes; a pull's CODE goes with its pull (Accounts); your sets file's sets are removed there.

**Gear sets:** every gear set (`lib/gear_sets.js`; `chronal new --gear-set`) by class, each as a small sheet (a
class's filter over them): the built-in ones (early, mid and late game per class, a list shared on the game's Discord
that may be out of date) and yours (config `gear_sets_dir`). A click opens one as the game's sheet with the game's
tooltips. Yours are edited there: a slot's click opens the items its class may wear there (a search; the arrows; another
class's dimmed), then its level, stat scroll and title; its red x or Delete empties it; saved as you go. Rename, Copy as
yours (a built-in one too), Remove (asked again); New set (a class and a name: an empty sheet).

**Accounts:** every account a run can play on. An account owns its CODE, as on live: its characters run it unless a
run picks another set for one of them.
- **Yours**: the live account as pulled, by account (the newest pull; how many), its bank, age and characters, its CODE
  (the pull's slots: set `pull:<account>`, each character its own slot); Pull now; New sim with it; Remove older pulls
  (all but the newest), Remove (its pulls and their CODE), each asked again.
- **Crafted**: accounts made here (config `accounts_dir`, `lib/accounts.js`): a name, an age, a CODE set (else the
  run's), characters (name, class, level; gear: from New sim's editor, Update the account). New account, Edit, Remove,
  New sim with it.
- **Other players'**: their public pages taken (Add player): class, level and gear, read-only; New sim with them;
  Remove (its pages, asked again).

**Settings:**
- **Live account**: where the API token comes from (`CHRONAL_AL_TOKEN`, the file config `al_token_file`, or none);
  the steps to set one up: create it at adventure.land/vscode, paste it, **Test** (the game's token API says which
  account it is: its characters), **Save** (in `config/al_token`, mode 0600; a token file of yours is never
  overwritten); then **Pull now**. The token never goes back to the page.
- **Folders and port**: each path of [the settings](config.md) and the port, its value and where it comes from
  (default, `config/local.json`, the environment: read-only); Save writes `config/local.json`, applied when
  `chronal dash` starts again.

## Run control

A run's snapshot says which process writes it (`proc`: pid, start time, cwd), how to reach it (`control`: `<id>.ctl`),
how it was started (`run`, `launch`) and how it ended (`end`).
- **Stop:** a request in `<id>.ctl`, which the run polls about once a real second and acknowledges; it ends at its next
  game minute with its final numbers. Force stop sends SIGKILL, only to the verified process (pid, start time, cwd on
  this host), with no final snapshot.
- **Remove:** a finished run moves to the `removed/` beside it (`live/removed/`, `live/<folder>/removed/`) with its side
  files (grid, setup, recordings, state exports); move them back to restore it. A running one is stopped and moved once it has ended.
- **Launches** (reruns, New sim's starts) run detached, `live/logs/<launch key>.log`, and are listed until their run
  shows up (cancel before); the registry is `live/.launches.json`.

## API

Every change needs the page's `x-dashboard: 1` header, a same-host Origin and a Host that is `localhost`, an IP
address or `--host`; JSON bodies up to 4 KB unless noted.

| method, path | body | answer |
|---|---|---|
| GET `api/live` | | the runs, each with `state` and `ctl` (`alive, stop, force, rerun, rerun_why, rerun_setup, recorded, pending, remove_when_done`) and `rec` (its recorded characters) |
| GET `api/control` | | `{ viewer: { up }, sims: { threads_busy, threads_max }, launches }` |
| POST `api/launch` | `{ of, duration?, seed?, tag?, current_code?, code_set?, age_days?, warmup?, world_age?, ping?, record?, dry? }` | dry: 200 `{ plan }` (command, warnings, setup, world); else 202 `{ launch }`; 400 / 404 |
| DELETE `api/launch/<key>` | | cancel before its run shows up, or dismiss an ended one |
| GET `api/launch/<key>/log?tail=60` | | `{ path, lines }` |
| POST `api/runs/<id>/stop` | `{ force? }` | 202 `{ seq }`; force: 200 `{ signal }` |
| DELETE `api/live/<id>[?stop=1]` | | 200 `{ removed }`, 202 `{ stopping }`, 409 while running without `stop=1` |
| POST `api/clear-finished` | | the runs moved |
| GET `api/setup/<id>[?download=1]` | | the run's resolved setup file |
| GET `api/grid/<id>?from=<byte>&gen=<n>` | | the grid file from that byte: `{ gen, from, next, more, reset, text }` (at most 2 MB) |
| GET `api/items/<id>?from=<byte>` | | the items' events file from that byte, the same way |
| GET `api/rec/<id>/<name>/sheet?v=<ms>` | | a recorded character's sheet at that moment |
| GET `api/item?name=&level=&stat=`, `api/condition?name=` | | `{ html }`: the game's own tooltip |
| GET / PUT `api/settings` | `{ v: 1, cards?: { hero, chips }, data?: { cols, panels: [{ id, m, view, by?, col }] } }` | the metrics shown (the headline, the columns) and the Data tab's panels; a PUT of one keeps the other |
| GET / PUT `api/config` | `{ set: { <key>: value or null } }` | `{ token: { source, file, ours, writable }, settings: { <key>: { value, from, env, local, default } }, local_file, root }`; PUT: 409 for a key the environment sets |
| GET `api/new/snippet` | | `{ text }`: `snippets/export-state.js` |
| GET `api/code`, `api/code/files?set=`, `api/code/file?set=&path=`, `api/code/runs?set=` | | the sets (with `mode`, `why`); a set's files, `mode`, `where`, `commit`, `trusted`, `copy_of`; a file's `{ text }`; the runs that used it |
| POST `api/code/file` | `{ set, path, text, action: "check" \| "save", force?, name? }` | `{ problems: [{ line, column, message }], saved: { mode, set, commit?, trusted?, from? } }`; 422 a syntax problem (force saves it), 409 a copy's name taken or a read-only set |
| GET `cm/...` | | the game's CodeMirror (its `js/codemirror/`) |
| PUT / DELETE `api/accounts/<name>` | `{ account, was? }` | a crafted account written (was: its old name, removed) or removed; 400 `{ problems }` |
| GET `api/gearsets` | | `{ sets, classes }`: every gear set (the built-in ones first; a file of yours unreadable: `{ name, problems }`) |
| PUT / DELETE `api/gearsets/<name>` | `{ set: { name, class, gear }, was? }` | a gear set of yours written (one of that name replaced; was: its old name, removed; 409 over another set) or removed; 400 `{ problems }` (a built-in set's name too) |
| DELETE `api/pulls/<account>[?older=1]` | | your account's pulls removed (older: all but the newest), their CODE with them: `{ account, removed }` |
| DELETE `api/players/<account>` | | another player's pages taken removed: `{ account, removed }` |
| POST / DELETE `api/config/token` | `{ action: "test" \| "save", token? }` | `{ characters, saved }` (test: without a token, the one set); 502 when the game refuses it; DELETE removes `config/al_token` only |
| POST `api/viewer` | | starts the replay viewer's backend: 202 `{ up: false, starting: true }`, then 200 `{ up: true }` |
| GET `api/new`, `api/new/items`, `api/new/fits`, `api/new/code`, `api/new/top`; POST `api/new/compose`, `api/new/pull`, `api/new/export`, `api/new/player`, `api/new/code` | | New sim's server side (`dashboard/new.js`) |
