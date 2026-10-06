# Replays of recorded runs

A sim run at 100x can't be watched as it runs. Recorded, it plays back afterwards in the game's own page (view only),
served by the dashboard. The recording holds what the server sent each character's client and the moves that client
sent. The dashboard shows it on the run's page (Replay), and its charts seek it.

## The pieces

| part | file | what |
|---|---|---|
| shared | `lib/rec.js` | `Recorder` (writes a recording), `fold()` (the state a client knows, from packets), `readIndex()`, `recordingsOf()` |
| sim | `sim/fake_io.js` | `RemoteHub` takes `o.recorder`: `receive()` copies every record the server sends this client, `send()` the client's `move` packets |
| sim | `sim/client_worker.js` | a `Recorder` when `workerData.rec` is set, closed on the thread's stop |
| sim | `sim/sim.js` | `createSim({ record })`: `sim.recDir = <live dir>/<id>.rec` (threads mode with live snapshots only); `workerData.rec` per character |
| sim | `sim/run.js` | `chronal run --record` |
| dashboard | `dashboard/server.js` | `w.rec` in api/live (the recorded names, from `<id>.rec/`); `.rec` moves with a removed run (`SIDE`); POST api/launch `record: true` (`--record`); the viewer mounted on its port; POST api/viewer |
| dashboard | `dashboard/app/replay.js`, `charts.js`, `newsim.js`, `rerun.js` | a run page's Replay, its frames, the charts' click-to-seek and playhead; the New sim and Rerun pages' "Record a replay" |
| viewer | `viewer/server.js` | `createViewer()`: the paths the dashboard hands it (`claims()`), the game's web backend started on demand and proxied, closed when idle |
| viewer | `viewer/backend.js` | preloaded into the backend: the sim's in-memory Mongo with the maps seeded, servers on loopback, no writes to the game's `version.js` |
| viewer | `viewer/replay.js` | the routes and the page script that plays a recording |
| viewer | `viewer/timewarp.js` | the page's virtual clock (Date, performance.now, timers, animation frames) |

## The recording (`chronal-rec/1`)

`<live>/<id>.rec/<name>.rec.gz` and `<name>.rec.idx`, beside the run's snapshot:
- **Members:** the `.gz` is a series of gzip members. A new member starts at the first record 30 game s (`member_ms`)
  after the member's first, or past 8 MB. The lines are `<virtual ms>\t<kind>\t<data>`:
  - `p`: a packet from the server, the `["event", data]` JSON as the socket carried it;
  - `a` / `d`: connect / disconnect;
  - `P`: a `move` the client sent.
