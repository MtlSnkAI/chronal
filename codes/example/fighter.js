// The example bot for any fighting class: farms its spot (farm.js) and reports to ChronAL's dashboard through the
// chronal object (docs/reference/reporting.md): its mode, a status and its role. On the live game the object is unused.
var farm = require_code("farm");
var mode = "start";
var chronal = (self.chronal = self.chronal || {});
chronal.mode = function () {
	return mode;
};
chronal.status = function () {
	return { farm: farm.types, home: farm.home, target: (get_targeted_monster() || {}).mtype || null };
};
setInterval(function () {
	mode = farm.step();
}, 250);
