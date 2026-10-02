// The CODE page (#/code[/<set>[/<file>]]): a CODE set's files in the game's own editor (CodeMirror, the game's copy
// and look), checked as you save, saved as the set allows (dashboard/code.js: in place, a new version, or your copy);
// then the runs that used it again with the saved version, each compared with its run of before. The library's CODE
// can be removed here (asked again first); a pull's goes with its pull (Accounts).
import { h } from "./vendor/preact.js";
import { useState, useEffect, useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { call, why } from "./lib.js";
import { nav, getData, launchesOf, pollSoon } from "./store.js";
import { Del } from "./accounts.js";

const html = htm.bind(h);
const CM = "cm/5.65.1/";
const codeHash = (set, file) => "#/code/" + encodeURIComponent(set) + (file ? "/" + file.split("/").map(encodeURIComponent).join("/") : "");
const GROUPS = [["yours", "Your sets"], ["others", "Library"], ["pulls", "Live pulls"], ["builtin", "ChronAL's"]];

// the game's CodeMirror, loaded once (its scripts and styles), and the search add-ons of its version (vendor/cm: Ctrl+F
// find, Ctrl+G next, Shift+Ctrl+F replace, Alt+G go to a line)
let cmReady = null;
function loadCm() {
	if (cmReady) return cmReady;
	const css = (href) => document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href }));
	const js = (src) => new Promise((ok, no) => document.head.append(Object.assign(document.createElement("script"), { src, onload: ok, onerror: () => no(new Error("can't load " + src)) })));
	css(CM + "codemirror.css"); css("cm/pixel.css"); css("app/vendor/cm/dialog.css");
	const ADDONS = ["searchcursor", "dialog", "search", "jump-to-line"];
	// (and the pixel font: CodeMirror measures its characters and gutter when it starts)
	return (cmReady = js(CM + "codemirror.js").then(() => js(CM + "javascript.js")).then(() => ADDONS.reduce((p, a) => p.then(() => js("app/vendor/cm/" + a + ".js")), Promise.resolve())).then(() => document.fonts.load("24px pixel").catch(() => {})));
}

export function CodePage({ set, file }) {
	const [sets, setSets] = useState(null), [msg, setMsg] = useState(null);
	const load = () => call("api/code").then((r) => setSets(r.ok ? r.body.sets : { error: why(r) }));
	useEffect(() => void load(), []);
	if (!sets) return html`<div class="page wide"><h2>CODE</h2><p class="mnote">loading...</p></div>`;
	if (sets.error) return html`<div class="page wide"><h2>CODE</h2><p class="nbad">${sets.error}</p></div>`;
	const cur = set || (sets.find((s) => s.group === "yours") || sets[0] || {}).name, cs = sets.find((s) => s.name === cur);
	// the library's removed (its folder; runs keep the CODE they ran)
	const del = async () => {
		const r = await call("api/new/code", "POST", { action: "remove", name: cur });
		setMsg(r.ok ? { text: "Removed " + cur + " from the library" } : { text: why(r), bad: true });
		if (r.ok) (await load(), nav("#/code", true));
	};
	return html`<div class="page wide">
		<div class="frow"><h2>CODE</h2>
			<select aria-label="CODE set" value=${cur || ""} onChange=${(e) => nav(codeHash(e.target.value))}>
				${GROUPS.map(([g, label]) => { const xs = sets.filter((s) => s.group === g); return xs.length ? html`<optgroup label=${label}>${xs.map((s) => html`<option value=${s.name}>${s.name}</option>`)}</optgroup>` : ""; })}
				${cur && !sets.some((s) => s.name === cur) ? html`<option value=${cur}>${cur}</option>` : ""}
			</select>
			<a class="lnk sm" href="#/new" data-tip="New sim: Add CODE (a link, a folder, a paste, files)">Add CODE</a>
			${!cs ? null : cs.group === "others" ? html`<${Del} what="Remove it from the library" go=${del} />` : cs.group === "pulls" ? html`<a class="lnk sm" href="#/accounts" data-tip="a pull's CODE goes with its pull: Accounts, Yours, Remove">Remove with its pull</a>` : cs.group === "yours" ? html`<span class="gu" data-tip="a set of your sets file (config code_sets): remove it there">in your sets file</span>` : null}</div>
		${msg && html`<p class=${msg.bad ? "nbad" : "hint"}>${msg.text}</p>`}
		${cur ? html`<${SetView} key=${cur} set=${cur} file=${file} />` : html`<p class="mnote">No CODE set yet.</p>`}
	</div>`;
}

