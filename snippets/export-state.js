// Export this character's state for ChronAL: over a pull of the account (the dashboard's New sim: Add export; chronal
// pull --add), or a setup's start state (state.from).
// Run it on LIVE (adventure.land) in the character's CODE: paste it into a CODE
// slot and press ENGAGE (or run it as a snippet). It changes nothing in the game:
// it copies the export to the clipboard (compressed when large) for ChronAL's Add
// export; too large for it, or when the clipboard refuses, it downloads <name>.json
// (or shows it when downloads are blocked). It logs a summary.
// For the most faithful copy: stand idle (no monsters targeting you, no party),
// open the merchant stand if trade slots matter, and export from inside the bank
// to include the bank (else the "al_bank" snapshot kept by the merchant CODE is used).
// With a tracker in the inventory its window opens and closes: the kill counts come along.
// It waits for a running upgrade/compound/exchange to finish (its result is only on the server).
(async () => {
	const P = parent;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const busy = () => Object.keys(P.character.q || {}).length || (P.character.items || []).some((i) => i && i.name == "placeholder");
	if (busy()) game_log("Export waits for the upgrade/compound/exchange queue to empty...");
	for (let i = 0; i < 240 && busy(); i++) await sleep(250);
	if (busy()) return game_log("Export aborted: the queue is still busy after 60 s. Stop the CODE that upgrades/compounds/exchanges, then run this again", "red");

	const ch = P.character;
	const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
	const pick = (keys) => Object.fromEntries(keys.filter((k) => ch[k] !== undefined).map((k) => [k, copy(ch[k])]));
	const now = new Date();

	// Kill counts decide the tracker's achievement stats; the server sends them on request.
	let tracker = null;
	if ((ch.items || []).some((i) => i && (i.name == "tracker" || i.name == "supercomputer"))) {
		const before = P.tracker;
		P.socket.emit("tracker");
		for (let i = 0; i < 50 && P.tracker === before; i++) await sleep(100);
		if (P.tracker !== before && P.tracker && P.tracker.monsters) {
			try {
				P.hide_modal();
			} catch (e) {}
			tracker = copy({ monsters: P.tracker.monsters, monsters_diff: P.tracker.monsters_diff, exchanges: P.tracker.exchanges, max: P.tracker.max });
		} else game_log("No tracker reply in 5 s: kill counts not exported (the local ones stay)", "#e58b36");
	}

	// The bank: live when standing in it, else the merchant CODE's snapshot.
	let bank = null,
		bank_source = null;
	const packs = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => /^items\d+$/.test(k) && Array.isArray(v)));
	if (ch.bank) {
		bank = copy({ ...packs(ch.bank), gold: ch.bank.gold });
		bank_source = { from: "character", at: now.toISOString() };
	} else {
		try {
			const snap = JSON.parse(P.localStorage.getItem("al_bank"));
			if (snap && snap.packs && Object.keys(snap.packs).length) {
				bank = copy(packs(snap.packs));
				bank_source = { from: "al_bank", at: new Date(snap.t).toISOString() };
			}
		} catch (e) {}
	}

	const cls = P.G.classes[ch.ctype] || {};
	const character = {
		name: ch.name,
		class: ch.ctype,
		...pick(["level", "xp", "gold", "hp", "mp", "rip", "isize", "items", "slots", "stand", "s", "q", "skin", "cx", "acx", "home", "age", "party", "encouragement"]),
		xcx: (ch.xcx || []).filter((c) => !(cls.xcx || []).includes(c)), // the client appends the class's free looks
		map: ch.map,
		in: ch.in,
		x: ch.real_x,
		y: ch.real_y,
		...(tracker && { tracker }),
	};
	const stats = pick([
		"max_hp", "max_mp", "attack", "heal", "frequency", "speed", "range", "armor", "resistance",
		"str", "int", "dex", "vit", "for", "mp_cost", "mp_reduction", "max_xp", "goldm", "xpm", "luckm",
		"evasion", "miss", "reflection", "lifesteal", "manasteal", "apiercing", "rpiercing", "crit", "critdamage",
		"dreturn", "tax", "pnresistance", "firesistance", "fzresistance", "phresistance", "stresistance",
		"incdmgamp", "stun", "blast", "explosion", "courage", "mcourage", "pcourage", "isize", "esize",
		"targets", "fear",
	]);
	// no session secrets (character_to_dict sends them for online characters)
	const characters = ((P.X && P.X.characters) || []).map((c) => ({ name: c.name, type: c.type, level: c.level, online: !!c.online, server: c.server || "" }));
	const state = {
		format: "chronal-export/1",
		exported_at: now.toISOString(),
		realm: P.server_region + " " + P.server_identifier,
		character,
		stats,
		bank,
		bank_source,
		account: { cash: ch.cash, characters },
	};

	// the clipboard (ChronAL's Add export takes it): over 64 KB gzipped, as "chronal-export:gz:" and base64; else (over
	// 4 MB, or the clipboard refuses) a file
	const json = JSON.stringify(state);
	let text = json,
		how = null;
	if (json.length > 64 << 10 && P.CompressionStream)
		try {
			const buf = new Uint8Array(await new P.Response(new P.Blob([json]).stream().pipeThrough(new P.CompressionStream("gzip"))).arrayBuffer());
			let b = "";
			for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
			text = "chronal-export:gz:" + P.btoa(b);
		} catch (e) {}
	if (text.length <= 4 << 20)
		try {
			await P.navigator.clipboard.writeText(text);
			how = "clipboard";
		} catch (e) {
			try {
				const t = P.document.createElement("textarea");
				t.value = text;
				t.style.position = "fixed";
				t.style.opacity = "0";
				P.document.body.appendChild(t);
				t.select();
				if (P.document.execCommand("copy")) how = "clipboard";
				t.remove();
			} catch (e2) {}
		}
	if (!how)
		try {
			const a = P.document.createElement("a");
			a.href = P.URL.createObjectURL(new P.Blob([JSON.stringify(state, null, 1)], { type: "application/json" }));
			a.download = ch.name + ".json";
			P.document.body.appendChild(a);
			a.click();
			a.remove();
			how = "file";
		} catch (e) {
			P.show_json(state);
			how = "shown";
		}
	const bankInfo = bank ? `${Object.keys(packs(bank)).length} bank packs (${bank_source.from}${bank_source.from == "al_bank" ? ", " + Math.round((now - Date.parse(bank_source.at)) / 60000) + " min old" : ""})` : "no bank";
	const where = how == "clipboard" ? " to the clipboard (" + Math.max(1, Math.round(text.length / 1024)) + " KB" + (text === json ? "" : ", compressed") + "): paste it in ChronAL's Add export" : how == "file" ? ": " + ch.name + ".json downloaded: drop it in ChronAL's Add export (or chronal pull --add)" : ": shown (copy it from the window)";
	game_log(`Exported ${ch.name}${where}. L${ch.level}, ${character.items.filter(Boolean).length} items, ${Object.keys(character.s || {}).length} conditions, ${bankInfo}${tracker ? ", tracker" : ""}`);
	if (ch.ctype == "merchant" && !ch.stand) game_log("Stand closed: trade slots not exported (import empties the local ones). Open the stand and export again if they matter", "#e58b36");
	if (ch.targets) game_log(`${ch.targets} monsters target you: attack/speed are not comparable (fear)`, "#e58b36");
})().catch((e) => game_log("export failed: " + e.message, "red"));
