// Upgrade grace probe CODE: reads the server's upgrade grace per level (S.ugrace, the realm's own, which every upgrade
// on it moves) without upgrading anything, on live and in ChronAL (docs/how-to/measure-upgrade-grace.md). Self-contained
// (no other slots): paste it into a slot on live; in the sim it runs as a file CODE.
//
// How: upgrade(item, scroll, null, true) only calculates: the server works out the chance (grace in) and answers it,
// nothing consumed, no roll. For a character that has never upgraded (its own grace per level 0) and never used an
// offering (its offering grace 0), the server's grace is the one unknown in that chance: tools/ugrace/invert.js (and
// the readout here) solves for it. Every round it asks for each upgradeable item in the bag (not locked, below +12,
// grade at +0 normal, high or rare) with the bag's lowest scroll it takes; an item at +n reads level n+1. No offerings.
//
// It walks to the upgrade NPC (the server answers only near it) and reads EVERY_S apart for HOURS.
// Where the readings go:
// - live: localStorage (get("ugrace_last")), saved each round, and downloaded as ugrace-<name>-<start>.json every
//   DOWNLOAD_EVERY rounds and at the end (allow the site several downloads); again: ugrace_download() in this CODE.
// - the sim: chronal.status (the run's snapshot, players[].code_status); chronal.params.ugrace_probe overrides CFG.
var CFG = {
	every_s: 300, // a round of readings every this many seconds
	hours: 24, // then it stops
	download_every: 12, // live: a download every this many rounds (12 x 300 s: hourly), and at the end
};
var VERSION = "ugrace-probe/1";