function SetView({ set, file }) {
	const [info, setInfo] = useState(null);
	const load = () => call("api/code/files?set=" + encodeURIComponent(set)).then((r) => setInfo(r.ok ? r.body : { error: why(r) }));
	useEffect(() => void load(), [set]);
	if (!info) return html`<p class="mnote">loading...</p>`;
	if (info.error) return html`<p class="nbad">${info.error}</p>`;
	const f = file && info.files.some((x) => x.path === file) ? file : (info.files[0] || {}).path;
	return html`<div class="cset">
		<p class="gu"><span class="hash">${info.where}</span>${info.commit ? html` at <span class="hash">${info.commit.slice(0, 7)}</span>` : ""}${info.trusted === false ? html` <span class="nwarn">(not trusted yet)</span>` : ""}: ${info.why}</p>
		<div class="cgrid">
			<nav class="cfiles" aria-label="Files">${info.files.map((x) => html`<a href=${codeHash(set, x.path)} aria-current=${x.path === f ? "page" : null} data-tip=${Math.max(1, Math.round(x.size / 1024)) + " KB"}>${x.path}</a>`)}</nav>
			${f ? html`<${Editor} key=${set + "|" + f} set=${set} file=${f} info=${info} reload=${load} />` : html`<p class="mnote">No file in it.</p>`}
		</div>
	</div>`;
}

