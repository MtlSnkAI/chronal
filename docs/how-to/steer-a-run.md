# Steer a run

Many bots are controlled while they run: a value in the browser's storage, a button on a control panel, a command
typed in the console. A setup can do what you would do at your controls, at a time or when something happens.

## Set the browser storage at the start

If your CODE reads `get("mode")` (the game's `set`/`get`) or `localStorage`:

```json
"accounts": { "main": { "storage": { "mode": "farm" }, "local_storage": { "theme": "dark" } } }
```

Each account has its own (a player's characters share one browser). `chronal new --check` lists the keys your CODE
reads that no account sets.

## Change it during the run

```json
"steer": [
	{ "at": "20m", "storage": { "mode": "rest" }, "note": "rest" },
	{ "at": "25m", "character": "Pri1", "code": "set_message('steered')" }
]
```

- `storage` sets keys in the account's storage (the step's character's; without `character`, every account's).
- `code` runs in the CODE (the step's character's; without, every character's), as `command_character` would.

## React to what happens

A step with `when` fires once its condition holds:

```json
"steer": [
	{ "name": "boss", "when": "c.Ran1.kills.squigtoad >= 500", "storage": { "mode": "boss" } },
	{ "after": "boss", "at": "10m", "storage": { "mode": "farm" } },
	{ "when": "c.Ran1.rate.xp_h < 400000", "for": "5m", "repeat": true, "code": "smart_move('town')" }
]
```

Conditions read the run's own numbers (kills, levels, gold, items, potions, conditions on a character, monsters in
view, its game log, its storage, the party's totals): [Conditions](../reference/setup.md#conditions). They are checked
every `run.check` (1 game s by default).

## Stop when something happens

```json
"run": { "duration": "24h", "until": "c.Ran1.level >= 60" }
```

The run ends once it holds; the printout and the snapshot's `end.detail` say when (e.g. `until: c.Ran1.level >= 60 at
312.5 game min`). Runs with another `until` are not grouped with it on the dashboard. `chronal new --until "party.kills.total >= 5000"` sets it too.

## See it

The run prints each step as it fires (and what it couldn't do: a character not in game, CODE not running). The
dashboard marks each firing on the graphs (hover: when, why, what), and the Run tab lists every step, how often it
fired, or "never fired".

The dashboard's New sim has Storage and Steering sections under Advanced, with a picker for conditions.
