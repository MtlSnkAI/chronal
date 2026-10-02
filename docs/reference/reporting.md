# What CODE reports (the chronal object)

The dashboard shows the game's own numbers for any CODE: kills, xp, gold, damage, potions, deaths, conditions. What it
can't know from the game, the CODE may tell it through an optional global object `chronal`. Nothing else of a CODE is
read, and a CODE needs nothing from ChronAL: on the live game the object is simply unused.

```js
var chronal = (self.chronal = self.chronal || {});
chronal.mode = "farm";                                     // a string kept current, or a pure getter: () => "farm"
chronal.status = () => ({ kills: kills, target: name });   // a pure getter or a plain object: any JSON tree
chronal.role = "healer";                                   // "dps", "tank", "healer", "merchant" or "support"
```

| field | the snapshot | the dashboard |
|---|---|---|
| `mode` | `players[].modes`: game ms per mode | time per mode; conditions read it (`c.<Name>.mode`) |
| `status` | `players[].code_status` (over 64 KB of JSON: `{ truncated: true, bytes }`) | the Run tab's "CODE status" tree |
| `role` | `players[].role`, unless the setup gives one | the role icons and groupings |

`players[].modes_from` is `"chronal"`, or null for a CODE without the object (no modes, no status; the role by class).

The setup's `params` arrive as `chronal.params` (set before your CODE runs).

## Getters must be pure

A getter is called with `this` = the `chronal` object, and must not schedule timers, emit on the socket, act in the
game, use `Math.random`, make promises, or change game or CODE state.

The sim reads the mode after every lockstep window and the status and role every 10 game seconds (the single-thread
mode: once per real second). Each read is guarded: random number generators are put back after the call, so a getter
that draws random numbers shifts nothing; a call that scheduled a timer, emitted, made a promise or wrote to the game
log is reported in the snapshot's `notes.chronal` (`"Pri1: status disabled (scheduled a timer)"`) and that getter is
not called again (its last value stands). The guard detects such a call; it can't undo it.

## CODE with its own structure: an adapter

A CODE that keeps its mode and status in its own objects reports them through a small file that its setups append
(`code.append`), never loaded on live:

```js
// adapter.js, appended after the entry
var chronal = (self.chronal = self.chronal || {});
chronal.mode = () => MyBot.state;                          // the CODE's own mode
chronal.status = () => MyBot.summary();                    // must be pure
chronal.role = MyBot.role;
if (chronal.params && chronal.params.farm) MyBot.config.spot = chronal.params.farm;   // the setup's spot
```

Every setup of that CODE then lists it: `"code": { "dir": "...", "append": ["adapter.js"] }`.