// a save's outcome over the move to its copy's page (the copy's editor shows it)
let carried = null;
function Editor({ set, file, info, reload }) {
	const was = carried && carried.set === set && carried.file === file ? carried : null;
	if (was) carried = null;
	const box = useRef(null), cm = useRef(null), saveRef = useRef(null);
	const [state, setState] = useState({ loading: true });
	const [dirty, setDirty] = useState(false);
	const [problems, setProblems] = useState([]);
	const [msg, setMsg] = useState(was ? was.msg : null);
	const [copyName, setCopyName] = useState(set.replace(/^(pull:|dir:|file:)/, "").replace(/[@/].*$/, "").replace(/[^\w.-]+/g, "-") + "-mine");
	const [saved, setSaved] = useState(was ? was.saved : null); // { mode, set, commit } of the last save
	const ro = info.mode === "none";
	useEffect(() => {
		let gone = false;
		Promise.all([loadCm(), call("api/code/file?set=" + encodeURIComponent(set) + "&path=" + encodeURIComponent(file))]).then(([, r]) => {
			if (gone) return;
			if (!r.ok) return setState({ error: why(r) });
			const ed = window.CodeMirror(box.current, { value: r.body.text, mode: /\.json$/.test(file) ? { name: "javascript", json: true } : "javascript", indentUnit: 4, indentWithTabs: true, lineNumbers: true, lineWrapping: true, theme: "pixel", readOnly: ro, extraKeys: { "Ctrl-S": () => saveRef.current(false), "Cmd-S": () => saveRef.current(false), "Alt-G": "jumpToLine" } });
			ed.on("change", () => setDirty(true));
			document.fonts.ready.then(() => !gone && ed.refresh());
			cm.current = ed;
			setState({});
		}, (e) => !gone && setState({ error: e.message }));
		return () => ((gone = true), cm.current && cm.current.getWrapperElement().remove(), (cm.current = null));
	}, [set, file]);
	// a problem's line marked in the editor
	const mark = (ps) => {
		const ed = cm.current;
		if (!ed) return;
		ed.eachLine((l) => ed.removeLineClass(l, "background", "cm-bad"));
		for (const p of ps) ed.addLineClass(Math.max(0, p.line - 1), "background", "cm-bad");
	};
	const check = async () => {
		const r = await call("api/code/file", "POST", { set, path: file, text: cm.current.getValue(), action: "check" });
		const ps = r.ok ? r.body.problems : [];
		setProblems(ps); mark(ps);
		setMsg(r.ok ? { text: ps.length ? "" : "No syntax problem." } : { text: why(r), bad: true });
	};
	async function save(force) {
		if (!cm.current || ro) return;
		setMsg({ text: "saving..." });
		const r = await call("api/code/file", "POST", { set, path: file, text: cm.current.getValue(), action: "save", ...(force ? { force: true } : {}), ...(info.mode === "copy" ? { name: copyName } : {}) });
		const ps = r.body.problems || [];
		setProblems(ps); mark(ps);
		if (r.status === 422) return setMsg({ text: "A syntax problem: not saved.", bad: true, force: true });
		if (!r.ok) return setMsg({ text: why(r), bad: true });
		const s = r.body.saved;
		const m = { text: s.mode === "place" ? "Saved in place." : s.mode === "version" ? "Saved: a new version, " + s.set + " at " + s.commit.slice(0, 7) + "." : "Saved your copy: " + s.set + " (in the library), " + s.commit.slice(0, 7) + ". Its next saves are new versions of it." + (s.trusted ? "" : " Not trusted yet: New sim asks before it runs.") };
		setDirty(false); setSaved(s); setMsg(m);
		if (s.mode === "copy") (carried = { set: s.set, file, msg: m, saved: s }), nav(codeHash(s.set, file));
		else reload();
	}
	saveRef.current = save;
	return html`<div class="ced">
		<div class="frow">
			<b class="hash">${file}</b>${dirty ? html`<span class="gu">unsaved changes</span>` : ""}
			${!ro && info.mode === "copy" && html`<label class="gu">your copy's name <input type="text" class="cpn" value=${copyName} onInput=${(e) => setCopyName(e.target.value)} /></label>`}
			${!ro && html`<button type="button" class="go" disabled=${!!state.loading || !!state.error} onClick=${() => save(false)} data-tip=${info.why + " (Ctrl+S)"}>${info.mode === "copy" ? "Save a copy" : "Save"}</button>`}
			<button type="button" class="cb" disabled=${!!state.loading || !!state.error} onClick=${check}>Check</button>
			<span class="gu" data-tip="in the editor: Ctrl+F find, Ctrl+G and Shift+Ctrl+G the next and previous, Shift+Ctrl+F replace, Shift+Ctrl+R replace all, Alt+G go to a line">Ctrl+F find</span>
			${msg && msg.text && html`<span class=${msg.bad ? "nbad" : "hint"}>${msg.text}</span>`}
			${msg && msg.force && html`<button type="button" class="cb" onClick=${() => save(true)}>Save anyway</button>`}
		</div>
		${problems.length ? html`<ul class="cprob">${problems.map((p) => html`<li><button type="button" class="lnk sm" onClick=${() => { cm.current.setCursor({ line: p.line - 1, ch: p.column }); cm.current.focus(); }}>line ${p.line}:${p.column + 1}</button> ${p.message}</li>`)}</ul>` : ""}
		${state.error ? html`<p class="nbad">${state.error}</p>` : ""}
		<div class="cmbox" ref=${box}></div>
		<${Rerun} set=${saved && saved.mode !== "place" ? saved.set : set} of=${info.copy_of} placed=${(saved ? saved.mode : info.mode) === "place"} fresh=${!!saved} />
	</div>`;
}

// the runs that used the set (a copy: the set it copies too), each again with the CODE as saved (its folder now, or the
// set at its newest version) at its own seed; once a new run has begun, a link to compare it with its run of before
function Rerun({ set, of, placed, fresh }) {
	const [runs, setRuns] = useState(null), [, tick] = useState(0);
	const [went, setWent] = useState({}); // run id -> { key: the launch, error }
	useEffect(() => void Promise.all([set, of].filter(Boolean).map((x) => call("api/code/runs?set=" + encodeURIComponent(x)))).then((rs) => setRuns([...new Set(rs.flatMap((r) => (r.ok ? r.body.runs : [])))])), [set, of]);
	useEffect(() => { const f = () => tick((n) => n + 1); addEventListener("chronal:poll", f); return () => removeEventListener("chronal:poll", f); }, []);
	if (!runs || !runs.length) return html`<p class="gu">${runs ? "No run used it yet." : ""}</p>`;
	const data = getData(), ws = runs.map((id) => data.find((w) => w.id === id)).filter(Boolean).sort((a, b) => (Date.parse(b.started) || 0) - (Date.parse(a.started) || 0)).slice(0, 8);
	const go = async (w) => {
		const r = await call("api/launch", "POST", { of: w.id, ...(placed ? { current_code: true } : { code_set: set }) });
		setWent({ ...went, [w.id]: r.ok || r.status === 202 ? { key: r.body.launch.key } : { error: why(r) } });
		pollSoon();
	};
	return html`<section class="crr">
		<h4>Runs with this CODE</h4>
		<p class="gu">${fresh ? "Run them again with what you saved" : "Run them again with it as it is now"} (${placed ? "the folder as it is" : set + " at its newest version"}), each at its own seed, then compare${of ? " (the runs of " + of + ", which it copies, too)" : ""}.</p>
		${ws.map((w) => {
			const x = went[w.id], l = x && x.key && launchesOf().find((y) => y.key === x.key);
			return html`<div class="frow"><a class="lnk" href=${"#/runs/" + encodeURIComponent(w.id)}>${w.tag || w.id}</a>
				${!x ? html`<button type="button" class="cb" disabled=${!(w.ctl && w.ctl.rerun)} data-tip=${(w.ctl && w.ctl.rerun_why) || "its setup again, this CODE, the same seed"} onClick=${() => go(w)}>Rerun and compare</button>`
					: x.error ? html`<span class="nbad">${x.error}</span>`
					: l && l.run ? html`<a class="cb go" href=${"#/compare?ids=" + encodeURIComponent(w.id) + "," + encodeURIComponent(l.run)}>Compare</a><span class="gu">${l.state}</span>`
					: html`<span class="gu">${l ? l.state + (l.reason ? ": " + l.reason : "") : "starting"}...</span>`}</div>`;
		})}
	</section>`;
}
