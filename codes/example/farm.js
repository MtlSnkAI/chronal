// The example bot's shared slot (var farm = require_code("farm"): its exports): where to farm, and one step of farming. The spot comes from the
// run setup's params.farm ({ map, x, y, monsters }); without it, the nearest monster it can take on (no bosses) around
// where the character started. With get("mode") == "rest" (the browser storage, as a player's control panel would set
// it) it waits in town instead.
module.exports = (function () {
	var p = (self.chronal && self.chronal.params && self.chronal.params.farm) || {};
	var types = p.monsters && p.monsters.length ? p.monsters : [null];
	var home = p.map ? { map: p.map, x: p.x, y: p.y } : { map: character.map, x: character.x, y: character.y };
	var last_respawn = 0;
	var dist = function (e) {
		return Math.hypot(e.x - character.x, e.y - character.y);
	};
	// a monster it can take on (the spot's monsters are the setup's choice; any other has to pass this): one that fights
	// back (not a training dummy), whose damage per second, as G gives it, would take 20 s or more to kill it, and whose hp
	// it can wear down (bosses can't pass)
	function safe(e) {
		var g = G.monsters[e.mtype];
		return !!g && g.attack > 0 && g.attack * g.frequency * 20 < character.max_hp && g.hp < character.attack * character.frequency * 600;
	}
	// the nearest monster of the farmed types (any type: the nearest safe one), else null
	function nearest() {
		var best = null;
		types.forEach(function (type) {
			var m = type ? get_nearest_monster({ type: type }) : null;
			if (!type)
				for (var id in parent.entities) {
					var e = parent.entities[id];
					if (e.type == "monster" && !e.dead && safe(e) && (!m || dist(e) < dist(m))) m = e;
				}
			if (m && (!best || dist(m) < dist(best))) best = m;
		});
		return best;
	}
	// one step: respawn, drink, loot, then fight or walk home; returns what it is doing (the reported mode)
	function step() {
		if (character.rip) {
			if (Date.now() - last_respawn > 3000) (last_respawn = Date.now()), respawn();
			return "dead";
		}
		if (character.hp < character.max_hp * 0.6 || character.mp < character.max_mp * 0.3) use_hp_or_mp();
		loot();
		// the browser storage's "mode" (the setup's accounts.<k>.storage, its steering): "rest" waits in town
		if (get("mode") == "rest") {
			if (!smart.moving && (character.map != "main" || Math.hypot(character.x, character.y) > 200)) smart_move({ map: "main", x: 0, y: 0 });
			return "rest";
		}
		if (is_moving(character) || smart.moving) return "moving";
		var target = get_targeted_monster();
		// gone from view (out of range, or another map after a respawn): a target kept from before would hold us in place
		if (target && !parent.entities[target.id]) change_target(null), (target = null);
		if (!target) {
			target = nearest();
			if (target) change_target(target);
			else if (character.map != home.map || dist(home) > 100) return smart_move(home), "travel";
			else return "waiting";
		}
		if (is_in_range(target)) {
			if (can_attack(target)) attack(target);
		} else if (can_move_to(target)) move(character.x + (target.x - character.x) / 2, character.y + (target.y - character.y) / 2);
		else smart_move({ x: target.x, y: target.y }); // a wall in between: a straight step would stop at it
		return "fight";
	}
	return { types: types, home: home, step: step };
})();
