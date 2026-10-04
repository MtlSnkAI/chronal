"use strict";
// The game server's clock-driven events, as its node/server.js has them (test/schedule.test.js checks them against it):
// its hour is UTC's plus the region's offset (the sim's server is US: -5); night is its hours 0-5 (monsters move
// slower and may sleep); a daily starts at its hours 13 and 20 (crabxx, goobrawl, abtesting: in an order shuffled at
// boot, the seed's), a nightly at 23 (icegolem, franky), once the server has been up 2 minutes. Seasons are switches
// (drops, monsters): on from the boot, or switched at a run's game times (world.seasons { season, from, to }:
// sim/seasons.js). A run's world.start sets its clock (default 2026-01-01T00:00Z: the server's 19:00).
const SCHEDULE = { region: "US", time_offset: -5, dailies: [13, 20], nightlies: [23], night: [0, 5] };
const DAILIES = ["crabxx", "goobrawl", "abtesting"],
	NIGHTLIES = ["icegolem", "franky"],
	SEASONS = ["holidayseason", "lunarnewyear", "valentines", "halloween", "egghunt"];
const DEFAULT_START = "2026-01-01T00:00:00Z";
const H = 3600e3;

/** The server's hour at epoch ms t */
const serverHour = (t) => (new Date(t).getUTCHours() + 24 + SCHEDULE.time_offset) % 24;

/**
 * What a span of the clock crosses, in order: { kind: "night", from, to } (its part within the span), { kind:
 * "daily" | "nightly", at } (an hour it starts at). from, to: epoch ms.
 */
function crossed(from, to) {
	const out = [];
	let night = null;
	for (let h = Math.floor(from / H) * H; h < to; h += H) {
		const sh = serverHour(h),
			isNight = sh >= SCHEDULE.night[0] && sh <= SCHEDULE.night[1];
		if (isNight && !night) night = { kind: "night", from: Math.max(from, h), to: null };
		if (!isNight && night) (night.to = h), out.push(night), (night = null);
		if (h >= from) {
			if (SCHEDULE.dailies.includes(sh)) out.push({ kind: "daily", at: h });
			if (SCHEDULE.nightlies.includes(sh)) out.push({ kind: "nightly", at: h });
		}
	}
	if (night) (night.to = to), out.push(night);
	return out.sort((a, b) => (a.at ?? a.from) - (b.at ?? b.from));
}

module.exports = { SCHEDULE, DAILIES, NIGHTLIES, SEASONS, DEFAULT_START, serverHour, crossed };