- **The S line:** the first line of every member is `S`, the state folded (`fold()`) from every record before the
  member:
  - the map (name, in, x, y, m);
  - the entities in view (the `entities` deltas since the last full list, merged per id, with `_at`, the time of each
    one's last update);
  - the chests on the ground;
  - the raw `party_update` and `server_info`;
  - the last `player` packet and move, as `[ms, raw]`.
  A seek reads one member.
- **The index:** the `.idx` is a JSON header line `{ format, name, member_ms }`, then a line per member:
  `first ms, last ms, byte offset, bytes`. A run still recording has what is written so far.
- **Times** are the world's virtual clock, the same as the grid's `v`. A chart's `t` (measured s since the base) is
  `v - (row.v - row.t * 1000)` for any grid row.
- **Record order:** records are in arrival order, and packets arrive with future delivery times, so a member is a few
  ms out of order. The page sorts each member.

## The viewer (`viewer/`)

- **The backend:** the game's own web backend (config `al_root`'s `main.js`, `viewer/backend.js` preloaded) on a
  loopback port of its own. POST api/viewer (a run's Replay, before it frames a replay) starts it, as does the first
  request the viewer serves; it closes 5 min after the last one. Its log: `<live dir>/logs/viewer.log`. It has no
  accounts and no characters: it renders the game's page and serves its files.
- **The paths** the dashboard hands the viewer, on the dashboard's own port: `/replay/`, `/__rec/`, the character pages,
  the game's `/js/`, `/css/`, `/sounds/`, `/phrases/`, `/data.js`, the images the dashboard doesn't serve (not png,
  jpg or gif), and the API calls the page makes (`servers_and_characters`, `pull_chat`, `pull_chats`). The backend's
  own address (`base_url`) in what it sends is made the dashboard's. The game's Google Analytics scripts (adventure.land's
  visit counts) are left out of its pages, so a replay sends nothing to Google.
- `/replay/<run id>/<name>[?t=|?v=][&base=][&max=][&speed=][&paused=1]` redirects to the character's game page
  `/character/<name>/in/US/I/?chronal_replay=<run id>`. The backend serves that page for any name; the viewer puts the
  time warp and the replay script in its head (404 for a run or name without a recording).
- `/__rec/<run id>/<name>/idx` serves the index as JSON. `/__rec/<run id>/<name>/<k>` serves member k, as its gzip
  bytes with `content-encoding: gzip`.
- The run id and name are checked against `/^[\w.-]+--\d+$/` and `/^[\w-]{1,40}$/`. The files come from the live dir
  only.
- **The clock is the page's own.** It starts at the recording's first packet (the clock baked into the script); its
  versions start at 2^50 and only grow. Opened at a moment (`t`, `v`, a seek before the game started), it delivers the
  packets up to the login at once, then seeks.
  - Speed and pause set the page's clock there (`__timewarp.setClock`). Nothing is kept on the server per viewer.
- **Login:** after `welcome` the game loads its resources and emits `loaded` (a server waits for that too). The replay
  holds every later packet until the page emits it, with the recording's time held too. A `start` before the textures
  exist breaks the page.
- **The socket:** `io()` returns a socket with the socket.io surface the game uses. It plays the recording: a pump on
  a real 16 ms timer delivers every record whose time has come. It fetches the next member ahead, keeps a few, and
  fetches the index again near its end (a run still recording).
- **The watched character:** a live client moves itself (`move()`). The `player` packets are up to 4 s apart and never
  move it. The `P` moves do, as `move()` did. The server's position in a `player` packet only corrects a jump of more
  than 60 px (a respawn, a blink).
- **A seek:**
  1. Recording time is page time minus an offset. A seek changes the offset; the page's clock only runs forward,
     because the game's timers are due in its time.
  2. It loads the member holding T and folds its records up to T onto its S state.
  3. It hands the client that state. A `new_map` if the map differs. The sprites on screen are destroyed at once (no
     death fades). One `entities` packet brings the folded entities back, each moved on along its path by
     `speed * (T - _at)` (its type's speed when the packets had none). Then the chests, `party_update`,
     `server_info`, the last `player` packet, and the character along its last move.
- **Display fixes**, because the game draws per frame, not per game time:
  - A lazy camera eases toward the character over ~250 real ms.
  - "Effects in game time": the game's fades are `draw_timeout` chains that take one step per drawn frame. They run
    every due step in the same frame, each timed from the one before. Steps that time themselves (damage numbers,
    `last_fade`) run as they were. Monsters fading in get the frames the playback skipped.
- **The bar:** the time, a speed slider (1x to the run's own speed, log scale; `max`, else the snapshot's
  `virtual_ms / real_ms`), pause, the smooth camera, and a scrubber over the whole recording.
- **The end:** playback pauses at the last recorded moment and doesn't play past it (a run still recording plays
  on once more of it arrives).
- **Messages in a frame:**
  - in: `{ replay: "seek", v | t }` and `{ replay: "base", v }` (the time shown counts from it);
  - out: `{ replay: "time", v, first, last, speed, max, paused, ready }` to the parent every 250 ms (max: the top of
    its speed slider).
  - `window.__replay` has `{ v, seek(v) }` for tests and the console.

## The dashboard

- **Replay:** a run with recordings (`w.rec`) gets a Replay button on its page (`#/runs/<id>?replay` while it shows).
  When it shows, the page asks POST api/viewer to start the viewer's backend (202 while it starts, then 200) and frames
  the replay once it is up.
- **Frames:** `replay/<id>/<name>` on the dashboard's port, one per recorded character, with a button per character.
  - The first plays. Once one reports `ready`, the next loads in the background: at the moment shown (`&v=`), with the
    speed (`&speed=`), and `&paused=1`, which pauses it only once the game is in (a stopped clock would stop its
    loading too).
  - While loading it sits under the shown frame; once ready it moves offscreen.
  - A switch sends the chosen frame `seek` to the shown one's time and `speed` (speed and pause), shows it, and pauses
    the one before. Measured (2026-09-26, the frames then on another port): 64-94 ms, the same moment, the same speed.
    All 4 frames of a party were ready about 6 s after the tab opened (headless, local).
  - Measured again (2026-10-01, frames on the dashboard's port, headless Chromium with software GL, a 4-character
    run): the shown frame was in game after about 2.5 s; a frame loading behind it took 20-30 s while the shown one
    played (paused too, on another origin too, and on top instead of under it), and about 1.3 s with the shown one
    hidden. Loading frames compete with the shown frame's drawing. A switch to a character not loaded yet loads it as
    the shown frame (in game within about 3 s).
  - Every character's game client lives in the tab (memory: about 4x one).
  - The frame block is sticky under the page's tabs, over the tab below (46vh). The mouse wheel over it
    scrolls the page: the replay's view-only handler keeps the game from the wheel but leaves its default (scrolling
    chains from the frame to the page).
