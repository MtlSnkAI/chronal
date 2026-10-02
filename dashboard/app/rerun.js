// Rerun (#/new?from=<run id>[&runs=N]): a run's setup file again (chronal run <file>), from the next seed, as you change
// it: its stored CODE, the current one or another set's; a duration, seed and Runs (a run per seed); Record a replay;
// Advanced: the warm-up, start, world age, ping, account age, one setting swept over a list of values. The dry run's
// plan and warnings while editing; the launches' outcomes under the form.
import { h } from "./vendor/preact.js";
import { useState, useEffect, useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { fmtSpan, parseSpan, seedOf, wageOf, r2, api } from "./lib.js";
import { S, ready, runHash, pollSoon } from "./store.js";
import { KRow, KDur, KAdv, KChip, Select, PRESETS } from "./ui.js";

const html = htm.bind(h);
// the next seed of a run's setup: past every seed its runs had
const nextSeed = (w) => 1 + Math.max(0, seedOf(w) || 0, ...S.data.filter((x) => x.setup_key && x.setup_key === w.setup_key).map(seedOf).filter((v) => v != null));
// the form as the run gives it
function formOf(w, runs) {
	const c = w.ctl || {}, r = w.run || {}, rs = c.rerun_setup || {};
	const f = { id: w.id, dry: null, err: null, seq: 0, edited: false, code: "stored", cset: "", sets: [], age0: rs.age_days ?? null, age: rs.age_days != null ? String(Math.floor(rs.age_days)) : "", hashes: {} };
	f.age1 = f.age; // the recorded age in whole days
	f.dur0 = (r.duration_ms != null ? r2(r.duration_ms / 60000) : String(Math.max(1, Math.round((w.measured_ms || 0) / 60000)))) + "m";
	f.seed = nextSeed(w);
	f.duration = f.dur0; f.tag = w.tag;
	// the world knobs: the recorded warm-up, world age and ping (sent as they stand: the server passes what differs)
	const rec = c.recorded || { warmup_ms: r.warmup_ms || 0, age_ms: wageOf(w) };
	f.warmup = f.warmup0 = fmtSpan(rec.warmup_ms || 0); f.wage = f.wage0 = fmtSpan(rec.age_ms || 0); f.ping = f.ping0 = rec.ping != null ? String(rec.ping) : "";
	f.start = f.start0 = ((w.world && w.world.start) || "2026-01-01T00:00:00.000Z").slice(0, 16) + "Z"; // the world's clock as it booted (UTC)
	// a batch: N seeds from the seed, times the values of one swept setting
	f.nseeds = /^\d+$/.test(runs || "") ? String(runs) : "1"; f.sweep = ""; f.svals = "";
	f.record = false; f.adv = false; f.out = null; // Record a replay; Advanced unfolded; the launches' outcomes
	return f;
}
// a run of a setup: current_code or a set's, age_days once the field no longer shows the recorded age (a word: the
// server says why not); the warm-up, world age and ping as they stand (the recorded ones pass nothing)
function launchBody(f, dry) {
	const d = String(f.duration).trim(), a = String(f.age).trim();
	const setup = { current_code: f.code === "current", ...(f.code === "set" && f.cset ? { code_set: f.cset } : {}), ...(a !== "" && a !== f.age1 ? { age_days: /^\d+(\.\d+)?$/.test(a) ? Number(a) : a } : {}) };
	const world = { warmup: String(f.warmup).trim() || null, world_age: String(f.wage).trim() || null, ping: String(f.ping).trim() || null, ...(f.start.trim() !== f.start0 ? { start: f.start.trim() } : {}) };
	return { of: f.id, duration: d || null, seed: Number(f.seed), ...(f.edited ? { tag: f.tag } : {}), ...world, ...setup, ...(f.record ? { record: true } : {}), ...(dry ? { dry: true } : {}) };
}
// the batch: a launch per seed and swept value ({ over: the body's changes, tag: added to an edited tag, text })
const SWEEPS = { duration: ["duration", "Duration"], warmup: ["warmup", "Warm-up"], wage: ["world_age", "World age"], ping: ["ping", "Ping (ms)"], age: ["age_days", "Account age (days)"] };
const svalsOf = (f) => String(f.svals || "").split(",").map((x) => x.trim()).filter(Boolean);
// the seeds that already ran to their end with the form's setup, CODE, world and duration (a rerun of one is identical)
function usedSeeds(f, over) {
	const w = S.data.find((x) => x.id === f.id), d = String(over && over.duration != null ? over.duration : f.duration).trim();
	if (!w || !w.setup_key || f.record || f.code !== "stored" || f.start.trim() !== f.start0 || f.warmup !== f.warmup0 || f.wage !== f.wage0 || String(f.ping).trim() !== f.ping0 || String(f.age).trim() !== String(f.age1) || (over && (over.warmup != null || over.world_age != null || over.ping != null || over.age_days != null))) return new Set();
	const ms = /^\d+(\.\d+)?$/.test(d) ? Number(d) * 60000 : parseSpan(d);
	return new Set(S.data.filter((x) => x.setup_key === w.setup_key && x.end && x.end.reason === "complete" && (ms == null || (x.run && x.run.duration_ms === ms)) && ((x.run && x.run.until) || "") === ((w.run && w.run.until) || "")).map(seedOf).filter((v) => v != null));
}
function batchOf(f) {
	const n = Math.max(1, Math.min(50, Math.floor(Number(f.nseeds)) || 1)), s0 = Number(f.seed) || 1;
	const vals = f.sweep && SWEEPS[f.sweep] && svalsOf(f).length ? svalsOf(f) : [null], out = [];
	// n seeds from the seed on, past the ones that already ran (a batch of one keeps its seed: the dry run says if it is identical)
	const seedsFor = (over) => { if (n === 1) return [s0]; const used = usedSeeds(f, over), xs = []; for (let x = s0; xs.length < n; x++) if (!used.has(x)) xs.push(x); return xs; };
	for (const v of vals) for (const sd of seedsFor(v == null ? null : { [SWEEPS[f.sweep][0]]: v })) out.push({ over: { seed: sd, ...(v == null ? {} : { [SWEEPS[f.sweep][0]]: f.sweep === "age" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v }) }, tag: (n > 1 ? " s" + sd : "") + (v == null ? "" : " " + f.sweep + " " + v), text: "seed " + sd + (v == null ? "" : ", " + SWEEPS[f.sweep][1].toLowerCase() + " " + v) });
	return out;
}
const batchText = (f) => { const n = Math.max(1, Math.floor(Number(f.nseeds)) || 1), v = f.sweep && svalsOf(f).length ? svalsOf(f) : null; return (n > 1 ? n + " seeds from " + f.seed : "seed " + f.seed) + (v ? " × " + SWEEPS[f.sweep][1].toLowerCase() + " " + v.join(", ") : ""); };
const NOT_HERE = "not allowed from here (open the dashboard by its address or localhost)";

export function Rerun({ route }) {
	const [w, setW] = useState(undefined), fr = useRef(null), [, bump] = useState(0), draw = () => bump((n) => n + 1), timer = useRef(0), root = useRef(null);
	const f = fr.current;
	// (the form shown: the focus on its first field)
	useEffect(() => { const i = f && root.current && root.current.querySelector(".paf input"); if (i) i.focus(); }, [!!f]);
	// the dry run: when the form opens and 400 ms after the last edit
	const preview = (ms = 400) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(async () => {
			const x = fr.current;
			if (!x) return;
			const seq = ++x.seq;
			try {
				const r = await api("api/launch", "POST", launchBody(x, true)), o = await r.json().catch(() => ({}));
				if (seq !== x.seq) return;
				x.dry = r.ok ? o.plan || o : null; x.err = r.ok ? null : o.reason || (r.status === 403 ? NOT_HERE : "HTTP " + r.status);
				// each character's CODE hashes beside the choice: the stored one, the current one once a dry run resolved it
				if (x.dry && x.dry.setup && Array.isArray(x.dry.setup.characters)) for (const c of x.dry.setup.characters) { const hh = (x.hashes[c.name] ||= {}); hh.stored = c.stored; if (x.dry.setup.code === "current" && c.hash) hh.current = c.hash; }
				autoTag(x);
			} catch (e) { (x.err = e.message), (x.dry = null); }
			draw();
		}, ms);
	};
	// the tag the server gives the rerun (the dry run's: a sim's seed and duration in the original's tag replaced or
	// added), until the tag is edited; only an edited tag is sent
	const autoTag = (x) => { if (!x.edited && x.dry && x.dry.tag) x.tag = x.dry.tag; };
	useEffect(() => {
		let gone = false;
		ready.then(() => {
			if (gone) return;
			const x = S.data.find((y) => y.id === route.from);
			setW(x || null);
			if (!x || !(x.ctl && x.ctl.rerun)) return;
			fr.current = formOf(x, route.runs);
			fetch("api/code").then((r) => r.json()).then((o) => { if (fr.current) (fr.current.sets = (o.sets || []).map((y) => y.name)), draw(); }, () => {});
			preview(0);
		});
		return () => { gone = true; clearTimeout(timer.current); fr.current = null; };
	}, []);
	const title = (more) => html`<div class="drh"><h2>Rerun${more}</h2></div>`;
	if (w === undefined) return html`<div id="nsim">${title(null)}</div>`;
	const no = (why) => html`<div id="nsim">${title(null)}<div class="paf"><p class="mnote">${why} <a href="#/new">Compose a new sim</a></p></div></div>`;
	if (!w) return no(route.from + " is not among the runs (removed?).");
	if (!(w.ctl && w.ctl.rerun)) return no(((w.ctl && w.ctl.rerun_why) || "this run can't run again") + ".");
	if (!f) return html`<div id="nsim">${title(null)}</div>`;
	// a field changed: the tag follows the server's until edited; the dry run again
	const set = (k, v) => { f[k] = v; if (k === "tag") f.edited = true; else autoTag(f); f.err = null; draw(); preview(); };
	const code = f.code === "current" ? "the CODE its source gives now (built first)" : f.code === "set" ? "the CODE of the set " + (f.cset || "(none picked)") : "the original's stored CODE";
	const help = "A new run of this run's setup file (chronal run) with " + code + " and its start states.";
	const hs = Object.entries(f.hashes), ctip = "stored: the original's; current: what its source gives now (built first); another set: a CODE set's (a new version from the CODE page, a copy, any other)" + (hs.length ? ". " + hs.map(([n, x]) => n + ": stored " + x.stored + (x.current ? ", current " + x.current : "")).join("; ") : "");
	const field = (k, id, label, hint) => html`<${KRow} label=${label} id=${id}><input type="text" id=${id} value=${f[k]} data-tip=${hint} onInput=${(e) => set(k, e.currentTarget.value)} /></${KRow}>`;
	// Advanced: what differs from the run's, else "as recorded"
	const sum = [f.warmup !== f.warmup0 && "warm-up " + f.warmup, f.wage !== f.wage0 && "world age " + f.wage, String(f.ping).trim() !== f.ping0 && "ping " + f.ping, f.start.trim() !== f.start0 && "starts " + f.start,
		String(f.age).trim() !== String(f.age1) && "account age " + f.age, f.sweep && svalsOf(f).length && "sweep " + SWEEPS[f.sweep][1].toLowerCase()].filter(Boolean);
	const p = f.dry, warns = p && Array.isArray(p.warnings) ? p.warnings : [], n = batchOf(f).length;
	// a single run identical to one that ran to its end: not started (the same seed, CODE, setup and duration), unless it
	// runs again to be recorded
	const dupe = n === 1 && !f.record && warns.some((x) => /an identical run/.test(x));
	const go = async () => {
		const jobs = batchOf(f);
		f.busy = true; draw();
		if (jobs.length > 1) {
			// the batch's launches one after another, each one's outcome listed; past the free threads they queue
			const res = (f.out = jobs.map((j) => ({ j, st: "waiting", why: "" })));
			for (const r of res) {
				if (fr.current !== f) return;
				const body = { ...launchBody(f, false), ...r.j.over };
				if (f.edited) body.tag = (f.tag + r.j.tag).slice(0, 80);
				r.st = "checking"; draw();
				try {
					// an identical run (a seed that already ran to its end with all the same): skipped
					const y = await api("api/launch", "POST", { ...body, dry: true }), q = await y.json().catch(() => ({})), plan = y.ok ? q.plan || q : null;
					if (!body.record && plan && Array.isArray(plan.warnings) && plan.warnings.some((x) => /an identical run/.test(x))) { r.st = "skipped"; r.why = "this seed already ran to its end: identical"; draw(); continue; }
					r.st = "starting"; draw();
					const x = await api("api/launch", "POST", body), o = await x.json().catch(() => ({}));
					if (x.status === 202 || x.ok) r.st = o.launch && o.launch.state === "queued" ? "queued" : "started";
					else { r.st = "failed"; r.why = o.reason || "HTTP " + x.status; }
				} catch (e) { r.st = "failed"; r.why = e.message; }
				draw();
			}
		} else {
			try {
				const r = await api("api/launch", "POST", launchBody(f, false)), o = await r.json().catch(() => ({}));
				if (r.status === 202 || r.ok) { const q = o.launch && o.launch.state === "queued"; f.out = [{ j: { text: "seed " + f.seed }, st: q ? "queued" : "started", why: "it shows in the runs list as it begins" }]; f.seed = Number(f.seed) + 1; preview(0); }
				else f.err = o.reason || (r.status === 403 ? NOT_HERE : "HTTP " + r.status);
			} catch (e) { f.err = e.message; }
		}
		f.busy = false; draw();
		pollSoon();
	};
	const dot = (st) => (st === "started" ? "running" : st === "queued" ? "" : st === "failed" || st === "not started" ? "bad" : "stopped");
	return html`<div id="nsim" ref=${root}>
		<div class="drh"><h2>Rerun<span class="gu">of <a href=${runHash(w.id)}>${w.tag || w.id}</a></span><button type="button" class="ib fhelp" aria-label="What it does" data-tip=${help}>?</button><a class="lnk sm" href="#/new" data-tip="who is logged in, from what state, which CODE">Compose a new sim instead</a></h2></div>
		<div class="paf">
			<div class="frow" role="radiogroup" aria-label="CODE"><span class="fl chash" data-tip=${ctip}>CODE</span>${[["stored", "stored"], ["current", "current"], ["set", "another set"]].map(([v, t]) => html`<label class="opt"><input type="radio" name="f-code" value=${v} checked=${f.code === v} onChange=${() => set("code", v)} />${t}</label>`)}</div>
			${f.code === "set" ? html`<${KRow} label=""><${Select} aria-label="The CODE set" value=${f.cset} onChange=${(e) => set("cset", e.currentTarget.value)}><option value="">a CODE set...</option>${f.sets.map((x) => html`<option value=${x}>${x}</option>`)}</${Select}></${KRow}>` : null}
			<${KRow} label="Duration" id="f-dur"><${KDur} cur=${f.duration} onPick=${(v) => set("duration", v)} list=${PRESETS} /><input type="text" id="f-dur" value=${f.duration} data-tip="game time measured: 90s, 30m, 2h, 1d or a number of game minutes" onInput=${(e) => set("duration", e.currentTarget.value)} /></${KRow}>
			<${KRow} label="Seed" id="f-seed"><input type="number" class="sn" id="f-seed" min="1" step="1" value=${f.seed} data-tip="the same seed and CODE give the same run" onInput=${(e) => set("seed", e.currentTarget.value)} />
				<button type="button" class="cb" data-tip="1 + the highest seed among the runs of this setup" onClick=${() => set("seed", nextSeed(w))}>New seed</button>
				<label for="f-nseeds">Runs</label><input type="number" class="sn" id="f-nseeds" min="1" max="50" step="1" value=${f.nseeds} data-tip="a run for each seed from this one up (the same setup: a group in the list)" onInput=${(e) => set("nseeds", e.currentTarget.value)} /></${KRow}>
			<${KRow} label=""><label class="opt" data-tip="a recording of each character, to watch the run afterwards on its page (Replay): about 10 MB per fighter per game hour; ~3% slower. A seed that already ran can run again to be recorded."><input type="checkbox" checked=${f.record} onChange=${(e) => set("record", e.currentTarget.checked)} />Record a replay</label></${KRow}>
			<${KAdv} open=${f.adv} sum=${sum} none="as recorded" onToggle=${() => { f.adv = !f.adv; draw(); }} />
			${!f.adv ? null : [field("warmup", "f-warm", "Warm-up", "game time with the characters online before measuring"),
				field("start", "f-start", "Starts", "the world's clock as it boots, UTC (e.g. 2026-10-31T18:00Z): the server's hour, its night, dailies and nightlies follow it"),
				field("wage", "f-wage", "World age", "game time the world runs with no characters first: its monsters level up (0 = a fresh world)"),
				html`<${KRow} label="Ping" id="f-ping"><input type="number" id="f-ping" min="1" max="1000" step="any" value=${f.ping} placeholder=${f.ping0 === "" ? "18" : null} data-tip="ms round trip to the server, as the game's character.ping (3-5 next to it, 50+ a slow connection)" onInput=${(e) => set("ping", e.currentTarget.value)} /></${KRow}>`,
				html`<${KRow} label="Account age" id="f-age"><input type="number" id="f-age" min="0" max="3650" step="any" value=${f.age} placeholder=${f.age0 == null ? "as recorded" : null} data-tip=${"days (0 = a new account; New Player for its first 40)" + (f.age0 != null && f.age0 !== Number(f.age1) ? "; recorded: " + f.age0 + " days" : "")} onInput=${(e) => set("age", e.currentTarget.value)} /></${KRow}>`,
				html`<${KRow} label="Sweep" id="f-sweep"><${Select} id="f-sweep" value=${f.sweep} onChange=${(e) => set("sweep", e.currentTarget.value)}><option value="">none</option>${Object.entries(SWEEPS).map(([k, [, l]]) => html`<option value=${k}>${l}</option>`)}</${Select}>
					<input type="text" class="tag" placeholder=${"values, e.g. " + (f.sweep === "ping" ? "5, 18, 50" : f.sweep === "age" ? "0, 40, 100" : "30m, 1h, 2h")} value=${f.svals} disabled=${!f.sweep} aria-label="Values of the swept setting" onInput=${(e) => set("svals", e.currentTarget.value)} /></${KRow}>`]}
			<section class="nbar">
				<${KRow} label="Name" id="f-tag"><input type="text" class="tag" id="f-tag" maxlength="80" value=${f.tag} onInput=${(e) => set("tag", e.currentTarget.value)} /></${KRow}>
				<div class="fw" role="status" aria-live="polite">${dupe ? html`<${KChip} text="identical to a finished run" cls="bad" tip="This seed already ran to its end with this setup: it would be identical. Pick New seed, or Record a replay to run it again recorded." />` : null}
					${f.err ? html`<${KChip} text=${f.err} cls="bad" />` : !p ? html`<span class="gu">checking...</span>` : warns.map((x) => html`<${KChip} text=${x} cls="warn" />`)}</div>
				<div class="frow"><button type="button" class="go" disabled=${dupe || !!f.busy} data-tip=${p && Array.isArray(p.command) ? p.command.join(" ") + (n > 1 ? " (the first of " + n + ")" : "") : null} onClick=${go}>${n > 1 ? "Start " + n + " runs" : "Start"}</button><span class="gu bn">${n > 1 ? n + " runs: " + batchText(f) : ""}</span></div>
			</section>
		</div>
		<div class="drl" role="status" aria-live="polite">${f.out ? [f.out.length > 1 ? html`<h4>Launches</h4>` : null, f.out.map((r) => html`<div class="rs"><span><i class=${"dot " + dot(r.st)}></i>${r.j.text + ": " + r.st + (r.why ? " (" + r.why + ")" : "")}</span></div>`)] : null}</div>
	</div>`;
}
