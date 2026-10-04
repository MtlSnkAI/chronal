# State exports

A run's state as files a setup continues from exactly: one `chronal-export/1` per character with its account's bank
(`sim/export.js`). `chronal run` writes one at its end, `<id>.state/end/` beside the snapshot (`--export DIR` elsewhere,
`--no-export` none); the dashboard's **Export state** and a steering entry's `export` write one while it runs
(`<id>.state/<label>/`). `chronal continue` makes the next stage's setup from one ([CLI](cli.md#chronal-continue)); a
setup's `state.from` and `bank.from` take its files as any export.

An export only reads (the server's players, the database's documents, the pages' `localStorage`): no clock event, no
game call, so writing one never changes what a run does.

## `<Name>.json`

The format live exports have (`snippets/export-state.js`, `chronal pull`), with more of the server's state:

| key | |
|---|---|
| `format`, `exported_at` | `chronal-export/1`; the world clock (ISO) |
| `source` | `{ from: "sim", run, label, seed, setup_key, in_game }`: `in_game` false for a character not in game then (it left, or was never started) |
| `character` | `name`, `class`, `level`, `xp`, `gold`, `hp`, `mp`, `rip`; `items` and `slots` as the server keeps them (every field: `grace`, `l`, `p`, `expires`, a trade slot's `price`, `b`, `rid`...); `skin`, `cx`; `map`, `in`, `x`, `y` |
| `server.p` | the server's own state of it that a setup's `state.p` takes: `ugrace`, `cgrace`, `ograce`, `stats` (kill counts), `achievements`, `ap`, `firstbuff`, `encouragement_reached80`, `first`, `first_drop`, `dt`, `rewards`, `minutes`, `stand` (an open merchant stand) |
| `server.s` | its conditions, but the ones a login makes again (`encouragement_*`) and a session's (`notverified`, `authfail`) |
| `bank`, `bank_source` | its account's whole bank: `gold`, every `items<N>`, `unlocked` rooms, `rewards`; the server's copy (a mounted one, inside the bank, first): `{ from: "sim", at, mounted }` |
| `account` | `{ key, cash, linked, created, age_days, newcomer_claimed, local_storage, characters }`: its shells, its Steam/MAS link, its age then (`age_days`: what the next stage's setup gives), whether its Newcomers' Blessing was claimed, its pages' raw `localStorage` (a page in game's, else what its pages were given), its characters and levels |
| `warnings` | what it can't carry: an item in an upgrade or compound queue is lost |

## `index.json`

`{ format: "chronal-state/1", label, at, run, seed, seasons_on, characters: [{ name, class, account }], accounts: { <key>:
{ bank_from, age_days, cash, linked, newcomer_claimed } } }`; `seasons_on`: the seasons on then (`chronal continue`'s, unless
`--seasons`); `bank_from` the file of the account's that carries its bank.

## What a continuation doesn't have

A stage boots a fresh world: monster levels, boss timers and the server-wide upgrade grace start over, and every
character logs in again (its CODE starts from its top; what the CODE kept in memory is gone, what it `set` stays). A
calendar jump (`--start` on continue) moves the export's absolute times (`expires`, `p.dt`, conditions' `last`).
