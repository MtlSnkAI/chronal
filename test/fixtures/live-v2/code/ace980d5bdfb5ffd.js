self.chronal = self.chronal || {}; chronal.params = {"farm":{"map":"main","x":-1125,"y":1118,"monsters":["tortoise","frog"]}};
require_code("helper");
setInterval(function () {
	var t = pick_target(chronal.params.farm.monsters);
	if (t && !is_on_cooldown("attack")) attack(t);
}, 250);

;var chronal = (self.chronal = self.chronal || {});
chronal.mode = function () {
	return character.rip ? "dead" : "farm";
};

