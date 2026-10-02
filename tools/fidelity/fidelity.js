// Fidelity test CODE: one fighter farms one spot the same way on live and in ChronAL, and records the same numbers on
// both, to compare the sim with the live server (docs/how-to/check-against-live.md). Self-contained (no other slots):
// paste it into a slot on live; in the sim it runs as a file CODE set (tools/fidelity/sim.js).
//
// What it does, RUNS times in a row: sells SELL's items and tops its potions up to STOCK at the nearest seller (bag
// space: anything else it carries is kept), heals to full hp and mp there, travels to the spot, waits WARMUP, then
// measures for MINUTES; then it stops farming, saves (live: downloads) the run's record and walks back to the seller,
// drinking on the way, for the next run. After the last one it waits there, full.
// While farming: solo; a new monster only while fewer than MAX_AGGRO target it; plain attacks only (no skills: the
// fewer choices, the fewer ways to drift apart); steps away from a monster that targets it and comes close (kiting,
// inside the spot); potions by fixed thresholds; loots chests; respawns and walks back after a death. No elixirs, no
// merchant, no party.
//
// Where the numbers go:
// - live: localStorage (get("fidelity_last"), and get("fidelity_<start>") per run), saved every 15 s, and downloaded
//   as fidelity-<name>-<start>.json once each window ends (a browser download: allow the site several downloads when
//   the browser asks; the Steam client may not download). The last run's again: fidelity_download() in this CODE (or
//   paste: show_json(get("fidelity_last"))).
// - the sim: chronal.status (the run's snapshot, players[].code_status); chronal.params.fidelity overrides CFG.
var CFG = {
	preset: "iceroamer", // a key of PRESETS
	warmup_s: 120, // after arriving, before the window opens
	minutes: 10, // the window
	runs: 3, // runs in a row (each a record of its own)
	hp_at: 0.6, // drink an hp potion below this share of max hp
	mp_at: 0.35, // an mp potion below this share of max mp
	hp_low: 0.3, // below this, hp before mp even when mp can't pay for its shots (both that low: one each in turn)
	max_aggro: 2, // a new target only while fewer monsters than this target it (a pull of the whole spawn kills)
	kite: true, // step away from a monster that targets it once it is within its range + kite_px
	kite_px: 40,
	period_ms: 100, // the loop's period
	stock: { hpot0: 1500, mpot0: 400 }, // bought up to before the trip (a 1 h window at iceroamers drinks ~1200 hp potions)
	// drops of these sold at the seller before each run and after the last: winterland's common drops (its rings, 1 in
	// 2000 kills before luck; Wanderer's Attire, 1 in 10000). Never what the bag held when the series started, nor a
	// locked item; everything else is kept (Essence of Frost, Frost Core, the Frozen Cave Key, Bee Fur, event items)
	sell: ["intring", "strring", "dexring", "vitring", "wattire"],
};
// a spot per monster: the spawn area's centre and how far from it targets are taken (from G.maps; the maps and
// monsters here are the same on live and in the game the sim runs, as of the pull of 2026-10-02)
var PRESETS = {
	arcticbee: { map: "winterland", x: 1082, y: -873, r: 420, types: ["arcticbee"] },
	iceroamer: { map: "winterland", x: 823, y: -45, r: 340, types: ["iceroamer"] },
	boar: { map: "winterland", x: 19, y: -1109, r: 430, types: ["boar"] },
	porcupine: { map: "desertland", x: -829, y: 135, r: 260, types: ["porcupine"] },
	stoneworm: { map: "spookytown", x: 676, y: 129, r: 260, types: ["stoneworm"] },
	bbpompom: { map: "winter_cave", x: 51, y: -164, r: 320, types: ["bbpompom"] },
};
var VERSION = "fidelity/1";

