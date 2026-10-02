setInterval(function () {
	if (!character.stand) open_stand();
}, 5000);

;var chronal = (self.chronal = self.chronal || {});
chronal.mode = function () {
	return character.rip ? "dead" : "farm";
};


;chronal.role = "merchant";