- **Hide the game** (beside the character buttons) folds the frame block, its character buttons too, to a bar of the dashboard's own (play/pause, the time, a
  scrubber, the speed: the frame's messages drive it; it posts `seek` and `speed`). The frames stay, clipped to a
  1 px high box: a `display:none` or offscreen frame's game was held back (cross-origin, as the frames were then), a
  clipped one plays on (measured: 1.00 game s per real s at 1x, folded or not; 10x at 10x).
- **The Characters tab** shows each recorded character's sheet at the replay's moment: `GET api/rec/<id>/<name>/sheet?v=`
  (dashboard/server.js; rec.js `playerAt()`: the member holding v, its player packets and its S line's, the last at or
  before v; the last 8 members read are kept) gives the level, XP, HP, MP, gold, gear, stats (live.js `STATS`),
  conditions (`s`, with the time left), the inventory (`items`), the empty slots (`esize`) and the last 100 game log
  and chat lines up to v (rec.js `logAt()`: the `game_log`, `server_message` and `chat_log` packets' messages, from as
  many members back as it takes). The page fetches it again once the replay's time moved a game second or more,
  at most twice a real second.
- **Seeking from the charts:** a click on a chart or buff lane (`.gsvg`, `svg.lt`, `.trk svg`) of that run sends
  `seek` with `v = base + t * 1000`. A character's lane (buffs, deaths: `.blane[data-who]`) also switches the replay to
  that character, at the moment clicked; a click on the lane's name only switches. The base comes from the run's grid, loaded for its charts. The frame's `time`
  messages move a dashed line (`line.gp`, added to each chart's svg) and send the base to the frame once.
- **Record a replay** (the New sim and Rerun pages) sends `record: true`. With it, an identical run is not blocked (the
  point is often to record a seed that already ran), and a batch doesn't skip seeds that already ran.

## Measured (2026-09-26, party-stoneworm: merchant, ranger, paladin, priest; seed 7; threads)

- **Outcomes:** `tools/fingerprint.js` gave identical output with and without recording, at 20 and 60 game min.
- **Speed:** 60 game min took 42.0 and 41.8 s without, 42.9 and 43.3 s with: about +2.9%. 20 game min took 18.3 vs
  18.9 s.
- **Size:** 32 MB for the 4 characters per game hour: about 10 MB per fighter, less for the merchant. That is gzip
  level 1, S lines included.
- **Seek:** about 8 ms, fetching its member included. Straight 1x playback for 20 s, and a seek to the same
  moment on a fresh page, gave the same entities, HP, stats, chests and own position (at 200 s and 555 s).
- **Playback** (measured on the proof of concept, which draws the same way): 60 fps up to 100x in headless software GL.
  - At 94x the client's own extrapolation drifts monsters up to ~260 px from the recording. A seek puts them right.

## Pitfalls met on the way

- **Virtual timers:** inside a warped page, `Date.now()` and `performance.now()` are virtual. Measure real time with
  `__timewarp.real.perfNow()`.
- **Paused before the game is in:** a frame opened paused never loads, because the game's load timers run on the
  page's clock.
- **Throttled offscreen frames:** an offscreen cross-origin frame never got past loading.
- **Caching through the viewer:** the game's scripts are rewritten (its address made the dashboard's), so `no-store`
  made every frame download 5.7 MB of scripts again. They carry an ETag of the rewritten body and `private, no-cache`:
  a second frame transfers about 0.6 MB instead of 12 MB.
- **Old pages:** a dashboard process serves the viewer code and the page's `index.html` it loaded at its start (the page's
  modules, `dashboard/app/*.js`, are read on each request). Restart it after changing `dashboard/app/index.html` or
  `viewer/`.
- **Seeking backwards:** the page clock would stall the game's timers (due in the future). Hence the offset, and never
  moving the page's clock back.
- **Reverse:** a proof of concept showed per-frame seeks can play backwards. It was dropped at the user's request.