(function () {
	var IN_SIM = typeof chronal !== "undefined" && !!chronal.params;
	if (IN_SIM && chronal.params.ugrace_probe) for (var k in chronal.params.ugrace_probe) CFG[k] = chronal.params.ugrace_probe[k];
	var t0 = Date.now(),
		R = {
			format: "chronal-ugrace-probe/1", version: VERSION, env: IN_SIM ? "sim" : "live", name: character.name,
			server: { region: parent.server_region || null, id: parent.server_identifier || null },
			cfg: CFG, started_at: new Date(t0).toISOString(), rounds: 0, readings: [], errors: [], done: false,
		};

	// the server's: an item's grade at a level (calculate_item_grade), its grade at +0 (igrade) and the grace that gives it
	function gradeAt(def, level) {
		var g = def.grades || [9, 10, 11, 12];
		for (var i = 3; i >= 0; i--) if (level >= g[i]) return i + 1;
		return 0;
	}
	var IGRACE = { 0: 1, 1: -1, 2: -2 };
	// the server's grace from a chance (tools/ugrace/invert.js has the same; the record keeps what it needs)
	function invert(x) {
		var base = x.high ? x.p * 1.2 + 0.01 : x.p,
			cap = x.high ? Math.min(x.p + 0.36, x.p * 3) : Math.min(x.p + 0.24, x.p * 2),
			k = x.p / x.L + 0.001,
			fl = 0.4 / ((x.L - 0.999) * (x.L - 0.999)),
			own = Math.min(x.L + 1, x.grace + x.igrace);
		if (x.chance >= cap - 1e-12) return { state: "cap" };
		if (x.chance - base <= 1e-12) {
			var t_max = (4.8 * fl) / k - own; // (S.ugrace is whole: a bound under 1 is 0)
			return t_max < -1e-6 ? { state: "off" } : 3 * t_max < 1 - 1e-9 ? { state: "ok", term: 0, ugrace: 0, floor: true } : { state: "floor", t_max: t_max };
		}
		var t = (4.8 * (x.chance - base + fl)) / k - own;
		return { state: t > 6 + 1e-6 || t < -1e-6 ? "off" : "ok", term: t, ugrace: t < 6 - 1e-6 ? 3 * t : null };
	}
	// this round's probes: { num, item, level, L, igrade, igrace, p, scroll_num, scroll, high }
	function probes() {
		var out = [], scrolls = {};
		character.items.forEach(function (it, i) {
			if (it && /^scroll[0-4]$/.test(it.name)) scrolls[G.items[it.name].grade] = i;
		});
		character.items.forEach(function (it, i) {
			var def = it && G.items[it.name];
			if (!def || !def.upgrade || it.l || (it.level || 0) >= 12) return;
			var level = it.level || 0, L = level + 1, grade = gradeAt(def, level), igrade = gradeAt(def, 0), sg = null;
			if (grade >= 4 || igrade > 2) return;
			for (var g = grade; g <= 4 && sg === null; g++) if (scrolls[g] != null) sg = g;
			if (sg === null) return;
			out.push({ num: i, item: it.name, level: level, L: L, igrade: igrade, igrace: IGRACE[igrade] || 0, p: G.upgrades[igrade][L], scroll_num: scrolls[sg], scroll: "scroll" + sg, high: sg > grade && L <= 10 });
		});
		return out;
	}

	function save() {
		var s = JSON.stringify(R);
		if (!IN_SIM) set("ugrace_last", R);
		return s;
	}
	self.ugrace_download = function () {
		var s = save(), name = "ugrace-" + character.name + "-" + R.started_at.replace(/[:.]/g, "-") + ".json";
		try {
			var d = parent.document, a = d.createElement("a");
			a.href = parent.URL.createObjectURL(new parent.Blob([s], { type: "application/json" }));
			a.download = name; d.body.appendChild(a); a.click(); a.remove();
			return name;
		} catch (e) { game_log("ugrace: no download (" + e + "): show_json(get('ugrace_last'))"); }
	};
	if (IN_SIM) chronal.status = function () { return R; };

	// where smart_move({ to: "upgrade" }) goes, by the upgrade NPC (the server answers within 400 px of its spot)
	var near = function () { return character.map === "main" && Math.hypot(character.x + 204, character.y + 129) < 200; };
	async function round() {
		var t = new Date().toISOString(), ps = probes(), shown = [];
		if (!ps.length) R.errors.push({ t: t, error: "no upgradeable item with a scroll of its grade (or higher) in the bag" });
		for (var i = 0; i < ps.length; i++) {
			var x = ps[i];
			try {
				var r = await upgrade(x.num, x.scroll_num, null, true);
				var rd = { t: t, num: x.num, item: x.item, level: x.level, L: x.L, igrade: x.igrade, igrace: x.igrace, p: x.p, scroll: x.scroll, high: x.high, grace: r.grace || 0, chance: r.chance };
				var v = invert(rd);
				rd.state = v.state;
				if (v.term != null) (rd.term = v.term), (rd.ugrace = v.ugrace);
				R.readings.push(rd);
				shown.push("L" + x.L + ":" + (v.state === "ok" ? (v.ugrace == null ? ">=18" : Math.round(v.ugrace * 10) / 10) : v.state));
			} catch (e) {
				R.errors.push({ t: t, num: x.num, item: x.item, error: (e && (e.reason || e.response || e.message)) || String(e) });
			}
		}
		R.rounds++;
		set_message("ugrace " + shown.join(" "));
		save();
		if (!IN_SIM && R.rounds % CFG.download_every === 0) self.ugrace_download();
	}

	(async function main() {
		if (!near()) {
			try {
				await smart_move({ to: "upgrade" });
			} catch (e) {}
		}
		if (!near()) return (R.errors.push({ t: new Date().toISOString(), error: "not near the upgrade NPC" }), (R.done = true), set_message("ugrace: can't reach the upgrade NPC"));
		while (Date.now() - t0 < CFG.hours * 3600e3) {
			while (character.q && character.q.upgrade) await new Promise(function (r) { setTimeout(r, 500); });
			await round();
			await new Promise(function (r) { setTimeout(r, CFG.every_s * 1000); });
		}
		R.done = true;
		save();
		if (!IN_SIM) self.ugrace_download();
		set_message("ugrace: done, " + R.rounds + " rounds");
	})();
})();