(function () {
	var IN_SIM = typeof chronal !== "undefined" && !!chronal.params;
	if (IN_SIM && chronal.params.fidelity) for (var k in chronal.params.fidelity) CFG[k] = chronal.params.fidelity[k];
	var SPOT = PRESETS[CFG.preset];
	if (!SPOT) return set_message("fidelity: no preset " + CFG.preset);
	var now = function () { return Date.now(); };

	// ---- the record: a fresh one per run of the series (run: its index from 0)
	var t_boot = now(), t_start = t_boot, run = 0, R = fresh();
	function fresh() {
		t_start = now();
		return {
			format: "chronal-fidelity/1", version: VERSION, env: IN_SIM ? "sim" : "live",
			name: character.name, cfg: CFG, spot: SPOT,
			series: { started_at: new Date(t_boot).toISOString(), run: run + 1, runs: CFG.runs },
			started_at: new Date(t_start).toISOString(), phase: "stock", stock_ms: null, bought: {}, sold: {},
			server: { region: parent.server_region || null, id: parent.server_identifier || null, time_offset: (parent.S && parent.S.schedule && parent.S.schedule.time_offset) || 0, night: !!(parent.S && parent.S.schedule && parent.S.schedule.night) },
			events: parent.S ? Object.keys(parent.S).filter(function (k) { return k !== "schedule"; }) : [],
			start: stats(), conditions0: conds(),
			travel_ms: null, window: null, end: null,
			totals: zero(), per_min: {},
			ttk: { n: 0, sum: 0, sumsq: 0, hist: {} }, shots_per_kill: { n: 0, sum: 0, sumsq: 0 }, dmg: {}, taken_by: {}, healed_by: {},
			mlevel: { n: 0, sum: 0, max: 0, hist: {} },
			cond_ms: {}, ping: { n: 0, sum: 0, min: null, max: null }, loop: { n: 0, sum: 0, max: 0, slow: 0 },
			encouragement: { start: null, end: null }, deaths_at: [],
		};
	}
	function zero() {
		return { kills: 0, xp: 0, gold: 0, shots: {}, hits: 0, crits: 0, evaded: 0, missed: 0, dmg: 0, taken: 0, hits_taken: 0, hp_pots: 0, mp_pots: 0, deaths: 0, chests: 0, items: 0, idle_ms: 0, dead_ms: 0, moves: 0, levelups: 0, kites: 0, healed: 0, spot_deaths: 0, others_near: 0, samples: 0 };
	}
	function stats() {
		var c = character;
		return { level: c.level, xp: c.xp, gold: c.gold, hp: c.hp, mp: c.mp, max_hp: c.max_hp, max_mp: c.max_mp, attack: c.attack, frequency: c.frequency, armor: c.armor, resistance: c.resistance, speed: c.speed, range: c.range, crit: c.crit || 0, critdamage: c.critdamage || 0, evasion: c.evasion || 0, dex: c.dex, map: c.map, x: Math.round(c.x), y: Math.round(c.y), hpots: qty("hpot"), mpots: qty("mpot"), free: character.esize };
	}
	function conds() {
		var out = {};
		for (var k in character.s) { var v = character.s[k]; out[k] = { ms: v.ms || null, f: v.f || null, xp: v.xp_multiplier || null, phase: v.phase != null ? v.phase : null }; }
		return out;
	}
	var win = function () { return R.phase === "window"; };
	// a per-minute series point (window minutes from 0)
	function bump(key, v) {
		if (!win()) return;
		var m = Math.floor((now() - R.window.from) / 60000), a = R.per_min[key] || (R.per_min[key] = []);
		while (a.length <= m) a.push(0);
		a[m] += v;
	}
	function add(key, v) { if (!win()) return; R.totals[key] += v; bump(key, v); }
	function agg(o, v) { o.n++; o.sum += v; o.sumsq += v * v; }

	// ---- the events: our shots (action), our hits and kills (target_hit), hits on us (hit), deaths near the spot, loot
	var first_hit = {}, shots_on = {}, ours = {};
	game.on("action", function (d) {
		if (d.actor !== character.id || !win()) return;
		var s = d.source || "attack";
		R.totals.shots[s] = (R.totals.shots[s] || 0) + 1;
		bump("shots", 1);
		if (d.target) shots_on[d.target] = (shots_on[d.target] || 0) + 1;
	});
	character.on("target_hit", function (d) {
		if (!win()) return;
		var s = d.source || "attack", D = R.dmg[s] || (R.dmg[s] = { n: 0, sum: 0, sumsq: 0, min: null, max: null, crit: 0 });
		if (d.evade) R.totals.evaded++;
		else if (d.miss || d.avoid) R.totals.missed++;
		else if (d.damage) {
			R.totals.hits++; D.n++; D.sum += d.damage; D.sumsq += d.damage * d.damage;
			D.min = D.min == null ? d.damage : Math.min(D.min, d.damage); D.max = D.max == null ? d.damage : Math.max(D.max, d.damage);
			if (d.crit) (R.totals.crits++, D.crit++);
			add("dmg", d.damage);
		}
		if (d.target && first_hit[d.target] == null) first_hit[d.target] = now();
		if (d.kill) {
			ours[d.target] = true;
			add("kills", 1);
			if (first_hit[d.target] != null) {
				var t = now() - first_hit[d.target], b = Math.floor(t / 250) * 250;
				agg(R.ttk, t); R.ttk.hist[b] = (R.ttk.hist[b] || 0) + 1;
			}
			if (shots_on[d.target]) agg(R.shots_per_kill, shots_on[d.target]);
			delete first_hit[d.target]; delete shots_on[d.target];
		}
	});
	character.on("hit", function (d) {
		if (!win()) return;
		// healed by someone (on live: another player's priest, from out of sight)
		if (d.heal) {
			add("healed", d.heal);
			var h = parent.entities[d.actor], hk = (h && h.name) || String(d.actor);
			R.healed_by[hk] = (R.healed_by[hk] || 0) + d.heal;
			return;
		}
		if (!d.damage) return;
		R.totals.hits_taken++; add("taken", d.damage);
		var a = parent.entities[d.actor], k = (a && (a.mtype || a.name)) || String(d.actor);
		R.taken_by[k] = (R.taken_by[k] || 0) + d.damage;
	});
	game.on("death", function (d) {
		if (!win() || !d || !d.id) return;
		var e = parent.entities[d.id];
		if (e && e.type === "monster" && SPOT.types.indexOf(e.mtype) >= 0 && e.map === SPOT.map && Math.hypot(e.x - SPOT.x, e.y - SPOT.y) <= SPOT.r + 200) add("spot_deaths", 1);
	});
	character.on("loot", function (d) {
		if (!win() || !d || d.opener !== character.name) return;
		add("chests", 1);
		if (d.items) add("items", d.items.length);
	});

	// ---- the loop: what changed (xp, gold, potions, level, death), the samples, then one action
	var last = { t: now(), xp: character.xp, level: character.level, gold: character.gold, hpot: qty("hpot"), mpot: qty("mpot"), rip: character.rip }, t_sample = 0, t_save = 0, t_arrive = null;
	function qty(prefix) { var n = 0; for (var i = 0; i < character.items.length; i++) { var it = character.items[i]; if (it && it.name.indexOf(prefix) === 0) n += it.q || 1; } return n; }
	function account() {
		var t = now(), dt = t - last.t;
		// (the loop's own lateness: a browser throttles a background tab's timers)
		if (win()) { R.loop.n++; R.loop.sum += dt; R.loop.max = Math.max(R.loop.max, dt); if (dt > 2 * CFG.period_ms + 50) (R.loop.slow++, (R.loop.late_ms = (R.loop.late_ms || 0) + dt - CFG.period_ms)); }
		// a tab the browser throttles (hidden: timers about once a second, after some minutes once a minute) acts too late
		// to farm: said where it shows, and the run's record says how late it was
		if (dt > 900 && !IN_SIM) set_message("fidelity: the game is throttled (" + Math.round(dt / 1000) + " s late): keep it visible");
		var dxp = character.level > last.level ? G.levels[last.level] - last.xp + character.xp : character.xp - last.xp;
		if (character.level > last.level) add("levelups", character.level - last.level);
		add("xp", Math.max(0, dxp));
		add("gold", character.gold - last.gold);
		var h = qty("hpot"), m = qty("mpot");
		if (h < last.hpot) add("hp_pots", last.hpot - h);
		if (m < last.mpot) add("mp_pots", last.mpot - m);
		if (character.rip && !last.rip) { add("deaths", 1); if (win()) R.deaths_at.push(Math.round((t - R.window.from) / 1000)); }
		if (character.rip) add("dead_ms", dt);
		if (win()) for (var k in character.s) R.cond_ms[k] = (R.cond_ms[k] || 0) + dt;
		last = { t: t, xp: character.xp, level: character.level, gold: character.gold, hpot: h, mpot: m, rip: character.rip };
		if (t - t_sample >= 5000) {
			t_sample = t;
			if (win()) {
				var p = character.ping || 0;
				R.ping.n++; R.ping.sum += p; R.ping.min = R.ping.min == null ? p : Math.min(R.ping.min, p); R.ping.max = Math.max(R.ping.max || 0, p);
				var near = 0;
				for (var id in parent.entities) { var e = parent.entities[id]; if (e.type === "character" && !e.npc && e.name !== character.name && e.map === character.map && Math.hypot(e.x - character.x, e.y - character.y) < 600) near++; }
				add("others_near", near); add("samples", 1);
				// the spot's monsters' levels (they grow while they live: a spot nobody farmed has strong ones)
				for (var mid in parent.entities) { var me = parent.entities[mid]; if (mine(me)) { var lv = me.level || 1; R.mlevel.n++; R.mlevel.sum += lv; R.mlevel.max = Math.max(R.mlevel.max, lv); R.mlevel.hist[lv] = (R.mlevel.hist[lv] || 0) + 1; } }
			}
		}
		if (!IN_SIM && t - t_save >= 15000) (t_save = t), save();
	}
	function save() {
		var s = JSON.stringify(R);
		set("fidelity_last", R);
		set("fidelity_" + R.started_at.replace(/[:.]/g, "-"), R);
		return s;
	}
	self.fidelity_download = function () {
		var s = save(), name = "fidelity-" + character.name + "-" + R.started_at.replace(/[:.]/g, "-") + ".json";
		try {
			var d = parent.document, a = d.createElement("a");
			a.href = parent.URL.createObjectURL(new parent.Blob([s], { type: "application/json" }));
			a.download = name; d.body.appendChild(a); a.click(); a.remove();
			return name;
		} catch (e) { game_log("fidelity: no download (" + e + "): show_json(get('fidelity_last'))"); }
	};
	if (IN_SIM) {
		chronal.mode = function () { return R.phase; };
		chronal.status = function () { return R; };
		chronal.role = "dps";
	}

	// the phases: travel -> warmup -> window -> done
	var t_travel = null;
	function phases() {
		var t = now(), at = character.map === SPOT.map && Math.hypot(character.x - SPOT.x, character.y - SPOT.y) <= SPOT.r;
		if (R.phase === "travel" && at) (R.phase = "warmup"), (t_arrive = t), (R.travel_ms = t - t_travel);
		if (R.phase === "warmup" && t - t_arrive >= CFG.warmup_s * 1000) {
			R.phase = "window"; R.window = { from: t, to: t + CFG.minutes * 60000, at: new Date(t).toISOString(), server_hour: (new Date(t).getUTCHours() + 24 + R.server.time_offset) % 24 };
			R.encouragement.start = conds(); R.window.stats = stats();
			R.window.mlevels = []; for (var wid in parent.entities) if (mine(parent.entities[wid])) R.window.mlevels.push(parent.entities[wid].level || 1);
		}
		if (R.phase === "window" && t >= R.window.to) {
			R.phase = "done"; R.end = stats(); R.encouragement.end = conds();
			set_message("fidelity: run " + (run + 1) + "/" + CFG.runs + " done");
			if (!IN_SIM) (save(), self.fidelity_download());
			state = "rest";
		}
	}
	// the series between runs: rest (to the seller, selling there, drinking to full), then the next run's record;
	// finished after the last
	var state = "run", resting = null;
	function rest() {
		if (resting === null) {
			resting = "walking";
			var there = function () { resting = "there"; };
			smart_move({ to: "potions" }).then(function () { return sellJunk(); }).then(there, there);
		}
		var full = heal();
		if (resting !== "there" || state === "finished" || !full) return;
		if (run + 1 >= CFG.runs) return void ((state = "finished"), set_message("fidelity: " + CFG.runs + " runs done"));
		run++; R = fresh(); state = "run"; resting = null;
		first_hit = {}; shots_on = {}; ours = {}; traveling = false; stocking = false; stocked = false;
		set_message("fidelity: run " + (run + 1) + "/" + CFG.runs);
	}

	// ---- one action per tick
	var traveling = false, last_move = 0, t_respawn = 0, stocking = false;
	// the bag when the series started, by item (name, level, stat scroll, title): kept. The items to sell: the others of
	// the sell list's (its slots, from the last; the first ones of a kind it held count as those it held)
	var sig = function (it) { return it.name + "+" + (it.level || 0) + ":" + (it.stat_type || "") + "#" + (it.p || ""); };
	var HELD = {};
	for (var i0 = 0; i0 < character.items.length; i0++) { var it0 = character.items[i0]; if (it0) HELD[sig(it0)] = (HELD[sig(it0)] || 0) + (it0.q || 1); }
	function junk() {
		var left = Object.assign({}, HELD), out = [];
		for (var i = 0; i < character.items.length; i++) {
			var it = character.items[i];
			if (!it || it.l || (CFG.sell || []).indexOf(it.name) < 0) continue;
			if (left[sig(it)] > 0) { left[sig(it)] -= it.q || 1; continue; }
			out.push(i);
		}
		return out.reverse();
	}
	// (a sale the server turned down: tried once more after the rest)
	function sellJunk(again) {
		return junk().reduce(function (p, i) {
			return p.then(function () {
				var it = character.items[i];
				if (!it) return;
				return sell(i, it.q || 1).then(function () { R.sold[it.name] = (R.sold[it.name] || 0) + (it.q || 1); }, function () {});
			});
		}, Promise.resolve()).then(function () { if (again !== false && junk().length) return sellJunk(false); });
	}
	// full hp and mp: a potion while a whole one fits, then the regen skills (all four share one cooldown). -> full
	var POT = { hp: G.items.hpot0.gives[0][1], mp: G.items.mpot0.gives[0][1] };
	function heal() {
		var H = character.max_hp, M = character.max_mp;
		if (character.hp >= H && character.mp >= M) return true;
		if (!is_on_cooldown("use_hp")) {
			if (character.hp <= H - POT.hp) use_skill("use_hp");
			else if (character.mp <= M - POT.mp) use_skill("use_mp");
			else if (character.hp < H) use_skill("regen_hp");
			else use_skill("regen_mp");
		}
		return false;
	}
	// at the nearest seller: the items to sell sold, the potions topped up, healed to full; then the trip
	var stocked = false;
	function stock() {
		if (stocking) return;
		if (stocked) {
			if (heal()) (stocked = false), (R.phase = "travel"), (t_travel = now()), (R.stock_ms = t_travel - t_start), (R.trip_hpmp = { hp: character.hp, mp: character.mp });
			return;
		}
		var need = Object.keys(CFG.stock || {}).filter(function (k) { return qty(k) < CFG.stock[k]; });
		var go = function () { stocking = false; stocked = true; };
		if (!need.length && !junk().length) return go();
		stocking = true;
		smart_move({ to: "potions" }).then(function () { return sellJunk(); }).then(function () {
			return need.reduce(function (p, k) {
				return p.then(function () {
					var n = Math.min(CFG.stock[k] - qty(k), Math.floor(character.gold / G.items[k].g));
					if (n <= 0) return;
					R.bought[k] = n;
					return buy(k, n).catch(function (e) { R.bought[k] = "failed: " + (e && e.reason); });
				});
			}, Promise.resolve());
		}).then(go, go);
	}
	function act() {
		if (character.rip) { if (last.t - t_respawn > 12000) (t_respawn = last.t), respawn(); return; }
		if (state !== "run") return rest();
		if (R.phase === "stock") return stock();
		potions();
		loot();
		if (character.map !== SPOT.map || Math.hypot(character.x - SPOT.x, character.y - SPOT.y) > SPOT.r + 300) {
			if (!traveling) { traveling = true; smart_move({ map: SPOT.map, x: SPOT.x, y: SPOT.y }).then(function () { traveling = false; }, function () { traveling = false; }); }
			return;
		}
		if (traveling) return;
		if (CFG.kite && kite()) return attackOnly();
		var tg = target();
		if (!tg) {
			add("idle_ms", CFG.period_ms);
			if (Math.hypot(character.x - SPOT.x, character.y - SPOT.y) > SPOT.r * 0.5 && !character.moving) move(SPOT.x, SPOT.y);
			return;
		}
		var d = Math.hypot(tg.x - character.x, tg.y - character.y);
		if (d > character.range) {
			// closer: to within range, along the line to it
			if (now() - last_move > 250) { var f = (d - character.range + 20) / d; move(character.x + (tg.x - character.x) * f, character.y + (tg.y - character.y) * f); last_move = now(); add("moves", 1); }
			return;
		}
		shoot(tg);
	}
	function shoot(tg) {
		if (!is_on_cooldown("attack") && can_attack(tg)) attack(tg);
	}
	// while kiting: a shot at the target if it is in range
	function attackOnly() {
		var tg = target();
		if (tg && Math.hypot(tg.x - character.x, tg.y - character.y) <= character.range) shoot(tg);
	}
	// the monsters targeting it that are close: a step away from them (their pull summed), bent back towards the spot's
	// centre near its edge, the first of 8 directions it can walk; true when it stepped (or is still stepping)
	var t_kite = 0;
	function kite() {
		var vx = 0, vy = 0, n = 0;
		for (var id in parent.entities) {
			var e = parent.entities[id];
			if (!e || e.type !== "monster" || e.dead || e.target !== character.name) continue;
			var d = Math.hypot(e.x - character.x, e.y - character.y);
			if (d > (e.range || 20) + CFG.kite_px) continue;
			vx += (character.x - e.x) / (d || 1); vy += (character.y - e.y) / (d || 1); n++;
		}
		if (!n) return false;
		if (now() - t_kite < 300) return true;
		var cx = SPOT.x - character.x, cy = SPOT.y - character.y, cd = Math.hypot(cx, cy);
		if (cd > SPOT.r * 0.6) (vx += (cx / cd) * 1.5), (vy += (cy / cd) * 1.5);
		var a0 = Math.atan2(vy, vx), step = 70;
		for (var i = 0; i < 8; i++) {
			var a = a0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 4), x = character.x + Math.cos(a) * step, y = character.y + Math.sin(a) * step;
			if (can_move_to(x, y)) { move(x, y); t_kite = now(); add("kites", 1); return true; }
		}
		return false;
	}
	function mine(e) { return e && e.type === "monster" && !e.dead && SPOT.types.indexOf(e.mtype) >= 0 && e.map === SPOT.map && Math.hypot(e.x - SPOT.x, e.y - SPOT.y) <= SPOT.r; }
	// the target: the one it has while it lasts, else the nearest of those attacking it, else (while fewer than
	// max_aggro attack it) the nearest
	function target() {
		var cur = get_targeted_monster();
		if (mine(cur)) return cur;
		var best = null, bd = Infinity, on = 0;
		for (var id in parent.entities) {
			var e = parent.entities[id];
			if (!mine(e)) continue;
			if (e.target === character.name) on++;
			var d = Math.hypot(e.x - character.x, e.y - character.y) - (e.target === character.name ? 10000 : 0);
			if (d < bd) (bd = d), (best = e);
		}
		if (best && best.target !== character.name && on >= CFG.max_aggro) best = null;
		if (best) change_target(best);
		return best;
	}
	// one potion per cooldown (hp and mp share it): hp below hp_at, mp below mp_at; but mp first once it can't pay for a
	// few more shots, so hp potions never starve the shots (no shots, more hits, more hp potions: a death spiral), unless
	// hp is below hp_low (both: in turn)
	var last_pot = null;
	function potions() {
		if (is_on_cooldown("use_hp")) return;
		var hp = character.hp / character.max_hp, broke = character.mp < Math.max(4 * (character.mp_cost || 0), 0.1 * character.max_mp);
		var drink = hp < CFG.hp_low ? (broke && last_pot === "use_hp" ? "use_mp" : "use_hp") : broke ? "use_mp" : hp < CFG.hp_at ? "use_hp" : character.mp < character.max_mp * CFG.mp_at ? "use_mp" : null;
		if (drink) (use_skill(drink), (last_pot = drink));
	}

	setInterval(function () {
		try { account(); phases(); act(); } catch (e) { game_log("fidelity: " + e); }
	}, CFG.period_ms);
	set_message("fidelity: " + CFG.preset + ", run 1/" + CFG.runs);
})();
