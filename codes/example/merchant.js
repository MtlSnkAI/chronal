// The example bot's merchant: waits in town with its stand open, and from level 40 casts Merchant's Luck (mluck) on
// itself and on anyone in range without it. Reports its mode to ChronAL's dashboard (docs/reference/reporting.md).
var mode = "start";
var chronal = (self.chronal = self.chronal || {});
chronal.mode = function () {
	return mode;
};
var TOWN = { map: "main", x: -60, y: 60 };
var last_respawn = 0;
setInterval(function () {
	if (character.rip) {
		if (Date.now() - last_respawn > 3000) (last_respawn = Date.now()), respawn();
		return (mode = "dead");
	}
	if (character.map != TOWN.map || Math.hypot(character.x - TOWN.x, character.y - TOWN.y) > 100) {
		if (character.stand) close_stand();
		if (!smart.moving) smart_move(TOWN);
		return (mode = "travel");
	}
	if (!character.stand) open_stand();
	if (character.level >= G.skills.mluck.level && !is_on_cooldown("mluck") && character.mp >= G.skills.mluck.mp) {
		var who = [character].concat(Object.values(parent.entities).filter(function (e) {
			return e.type == "character" && !e.rip && distance(character, e) < G.skills.mluck.range;
		}));
		var lacking = who.find(function (e) {
			return !e.s || !e.s.mluck;
		});
		if (lacking) use_skill("mluck", lacking);
	}
	mode = "stand";
}, 500);
