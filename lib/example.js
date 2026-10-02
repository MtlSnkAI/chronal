// chronal example: an annotated setup; whole-line comments only, so `grep -v '^\s*//'` leaves the JSON
"use strict";
const path = require("node:path");
const { FORMAT } = require("./setup");

function example() {
	const bot = path.join(__dirname, "..", "codes", "example");
	return `// ${FORMAT}: one JSON file describes a run completely (docs/reference/setup.md). Paths are relative to
// this file's directory (absolute ones work too). Unknown keys are errors. Save it without these // lines:
//   chronal example | grep -v '^\\s*//' > my.json && chronal run my.json --check
{
	"format": "${FORMAT}",
	// the card title (default: the file name)
	"name": "ranger + priest @ squigtoad",
	// free text for the dashboard; null: made from the characters, their farm and extras
	"strategy": null,
	// game time: duration measured after the warm-up (90s, 30m, 2h, 1d, or minutes); seed: same seed + same CODE =
	// same run; until: stop early when this holds
	// (c.<Name>.level, c.<Name>.kills.<type>, party.kills.total, ... as a steering condition, docs/reference/setup.md;
	// t = game s since the warm-up),
	// checked every run.check (game time between checks: "1s" by default, at least "100ms")
	"run": { "duration": "30m", "warmup": "1m", "seed": 1, "until": "c.Ran1.level >= 45", "check": "1s", "grid_ms": 30000 },
	// one thread per character (threads) or one for all; roi: "box50" freezes monsters out of every player's reach.
	// age: game time the world runs with no characters before they log in (its monsters level up as on a server up
	// that long that nobody farmed); "0m": they log in at the boot. ping: the round trip client<->server ms (the
	// game's character.ping)
	"world": { "roi": null, "threads": true, "age": "0m", "ping": 18 },
	// merged into every character ("code" key by key; a character's null unsets one)
	"defaults": { "account": "main", "fps": 10, "code": { "dir": ${JSON.stringify(bot)}, "entry": "fighter" } },
	// age_days: 0 = a new account (New Player for 40 days), N = created N days before the run; bank: { "from": an
	// export } or { "gold": 5000, "items0": [], "items1": [] }; none: a new account's (1000 gold, two empty packs);
	// storage: what the CODE's get(key) returns at the start (its browser's storage; local_storage: raw localStorage)
	"accounts": { "main": { "age_days": 0, "storage": { "mode": "farm" } } },
	// run order. state: { "from": an export (the snippet's, a pull's <Name>.json) } and/or level, xp, gold, items, slots
	// (slots replace the export's gear, or the starter weapon, helmet and shoes); none: a new L1 character. at:
	// "map:x:y". params: data for the CODE (chronal.params; farm = { map, x, y, monsters }). code: { dir (slots for
	// require_code), entry (a slot of dir) | file, prelude, append: [files], build: { cmd, cwd }, git: { repo, rev }: those
	// paths at a git revision } (chronal run --code-set NAME: a CODE set's instead); extra: CODE lines appended; role: dps,
	// tank, healer, merchant or support (default by class)
	"characters": [
		{
			"name": "Ran1", "class": "ranger",
			"state": { "level": 40, "slots": { "mainhand": { "name": "bow", "level": 7 } } },
			"at": "main:-1175:422",
			"params": { "farm": { "map": "main", "x": -1175, "y": 422, "monsters": ["squigtoad"] } }
		},
		{
			"name": "Pri1", "class": "priest", "role": "healer",
			"state": { "level": 40 },
			"at": "main:-1175:422",
			"params": { "farm": { "map": "main", "x": -1175, "y": 422, "monsters": ["squigtoad"] } },
			"code": { "entry": "priest" }
		}
	],
	// form "harness": the leader invites the members every 5 s and they accept its invites only (this replaces the
	// CODE's on_party_invite); "code": the CODE forms it; "none": nobody invites. The merchant may be a member.
	"party": { "members": ["Ran1", "Pri1"], "leader": "Ran1", "form": "harness" },
	// steering, as a player at their controls: at (game time since the run's start, after the warm-up) set storage keys
	// (storage, local_storage: its character's account's, none: every account's) and/or run code in a character's CODE
	// (none: every character's), as command_character does
	"steer": [{ "at": "20m", "storage": { "mode": "rest" }, "note": "rest" }, { "at": "25m", "character": "Pri1", "code": "set_message('steered')" }]
}
`;
}

module.exports = { example };
