# How the sim works

## The game's own code on a virtual clock

ChronAL doesn't reimplement the game. It runs the game's real `node/server.js` and, for each character, the game's
real client (the same scripts a browser loads, in bot mode with a headless DOM), and your CODE inside that client as
the game's CODE editor runs it.

What makes it fast is time. Every timer the server, the clients and your CODE set (`setTimeout`, `setInterval`,
`Date.now`, `performance.now`, animation frames) is on a virtual clock. Nothing sleeps: when every context has nothing
left to do now, the clock jumps straight to the next timer. A game minute in which your ranger shoots 100 times costs
only the CPU time of those 100 shots, the server's ticks and the client's frames. A run goes as fast as the CPU allows,
typically 50-200x.

The server runs without its database or web backend: an in-memory database seeded with the game's maps, the
characters and accounts the setup describes, and the socket.io connections replaced by in-process channels with the
setup's ping.

## Threads and lockstep

With `world.threads` (the default) the server has a thread and each character's client has its own, so a 4-character
run uses 5 cores. Each thread has its own clock, and the threads must never let one get so far ahead that a message
from another could arrive in its past.

They work in lockstep: a message between a client and the server always takes at least the minimum latency (0.4x the
ping), so each thread publishes how far it got and runs ahead until another thread could still send it something that
would arrive before its next event. Deliveries are ordered by the window they were sent in, then the sender and the
send order, never by when a thread happened to take them in. So a run's outcome doesn't depend on the machine's
timing, only on the setup, the seed and the code. The window is the largest whole ms at most the minimum latency that
divides a game minute (ping 18: 6 ms; ping 50: 20 ms), which is why a lower ping runs slower.

`world.threads: false` runs the server and every client in one thread: slower per run, but a machine runs as many of
them as it has cores. Its results differ from threads mode (other random streams) and some features need threads
(switching characters, recordings, per-page storage).

## Determinism

The same setup, seed, CODE and versions of ChronAL and the game give the same run, event for event:
- `run.seed` seeds `Math.random` in every context, and the clock's own small timer lateness.
- Timers are late by 1-3 ms, as live timers are (with exactly-on-time timers the server's `instance_loop` skips every
  other tick). A page's `setInterval` keeps its nominal cadence as a browser's does; the server's restarts from each
  callback, as Node's does.
- Promise continuations (microtasks) run right after each event, as a browser runs them after each task.
- What the dashboard and conditions read is read without changing anything (`tools/fingerprint.js` checks that a run
  gives the same per-minute fingerprints with snapshots on and off).

This is what makes comparisons cheap: two setups that differ in one thing differ only by that thing and by the seed's
luck, and the dashboard's Compare tests whether a difference is more than that luck.

## Why it's fast

All of these keep the game's logic as it is:
1. Every context is a plain V8 context (no contextified sandbox: global lookups would go through C++ interceptors,
   about 8x slower), with jsdom's DOM bridged in for the clients.
2. The server's 8 pathfinding workers share one context in-process, and geo-IP lookups are stubbed: boot in about
   3.5 s instead of 12, 0.6 GB instead of 1.6.
3. The client runner's 50 ms loop uses a Set instead of a linear search.
4. Microtasks are drained synchronously after each event; one in-memory `localStorage` per page.
5. The headless page skips DOM work it can't show.
6. Paladin auras are refreshed only on maps with players; the server's date arithmetic avoids building Date objects.
7. The virtual `Date` is compiled inside each context, so V8 inlines it.

## ROI: freezing far monsters (opt-in)

Most of a server's CPU goes into monsters nobody sees. `world.roi` freezes a monster (it skips the server's per-tick
update; it still levels up and respawns) while it and its spawn area are out of every player's reach. Anything
targeting, with a condition, roaming, a boss or an event monster never freezes.

- `"box50"` (recommended): "in reach" is each player's view box (700 x 500 px each way) grown by 50 px. Measured over 48
  paired seeds at three spots: server CPU -15 to -20%, runs 14-19% faster, xp/h within the seed noise (pooled +0.4%,
  95% CI -1.3..+2.0).
- `"900"`: a 900 px circle around each player (about 0 px of margin at the view's corners); `",m300"` narrows a
  merchant's reach to 300 px (not worth it: merchants stand in town).
- Use it to screen spots or strategies, every arm with the same `roi`; rerun the top candidates without it on fresh
  seeds before picking a winner: per-spot bounds reach about 3%.

## What differs from live

- **No other players**, and no backend: web API calls the CODE makes get no answer.
- **The ping** is the setup's, with a little jitter: no lag spikes or packet loss.
- **Maps with no players** are paused at boot (the live server pauses them itself after 50 s), and their NPCs wait
  until a player arrives.
- **Pathfinding** runs in-process with 2 ms of latency; database calls take no game time.
- **Storage:** in threads mode each character's page has its own `localStorage`, as in separate browsers; characters
  talk through the server's `cm`, not `send_local_cm`.
- **Frame rate:** the setup's `fps` (default 10, live with graphics: 60). Level and xp tracked 60 fps closely in tests;
  gold drifted up to about 15% (loot timing).
- **The clock and events:** the world's clock starts at the setup's `world.start` (default 2026-01-01 00:00 UTC) and
  the server's night, dailies and nightlies follow it, as live's follow the real time; the live servers' seasons are
  switched by their admins, the sim's by the setup (`world.seasons`). A setup can also force a daily or nightly at a
  time (`world.events`): no live server does that, so such a run says it on its label.
- **A custom world:** a setup can put monsters in the world (`world.spawns`: a dummy, an arena), made by the
  server as its own, with stats of its choosing: not a live server's world, so such a run says "custom world".

For how far a run's numbers were measured to be from a real game server, see [fidelity](fidelity.md).

## Where things are

| file | |
|---|---|
| `sim/sim.js` | the API (`createSim`) and the lockstep |
| `sim/vclock.js` | the virtual clock |
| `sim/server_host.js`, `sim/client_host.js`, `sim/client_worker.js` | the server, a client and its thread |
| `sim/fake_io.js`, `sim/fake_mongo.js`, `sim/realm.js` | socket.io between threads, the in-memory database, per-context objects |
| `sim/start.js`, `sim/run.js` | starting a setup, steering, `chronal run` |
| `sim/live.js`, `sim/report.js` | snapshots, what CODE reports |
| `lib/setup.js` | loading and resolving setups |
