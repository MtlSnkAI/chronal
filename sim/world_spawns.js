"use strict";
// A custom world (a setup's world.spawns; not as on live, so said on the run): monsters of the game's types put at a
// spot as the server puts its maps' monsters (its own new_monster, a spawn of its own), each spawn
//   { monster, at: "map:x:y", count = 1, radius = 0, level, stats: { hp, attack, armor, resistance, frequency, speed,
//     range, evasion, avoidance, xp, ... }, hp: "endless" (it never dies: a target dummy), respawn: game time after a
//     death ("no": none; default the type's own), clear: px (the map's own monsters within it removed, for good) }
// stats over the type's (copied) as the server keeps a monster's own stats (zone_stats: what its recalculations start
// from); hp and xp set on the monster itself. Spawned after the server boots, before anyone logs in; the server's
// level-up loop levels them as it does its own (level: at least that).
const { parseDuration } = require("../lib/setup");

const ENDLESS = 1e12; // hp no run deals (a dummy)
const ZONE = ["attack", "speed", "frequency", "armor", "resistance", "output", "incdmgamp", "avoidance"];

/** Spawn every group of spawns in the server (S, its vm context) on the clock; -> { groups: [{ ...spawn, live }] } */
function spawnAll(S, clock, spawns) {
	const groups = spawns.map((sp, i) => {
		const [map, x, y] = sp.at.split(":"),
			px = Number(x),
			py = Number(y);
		if (!S.instances[map]) throw new Error(`world.spawns[${i}].at: no instance ${map} on the server`);
		if (!S.G.monsters[sp.monster]) throw new Error(`world.spawns[${i}].monster: no monster ${sp.monster} in the game`);
		// the map's own monsters around the spot out for good (an arena of its own)
		if (sp.clear)
			for (const m of Object.values(S.instances[map].monsters))
				if (Math.hypot(m.x - px, m.y - py) <= sp.clear) S.remove_monster(m, { nospawn: true, silent: true, method: "disappear" });
		// (special: the server queues no respawn of its own; ours below)
		const def = { type: sp.monster, position: [px, py], radius: sp.radius || 0, count: sp.count || 1, special: true, chronal: true, gold: goldOf(S, map, sp.monster) };
		return { sp, map, def, respawnMs: respawnOf(S, sp), pending: 0 };
	});
	for (const g of groups) for (let k = 0; k < g.def.count; k++) one(S, g);
	// a death: its own back after the respawn time (checked each game second)
	const tick = () => {
		for (const g of groups) {
			const missing = g.def.count - (g.def.live || 0) - g.pending;
			if (g.respawnMs == null || missing <= 0) continue;
			for (let k = 0; k < missing; k++) {
				g.pending++;
				clock.at(clock.now + g.respawnMs, () => (g.pending--, one(S, g)));
			}
		}
		clock.at(clock.now + 1000, tick);
	};
	clock.at(clock.now + 1000, tick);
	return { groups };
}

// one monster of a group, as the spawn says
function one(S, g) {
	const sp = g.sp,
		m = S.new_monster(g.map, g.def);
	if (!m) return null;
	while (sp.level && m.level < sp.level) S.level_monster(m, { silent: true });
	const st = sp.stats || {};
	if (Object.keys(st).some((k) => ZONE.includes(k))) m.zone_stats = { ...S.G.monsters[m.type], ...Object.fromEntries(Object.entries(st).filter(([k]) => ZONE.includes(k))) };
	for (const [k, v] of Object.entries(st)) if (!ZONE.includes(k) && k !== "hp") m[k] = v;
	if (st.hp != null) m.hp = m.max_hp = st.hp;
	if (sp.hp === "endless") m.hp = m.max_hp = ENDLESS;
	S.calculate_monster_stats(m);
	return m;
}

// the gold a kill drops: the map's pack of that type's, else none
const goldOf = (S, map, type) => ((S.G.maps[S.instances[map].map].monsters || []).find((p) => p.type === type) || {}).gold;
// game ms after a death: the spawn's, none ("no"), else the type's own (G.monsters[type].respawn: seconds)
function respawnOf(S, sp) {
	if (sp.respawn === "no" || sp.hp === "endless") return null;
	if (sp.respawn != null) return parseDuration(sp.respawn);
	const r = S.G.monsters[sp.monster].respawn;
	return r == null || r < 0 ? null : r * 1000;
}

module.exports = { spawnAll, ENDLESS };
