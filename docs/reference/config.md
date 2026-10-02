# Settings

`config/defaults.json` holds the defaults; `config/local.json` (gitignored, optional) overrides them for your
machine, key by key. Paths are relative to the ChronAL folder; `null` means none. The dashboard's **Settings** page
shows each one, where it comes from, and edits `config/local.json` (applied when `chronal dash` starts again).

| key | default | |
|---|---|---|
| `al_root` | `runtime/app` | the game the sim runs (`chronal install`'s copy) |
| `upstream` | `upstream` | where `chronal install` keeps the game's repos |
| `live_dir` | `live` | run snapshots: what `chronal run` writes and the dashboard reads |
| `g_data` | `null` | a game data file (JSON, or a `var G = {...}` script); none: the newest `cache/G-<version>.json` |
| `al_token_file` | `config/al_token` | a file whose first line is your account's API token (`chronal pull`, Pull now); the dashboard's Settings saves it there (mode 0600, gitignored) |
| `pulls_dir` | `pulls` | `chronal pull`'s pulls |
| `players_dir` | `players` | other players' public pages (`chronal pull --player`) |
| `code_sets` | `null` | your CODE sets file ([CODE sets](library.md#code-sets)) |
| `library_dir` | `library` | the CODE library |
| `setups_dir` | `setups` | where `chronal new` and the dashboard's New sim save setups |
| `accounts_dir` | `accounts` | crafted accounts (the dashboard's Accounts: `<name>.json`, format `chronal-account/1`) |
| `gear_sets_dir` | `gearsets` | your gear sets (New sim's Gear set: `<name>.json`, format `chronal-gear-set/1`) |
| `port` | `8089` | the dashboard's port |

Each path key can also come from the environment as `CHRONAL_<KEY>` (e.g. `CHRONAL_LIVE_DIR=/tmp/scratch`, relative to
the current folder), which wins over the files; a command's own option (`--live`, `--dir`) wins over both.

```json
{ "upstream": "../upstream", "g_data": "../data_live.js", "port": 18089 }
```

Other environment variables:

| variable | |
|---|---|
| `CHRONAL_AL_TOKEN` | the API token itself (`chronal pull`); wins over `al_token_file` |
| `CHRONAL_LOCAL_CONFIG` | another file in place of `config/local.json` (the tests' scratch one) |
| `CHRONAL_AL_API`, `CHRONAL_AL_SITE` | the game's API and site (default `https://adventure.land/mcp_api`, `https://adventure.land`) |
| `CHRONAL_NO_BUILD` | `1`: skip setups' build commands (as `--no-build`) |
| `CHRONAL_THREADS_MAX` | the dashboard's limit of sim threads busy at once (default: CPU cores - 4) |
| `CHRONAL_SPIN_MS` | how long a waiting sim thread spins before it sleeps (default 0.5 with 4+ CPUs) |
