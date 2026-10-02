// The example bot's priest: heals the party member in view (or itself) with the lowest hp share below HEAL_AT, walking
// closer when out of range; partyheal when 2 or more are below PARTYHEAL_AT; otherwise farms as the fighter does.
var farm = require_code("farm");
var HEAL_AT = 0.7,
	PARTYHEAL_AT = 0.6;
var mode = "start";
var chronal = (self.chronal = self.chronal || {});
chronal.role = "healer";
chronal.mode = function () {
	return mode;
};
// itself and the party members in view, alive, the most hurt first
function hurt(below) {
	var list = [character];
	(parent.party_list || []).forEach(function (n) {
		var e = n != character.name && get_player(n);
		if (e && !e.rip) list.push(e);
	});
	return list
		.filter(function (e) {
			return e.hp / e.max_hp < below;
		})
		.sort(function (a, b) {
			return a.hp / a.max_hp - b.hp / b.max_hp;
		});
}
setInterval(function () {
	if (!character.rip) {
		if (hurt(PARTYHEAL_AT).length >= 2 && !is_on_cooldown("partyheal") && character.mp >= G.skills.partyheal.mp) return use_skill("partyheal"), (mode = "heal");
		var h = hurt(HEAL_AT)[0];
		if (h) {
			mode = "heal";
			if (h === character || is_in_range(h, "heal")) return can_heal(h) && heal(h);
			if (!is_moving(character) && !smart.moving) move(character.x + (h.x - character.x) / 2, character.y + (h.y - character.y) / 2);
			return;
		}
	}
	mode = farm.step();
}, 250);
