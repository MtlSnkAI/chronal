"use strict";
// The CODE library (docs/reference/library.md): CODE from elsewhere, each one a CODE set named after it (code_sets.js lists
// them with the others), kept in config library_dir (default library/, gitignored) as <name>/source.json and,
// but for a folder on this machine, <name>/repo, a git repo:
//   - a link to a git host: a GitHub repo, folder or file (github.com/<owner>/<repo>, .../tree/<ref>/<folder>,
//     .../blob/<ref>/<file>, .../commit/<sha>, raw.githubusercontent.com/...), a gist (gist.github.com/..., its raw
//     links), a GitLab-style link (.../-/tree/<ref>/<folder>, .../-/blob/...), any git URL (ssh, https ending in .git,
//     another link git can clone): cloned without a checkout, its branches and tags kept as its own;
//   - another link (a raw file, a pastebin): downloaded into a repo of its own;
//   - pasted text, uploaded files: a repo of their own;
//   - a folder or file on this machine: read where it is, as dir:<path> / file:<path> (not copied, not pinned, no prompt).
// A repo's CODE is pinned to a commit (source.json commit): a run reads it at that commit (git_tree.js) and keeps the
// commit it ran. Update fetches the link again and pins the newest commit of the branch or tag it follows (a link to a
// commit: none); a paste or upload under a name there already is a new commit of it. <name>@<rev>: another revision.
// Trust: others' CODE runs, and builds, only at a commit trusted here (<library_dir>/trust.json). The sim runs CODE in
// its own process with no sandbox (it can do what this machine's user can), a build step on this machine. scan() says what a version reaches (other servers, code it makes as it runs, Node's modules, a build step)
// for the prompt (the New sim form's, chronal run's on a terminal); setup.js resolveSetup refuses CODE of the library at a
// commit not trusted, runBuild its build.
// Fit (fit.js, docs/reference/library.md): an entry's CODE set has a fit, the one suggested for its commit
// (source.json fit_auto: the slots its load_code / require_code calls name, the helpers each entry calls) under the one
// chosen (source.json fit: the form's, chronal library fit).
//   chronal library [list]                               the library
//   chronal library add <link | path> [--name N] [--copy] (--copy: a folder or file of this machine as it is now, copied)
//   chronal library update <name> | remove <name> | revisions <name>
//   chronal library scan <name>[@<rev>]                  what that version reaches
//   chronal library trust <name>[@<rev>] [--yes]         trust that version (asked on a terminal; --yes: without asking)
//   chronal library fit <name>[@<rev>] [--call K=SLOT|none|auto]... [--with ENTRY=S1+S2|none|auto]...
//                                                        what it needs fitted, as fitted (and chosen so)
const fs = require("node:fs"),
	path = require("node:path"),
	os = require("node:os"),
	{ execFile, execFileSync } = require("node:child_process");
const acorn = require("acorn");
const { config } = require("./config");
const GIT = require("./git_tree");
const F = require("./fit");

const FORMAT = "chronal-code-source/1",
	TRUST = "chronal-code-trust/1",
	NAME = /^[A-Za-z0-9][\w.-]{0,39}$/,
	MAX_FILE = 2 << 20, // a downloaded or pasted file
	MAX_FILES = 500, // uploaded
	MAX_BYTES = 8 << 20;
const KINDS = ["github", "gist", "git", "url", "paste", "upload", "path"];
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const dir = () => config().library_dir;
const COMMIT = /^[0-9a-f]{40}$/;

// git on others' repos: never a prompt (a private one fails), no LFS download, none of this user's hooks
const ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" });
// a repo of its own's commits: no user config needed, unsigned, no hooks
const AUTHOR = ["-c", "user.name=the sim", "-c", "user.email=the sim@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
// every branch and tag of the link as the repo's own (a branch moved there moves here)
const MIRROR = ["fetch", "--quiet", "--prune", "--tags", "--update-head-ok", "origin", "+refs/heads/*:refs/heads/*"];
function gitA(cwd, args, timeout = 120e3) {
	return new Promise((resolve, reject) =>
		execFile("git", [...(cwd ? ["-C", cwd] : []), ...args], { encoding: "utf8", env: ENV(), timeout, maxBuffer: 64 << 20 }, (e, out, err) => {
			if (!e) return resolve(out.trim());
			const lines = String(err || "").trim().split("\n").filter(Boolean),
				msg = e.killed ? `no answer in ${timeout / 1e3} s` : lines.find((l) => /^(fatal|error):/.test(l)) || lines.pop() || e.message;
			reject(new Error(msg.replace(/^(fatal|error): /, "")));
		}),
	);
}
const gitS = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: ENV(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).trim();
const tryS = (cwd, ...a) => {
	try {
		return gitS(cwd, ...a);
	} catch (e) {
		return null;
	}
};

// ---- what a link or path names ----

const stripGit = (r) => String(r).replace(/\.git$/, "");
const isSha = (s, min = 7) => new RegExp(`^[0-9a-f]{${min},40}$`, "i").test(String(s || ""));

/**
 * What a link or a path names: { kind (github | gist | git | url | path | probe: git if git can clone it, else a file to
 * download), url (to clone or download), web (to show), path (a path of this machine), at: the segments after a repo's
 * link, a ref then a path in it (split once cloned: the longest that names a branch, tag or commit), or ref (a commit)
 * and sub (a path in it); file: a file named; repo: a name for it }
 */
function sourceOf(text) {
	const s = String(text == null ? "" : text).trim();
	if (!s) throw new Error("a link, or a folder or file on this machine");
	if (/^(\/|~(\/|$))/.test(s)) {
		const p = path.resolve(s.replace(/^~(?=\/|$)/, os.homedir()));
		return { kind: "path", path: p, web: p, repo: path.basename(p).replace(/\.js$/, "") };
	}
	// user@host:path (ssh, as scp writes it)
	if (/^[\w.-]+@[\w.-]+:(?!\/\/)./.test(s)) return { kind: "git", url: s, web: s, repo: stripGit(path.basename(s.split(":").pop())) };
	let u;
	try {
		u = new URL(s);
	} catch (e) {
		throw new Error(`${s}: a link (https://...), or a full path on this machine (/..., ~/...)`);
	}
	const host = u.hostname.toLowerCase().replace(/^www\./, ""),
		parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
	if (host === "github.com") {
		const [o, r0, what, ...rest] = parts;
		if (!o || !r0) throw new Error(`${s}: a repository's link (github.com/<owner>/<repo>[/tree/<branch>/<folder>])`);
		// (named <owner>-<repo>: many repos are called alike)
		const r = stripGit(r0),
			url = `https://github.com/${o}/${r}.git`,
			repo = `${o}-${r}`;
		if (!what) return { kind: "github", url, web: `https://github.com/${o}/${r}`, repo };
		if ((what === "tree" || what === "blob") && rest.length) return { kind: "github", url, web: s, at: rest, file: what === "blob", repo };
		if (what === "commit" && isSha(rest[0])) return { kind: "github", url, web: s, ref: rest[0], repo };
		throw new Error(`${s}: a repository, folder or file of github.com (.../tree/<branch>/<folder>, .../blob/<branch>/<file>)`);
	}
	if (host === "raw.githubusercontent.com") {
		const [o, r, ...rest] = parts,
			at = rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags") ? rest.slice(2) : rest;
		if (!o || !r || at.length < 2) throw new Error(`${s}: a file's raw link (raw.githubusercontent.com/<owner>/<repo>/<branch>/<file>)`);
		return { kind: "github", url: `https://github.com/${o}/${r}.git`, web: s, at, file: true, repo: `${o}-${stripGit(r)}` };
	}
	if (host === "gist.github.com" || host === "gist.githubusercontent.com") {
		const i = parts.findIndex((p) => /^[0-9a-f]{20,40}$/i.test(p));
		if (i < 0) throw new Error(`${s}: a gist's link (gist.github.com/<user>/<id>)`);
		const id = parts[i],
			g = { kind: "gist", url: `https://gist.github.com/${id}.git`, web: `https://gist.github.com/${id}`, repo: "gist-" + id.slice(0, 7) },
			rest = parts.slice(i + 1);
		if (host === "gist.github.com") return { ...g, ...(isSha(rest[0]) ? { ref: rest[0], web: s } : {}) };
		// .../raw[/<commit>]/<file>
		const raw = rest[0] === "raw" ? rest.slice(1) : rest;
		if (!raw.length) return g;
		return { ...g, web: s, file: true, ...(raw.length > 1 && isSha(raw[0], 40) ? { ref: raw[0], sub: raw.slice(1).join("/") } : { sub: raw.join("/") }) };
	}
	// GitLab and the hosts that link as it does: <repo>/-/tree|blob/<ref>/<path>
	const dash = parts.indexOf("-");
	if (dash >= 2 && (parts[dash + 1] === "tree" || parts[dash + 1] === "blob") && parts.length > dash + 2)
		return { kind: "git", url: `${u.protocol}//${u.host}/${parts.slice(0, dash).map(encodeURIComponent).join("/")}.git`, web: s, at: parts.slice(dash + 2), file: parts[dash + 1] === "blob", repo: stripGit(parts[dash - 1]) };
	if (host === "pastebin.com" && parts.length) {
		const id = parts[0] === "raw" ? parts[1] : parts[0];
		if (!/^\w+$/.test(id || "")) throw new Error(`${s}: a paste's link (pastebin.com/<id>)`);
		return { kind: "url", url: `https://pastebin.com/raw/${id}`, web: `https://pastebin.com/${id}`, file: true, repo: "pastebin-" + id };
	}
	if (u.protocol === "ssh:" || u.protocol === "git:" || u.protocol === "file:" || /\.git\/?$/.test(u.pathname)) return { kind: "git", url: s, web: s, repo: stripGit(parts[parts.length - 1] || host) };
	if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${s}: an https link`);
	return { kind: "probe", url: s, web: s, repo: (parts[parts.length - 1] || host).replace(/\.\w+$/, "") };
}

// ---- the library ----

const entryDir = (name) => path.join(dir(), name);
function readMeta(name) {
	try {
		const m = JSON.parse(fs.readFileSync(path.join(entryDir(name), "source.json"), "utf8"));
		return m && m.format === FORMAT && KINDS.includes(m.kind) ? m : null;
	} catch (e) {
		return null;
	}
}
// an entry: { name, meta, dir, repo (null: a path's), broken (why it can't be read) }
function entryOf(name, meta) {
	const repo = meta.kind === "path" ? null : path.join(entryDir(name), "repo"),
		broken = repo && !fs.existsSync(path.join(repo, ".git")) ? `no repo at ${repo}` : meta.kind !== "path" && !COMMIT.test(meta.commit || "") ? "no commit pinned" : null;
	return { name, meta, dir: entryDir(name), repo, broken };
}

/** The library's entries, by name */
function list() {
	let names = [];
	try {
		names = fs.readdirSync(dir(), { withFileTypes: true }).filter((d) => d.isDirectory() && NAME.test(d.name)).map((d) => d.name).sort();
	} catch (e) {}
	const out = [];
	for (const n of names) {
		const meta = readMeta(n);
		if (meta) out.push(entryOf(n, meta));
	}
	return out;
}

/** The entry named so; throws when there's none */
function get(name) {
	if (!NAME.test(String(name))) throw new Error(`${name}: not a name in the library (letters, digits, _ . -)`);
	const meta = readMeta(name);
	if (!meta) throw new Error(`no CODE ${name} in the library (${dir()})`);
	return entryOf(name, meta);
}

/** An entry as a CODE set's definition (code_sets.js setOf): its folder or file, at its pinned commit, fitted (fitDef) */
function setDef(e) {
	const m = e.meta,
		note = m.note || (m.kind === "path" ? null : m.web || m.url || null);
	const where = m.kind === "path" ? m.path : path.join(e.repo, m.sub || ""),
		fit = m.file ? null : fitDef(e);
	return { ...(note ? { note } : {}), [m.file ? "file" : "dir"]: where, ...(m.recursive ? { recursive: true } : {}), ...(m.kind === "path" ? {} : { git: m.commit }), ...(fit ? { fit } : {}), ...(m.entries ? { entries: m.entries } : {}), ...(m.classes ? { classes: m.classes } : {}) };
}

// where an entry comes from, short: "owner/repo", "gist 0123456", a link's host and path, "pasted", "files", a path
function labelOf(m) {
	if (m.kind === "path") return m.path;
	if (m.kind === "paste") return "pasted";
	if (m.kind === "upload") return "files";
	const g = /github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/.exec(m.url || "");
	if (m.kind === "github" && g) return g[1] + "/" + g[2];
	const id = /gist\.github\.com\/([0-9a-f]+)\.git$/i.exec(m.url || "");
	if (m.kind === "gist" && id) return "gist " + id[1].slice(0, 7);
	try {
		const u = new URL(m.kind === "url" ? m.web || m.url : m.url);
		return (u.host + u.pathname).replace(/\.git$/, "").replace(/\/$/, "");
	} catch (e) {
		return m.url || m.web || m.kind;
	}
}
// where to read a version of it in a browser: GitHub's and a gist's page at that commit, else its link
function viewOf(m, commit) {
	const g = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/.exec(m.url || "");
	if (m.kind === "github" && g && commit) return `https://github.com/${g[1]}/${g[2]}/${m.file ? "blob" : "tree"}/${commit}${m.sub ? "/" + m.sub : ""}`;
	const id = /gist\.github\.com\/([0-9a-f]+)\.git$/i.exec(m.url || "");
	if (m.kind === "gist" && id && commit) return `https://gist.github.com/${id[1]}/${commit}`;
	return /^https?:/.test(m.web || "") ? m.web : null;
}

/** What the form shows of an entry: { kind, web, label, view, ref, follows, commit, sub, added_at, fetched_at, trusted,
 *  copy_of } (copy_of: the set it was copied from, the CODE page's copy) */
function info(e) {
	const m = e.meta;
	return {
		kind: m.kind, web: m.web || m.url || m.path || null, label: labelOf(m), view: viewOf(m, m.commit), ref: m.follow ? m.follow.ref : null, follows: m.follow ? m.follow.kind : null, commit: m.commit || null, sub: m.sub || null,
		added_at: m.added_at || null, fetched_at: m.fetched_at || null, trusted: m.commit ? trusted(m.commit) : null, ...(m.copy_of ? { copy_of: m.copy_of } : {}),
	};
}

function writeMeta(d, meta) {
	fs.writeFileSync(path.join(d, "source.json"), JSON.stringify({ format: FORMAT, ...meta }, null, "\t") + "\n");
}

// the commit a ref names in a repo (a branch, a tag, a commit or its prefix), else null
const commitIn = (repo, ref) => tryS(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", ref + "^{commit}");
const refKind = (repo, ref) => (tryS(repo, "show-ref", "--verify", "--quiet", "refs/heads/" + ref) != null ? "branch" : tryS(repo, "show-ref", "--verify", "--quiet", "refs/tags/" + ref) != null ? "tag" : "commit");
// a link's segments after its repo: the longest start that names a branch, tag or commit, the rest a path in it
function splitAt(repo, at) {
	for (let i = at.length; i >= 1; i--) {
		const ref = at.slice(0, i).join("/"),
			commit = commitIn(repo, ref);
		if (commit) return { ref, commit, sub: at.slice(i).join("/") };
	}
	throw new Error(`no branch, tag or commit ${at[0]} in it`);
}
// what a path is at a commit: "tree" | "blob" | "link" | null (none)
function typeAt(repo, commit, sub) {
	if (!sub) return "tree";
	const line = tryS(repo, "ls-tree", commit, "--", sub);
	if (!line) return null;
	const [mode, type] = line.split(/\s+/);
	return mode === "120000" ? "link" : type === "tree" || type === "blob" ? type : null;
}
// a folder's CODE in its subfolders (none of its .js files at its top): read recursive
function recursiveAt(repo, commit, sub) {
	const tree = commit + ":" + (sub || ""),
		top = (tryS(repo, "ls-tree", "--name-only", tree) || "").split("\n");
	if (top.some((n) => n.endsWith(".js"))) return false;
	return (tryS(repo, "ls-tree", "-r", "--name-only", tree) || "").split("\n").some((n) => n.endsWith(".js"));
}
// the folder or file at a commit, as an entry has it: { file, recursive }; throws when it isn't there
function placeAt(repo, commit, sub) {
	const t = typeAt(repo, commit, sub);
	if (t === "link") throw new Error(`${sub} is a symbolic link`);
	if (!t) throw new Error(`no ${sub} at ${commit.slice(0, 7)}`);
	return t === "blob" ? { file: true, recursive: false } : { file: false, recursive: recursiveAt(repo, commit, sub) };
}

async function download(url) {
	let r;
	try {
		r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30e3), headers: { "user-agent": "lib/library.js" } });
	} catch (e) {
		throw new Error(`${url}: ${e.name === "TimeoutError" ? "no answer in 30 s" : e.cause ? e.cause.message || e.message : e.message}`);
	}
	if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
	if (/text\/html/i.test(r.headers.get("content-type") || "")) throw new Error(`${url}: a web page, not a file of CODE (its raw link?)`);
	const buf = Buffer.from(await r.arrayBuffer());
	if (buf.length > MAX_FILE) throw new Error(`${url}: over ${MAX_FILE >> 20} MB`);
	if (buf.includes(0)) throw new Error(`${url}: not text`);
	return buf.toString("utf8");
}

// files to write: [{ path, text }], checked (relative, no .. or .git, at most MAX_FILES and MAX_BYTES); a folder's
// name all share (an upload's) taken off -> { files, folder }
function filesOf(list) {
	if (!Array.isArray(list) || !list.length) throw new Error("files: at least one { path, text }");
	if (list.length > MAX_FILES) throw new Error(`files: ${list.length}, at most ${MAX_FILES}`);
	let bytes = 0;
	const out = list.map((f) => {
		const p = String((f && f.path) || "").replace(/\\/g, "/").replace(/^\.?\/+/, "");
		if (!p || p.split("/").some((x) => !x || x === "." || x === ".." || x.toLowerCase() === ".git" || /[\0<>:"|?*]/.test(x))) throw new Error(`files: ${JSON.stringify(f && f.path)} is not a file's path`);
		if (typeof f.text !== "string") throw new Error(`files: ${p}: its text`);
		bytes += Buffer.byteLength(f.text);
		return { path: p, text: f.text };
	});
	if (bytes > MAX_BYTES) throw new Error(`files: ${Math.round(bytes / 1024)} KB, at most ${MAX_BYTES >> 20} MB`);
	const first = out[0].path.split("/")[0],
		folder = out.length && out.every((f) => f.path.includes("/") && f.path.split("/")[0] === first) ? first : null;
	const files = folder ? out.map((f) => ({ ...f, path: f.path.slice(folder.length + 1) })) : out,
		seen = new Set();
	for (const f of files) {
		if (seen.has(f.path.toLowerCase())) throw new Error(`files: ${f.path} twice`);
		seen.add(f.path.toLowerCase());
	}
	return { files, folder };
}

// a repo of its own with these files as its newest commit (a new one only when they changed) -> the commit
async function writeVersion(repo, files, message) {
	if (!fs.existsSync(path.join(repo, ".git"))) {
		fs.mkdirSync(repo, { recursive: true });
		await gitA(repo, ["init", "--quiet", "--initial-branch=main"]);
	}
	for (const e of fs.readdirSync(repo)) if (e !== ".git") fs.rmSync(path.join(repo, e), { recursive: true, force: true });
	for (const f of files) {
		const p = path.join(repo, f.path);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, f.text);
	}
	await gitA(repo, [...AUTHOR, "add", "--all"]);
	if (await gitA(repo, ["status", "--porcelain"])) await gitA(repo, [...AUTHOR, "commit", "--quiet", "--no-verify", "-m", message]);
	return gitS(repo, "rev-parse", "HEAD");
}

// a free name like base (base, base-2, ...): not the library's, not taken
function freeName(base, taken) {
	const b = String(base || "code").replace(/[^\w.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 34) || "code",
		used = new Set([...taken, ...list().map((e) => e.name)].map((n) => n.toLowerCase()));
	for (let i = 1; ; i++) {
		const n = i === 1 ? b : `${b}-${i}`;
		if (!used.has(n.toLowerCase())) return n;
	}
}

/**
 * Add CODE to the library: from a link or a path (sourceOf; or what it returns), or paste { text, file } (one file, default main.js), or
 * files [{ path, text }] (an upload; a folder all share is its top). name: its name (default: from where it comes);
 * a paste or upload under the name of one there is a new version of it. taken: the other CODE sets' names.
 * -> { entry (list()'s), added: true | false (a new version), commit }
 */
// (copyOf, entries, classes: the CODE page's copy of a set: the set it copies, its characters' and classes' entry slots)
async function add({ from = null, paste = null, files = null, name = null, taken = [], copyOf = null, entries = null, classes = null, now = new Date() } = {}) {
	if ([from, paste, files].filter((x) => x != null).length !== 1) throw new Error("add: a link or path, a paste or files");
	let src;
	if (from != null) src = typeof from === "string" ? sourceOf(from) : { ...from };
	else if (paste != null) {
		const file = String(paste.file || "main.js").trim();
		if (!/^[\w.+-]{1,60}$/.test(file)) throw new Error(`paste: ${JSON.stringify(file)}, a file's name (letters, digits, _ . + -)`);
		if (typeof paste.text !== "string" || !paste.text.trim()) throw new Error("paste: its text");
		if (Buffer.byteLength(paste.text) > MAX_FILE) throw new Error(`paste: over ${MAX_FILE >> 20} MB`);
		src = { kind: "paste", files: [{ path: file, text: paste.text }], file: true, sub: file, repo: "pasted" };
	} else {
		const f = filesOf(files);
		src = { kind: "upload", files: f.files, ...(f.files.length === 1 ? { file: true, sub: f.files[0].path } : {}), repo: f.folder || f.files[0].path.replace(/\.\w+$/, "").split("/").pop() };
	}
	if (src.kind === "probe") {
		try {
			await gitA(null, ["ls-remote", "--quiet", "--", src.url, "HEAD"], 30e3);
			src.kind = "git";
		} catch (e) {
			Object.assign(src, { kind: "url", file: true });
		}
	}
	if (name != null && !NAME.test(String(name))) throw new Error(`name: ${JSON.stringify(name)}, 1-40 letters, digits, _ . - (a letter or digit first)`);
	const lib = dir();
	fs.mkdirSync(lib, { recursive: true });
	// a new version of a paste or upload
	if (name != null && readMeta(name)) {
		const e = get(name);
		if (!((src.kind === "paste" || src.kind === "upload") && e.meta.kind === src.kind)) throw new Error(`a CODE named ${name} is in the library already (Update it, or another name)`);
		if (e.broken) throw new Error(`${name}: ${e.broken}`);
		const commit = await writeVersion(e.repo, src.files, `${src.kind === "paste" ? "pasted" : "uploaded"} ${now.toISOString()}`);
		const meta = { ...e.meta, ...(src.file ? { file: true, sub: src.sub, recursive: false } : { file: false, sub: null, recursive: placeAt(e.repo, commit, "").recursive }), commit, fetched_at: now.toISOString() };
		writeMeta(e.dir, meta);
		return { entry: entryOf(name, meta), added: false, commit };
	}
	if (name != null && taken.some((t) => t.toLowerCase() === String(name).toLowerCase())) throw new Error(`name: a CODE set named ${name} exists`);
	const tmp = path.join(lib, `.add-${process.pid}-${Date.now()}`),
		repo = path.join(tmp, "repo"),
		at = now.toISOString();
	let meta;
	try {
		fs.mkdirSync(tmp);
		if (src.kind === "path") {
			if (!fs.existsSync(src.path)) throw new Error(`no such file or folder ${src.path}`);
			const file = fs.statSync(src.path).isFile();
			let recursive = false;
			if (!file) {
				const top = fs.readdirSync(src.path, { withFileTypes: true });
				recursive = !top.some((d) => d.isFile() && d.name.endsWith(".js")) && top.some((d) => d.isDirectory());
			}
			meta = { name: null, kind: "path", path: src.path, web: src.path, file, recursive, added_at: at };
		} else if (src.kind === "github" || src.kind === "gist" || src.kind === "git") {
			await gitA(null, ["clone", "--no-checkout", "--quiet", "--config", "core.hooksPath=/dev/null", "--", src.url, repo], 300e3).catch((e) => {
				throw new Error(`${src.url}: ${/not found|does not exist|not appear to be a git repository|Authentication|could not read/i.test(e.message) ? "no such repository here, or a private one (" + e.message + ")" : e.message}`);
			});
			await gitA(repo, MIRROR, 300e3);
			let ref, commit, sub;
			if (src.at) ({ ref, commit, sub } = splitAt(repo, src.at));
			else if (src.ref) {
				commit = commitIn(repo, src.ref);
				if (!commit) throw new Error(`no commit ${src.ref} in it`);
				(ref = src.ref), (sub = src.sub || "");
			} else {
				ref = tryS(repo, "symbolic-ref", "--short", "HEAD");
				commit = ref && commitIn(repo, ref);
				if (!commit) throw new Error(`${src.url}: an empty repository`);
				sub = src.sub || "";
			}
			const kind = refKind(repo, ref);
			meta = { name: null, kind: src.kind, url: src.url, web: src.web, follow: { ref: kind === "commit" ? commit : ref, kind }, sub: sub || null, ...placeAt(repo, commit, sub), commit, added_at: at, fetched_at: at };
		} else if (src.kind === "url") {
			const text = await download(src.url),
				base = path.basename(new URL(src.url).pathname).replace(/[^\w.+-]+/g, "_") || "main",
				file = /\.(m|c)?js$/.test(base) ? base : base.replace(/\.\w+$/, "") + ".js";
			const commit = await writeVersion(repo, [{ path: file, text }], `fetched ${src.url}`);
			meta = { name: null, kind: "url", url: src.url, web: src.web, follow: null, sub: file, file: true, recursive: false, commit, added_at: at, fetched_at: at };
		} else {
			const commit = await writeVersion(repo, src.files, `${src.kind === "paste" ? "pasted" : "uploaded"} ${at}`);
			meta = { name: null, kind: src.kind, follow: null, sub: src.file ? src.sub : null, ...(src.file ? { file: true, recursive: false } : placeAt(repo, commit, "")), commit, added_at: at, fetched_at: at, ...(copyOf ? { copy_of: String(copyOf) } : {}), ...(entries && Object.keys(entries).length ? { entries } : {}), ...(classes && Object.keys(classes).length ? { classes } : {}) };
		}
		// (a repo's folder or file: <repo>-<its name>)
		const n = name != null ? String(name) : freeName((src.kind === "github" || src.kind === "gist" || src.kind === "git") && meta.sub ? `${src.repo}-${path.basename(meta.sub).replace(/\.\w+$/, "")}` : src.repo, taken);
		meta.name = n;
		writeMeta(tmp, meta);
		const to = entryDir(n);
		if (fs.existsSync(to)) throw new Error(`a CODE named ${n} is in the library already`);
		fs.renameSync(tmp, to);
		return { entry: entryOf(n, meta), added: true, commit: meta.commit || null };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Fetch an entry's link again: the newest commit of the branch or tag it follows (a downloaded file: downloaded again)
 * pinned. -> { entry, was, commit, moved, count (commits from was), why (nothing to fetch) }
 */
async function update(name, { now = new Date() } = {}) {
	const e = get(name),
		m = e.meta,
		was = m.commit || null,
		same = (why) => ({ entry: e, was, commit: was, moved: false, count: 0, why });
	if (m.kind === "path") return same("read where it is: nothing to fetch");
	if (m.kind === "paste" || m.kind === "upload") return same(`a new version: ${m.kind} it again under the name ${name}`);
	if (e.broken) throw new Error(`${name}: ${e.broken}`);
	let commit;
	if (m.kind === "url") commit = await writeVersion(e.repo, [{ path: m.sub, text: await download(m.url) }], `fetched ${m.url}`);
	else {
		await gitA(e.repo, MIRROR, 300e3);
		if (!m.follow || m.follow.kind === "commit") return same("a link to a commit: nothing newer to follow");
		commit = commitIn(e.repo, m.follow.ref);
		if (!commit) throw new Error(`${name}: no ${m.follow.kind} ${m.follow.ref} in ${m.url} any more`);
	}
	const meta = { ...m, ...(m.kind === "url" ? {} : placeAt(e.repo, commit, m.sub || "")), commit, fetched_at: now.toISOString() };
	writeMeta(e.dir, meta);
	const count = was && commit !== was ? Number(tryS(e.repo, "rev-list", "--count", `${was}..${commit}`)) || 0 : 0;
	return { entry: entryOf(name, meta), was, commit, moved: commit !== was, count };
}

/** Take an entry out of the library (its folder; a pasted or uploaded one's CODE goes with it) */
function remove(name) {
	const e = get(name);
	fs.rmSync(e.dir, { recursive: true, force: true });
	return e;
}

/** A git repo's revisions to pick from: { branches, tags: [{ name, commit, date }], commits: [{ commit, date, subject }]
 * (the newest of head's) } */
function revisionsIn(repo, head = "HEAD") {
	const refs = (kind) =>
		(tryS(repo, "for-each-ref", "--sort=-committerdate", "--count=50", "--format=%(refname:short)%09%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%09%(committerdate:iso-strict)%(*committerdate:iso-strict)", "refs/" + kind) || "")
			.split("\n").filter(Boolean).map((l) => {
				const [n, commit, date] = l.split("\t");
				return { name: n, commit, date: date || null };
			});
	const commits = (tryS(repo, "log", "--max-count=30", "--format=%H%x09%cI%x09%s", head, "--") || "").split("\n").filter(Boolean).map((l) => {
		const [commit, date, ...s] = l.split("\t");
		return { commit, date, subject: s.join("\t") };
	});
	return { branches: refs("heads"), tags: refs("tags"), commits };
}
/** An entry's revisions (revisionsIn: of the branch or tag it follows) */
function revisions(name) {
	const e = get(name);
	if (!e.repo || e.broken) return { branches: [], tags: [], commits: [] };
	return revisionsIn(e.repo, e.meta.follow && e.meta.follow.kind !== "commit" ? e.meta.follow.ref : e.meta.commit);
}
/** The commit a revision names in an entry's repo, else null */
function revOf(name, rev) {
	const e = get(name);
	return e.repo && !e.broken ? commitIn(e.repo, String(rev)) : null;
}

// ---- fitting (fit.js) ----

// an entry's folder of slots at a commit (default its pinned one; a path's: as it is) -> { dir, recursive, commit }
function codeAt(e, rev = null) {
	const m = e.meta;
	if (m.kind === "path") return { dir: m.path, recursive: !!m.recursive, commit: null };
	if (e.broken) throw new Error(`${e.name}: ${e.broken}`);
	const commit = rev == null ? m.commit : COMMIT.test(rev) ? rev : commitIn(e.repo, rev);
	if (!commit) throw new Error(`${e.name}: no revision ${rev}`);
	const tree = GIT.treeOf({ repo: GIT.repoOf(e.repo), commit });
	return { dir: path.join(tree, m.sub || ""), recursive: !!(rev == null ? m.recursive : placeAt(e.repo, commit, m.sub || "").recursive), commit };
}
// fit.js suggest()'s fit, as a code block's: { calls: { <key>: <slot> } (the ones a file's name gives), with }
const fitFrom = (s) => ({ calls: Object.fromEntries(s.calls.filter((x) => x.to !== undefined).map((x) => [x.key, x.to])), with: Object.fromEntries(s.with.map((x) => [x.entry, x.slots])) });
// the chosen over the suggested; a with chosen empty: none
function merged(auto, chosen = {}) {
	const calls = { ...auto.calls, ...(chosen.calls || {}) },
		w = Object.fromEntries(Object.entries({ ...auto.with, ...(chosen.with || {}) }).filter(([, v]) => v.length));
	return Object.keys(calls).length || Object.keys(w).length ? { ...(Object.keys(calls).length ? { calls } : {}), ...(Object.keys(w).length ? { with: w } : {}) } : null;
}
/**
 * An entry's fit at a commit (default its pinned one), as its code block has it: the one suggested there (kept in
 * source.json fit_auto for the pinned commit) under the chosen, or null when there's nothing to fit
 */
function fitDef(e, rev = null) {
	const m = e.meta;
	if (m.file) return null;
	let auto;
	if (rev == null && m.kind !== "path" && m.fit_auto && m.fit_auto.commit === m.commit) auto = m.fit_auto;
	else {
		const at = codeAt(e, rev);
		auto = { commit: at.commit, ...fitFrom(F.suggest(F.slotsOf(at), {})) };
		if (rev == null && m.kind !== "path") writeMeta(e.dir, (e.meta = { ...m, fit_auto: auto }));
	}
	return merged(auto, m.fit || {});
}
/**
 * What an entry's CODE needs fitted at a commit (default its pinned one): fit.js suggest() with the chosen (source.json
 * fit) -> { commit, slots: [names], ...suggest()'s (loaded as a list) }
 */
function fitInfo(name, rev = null) {
	const e = get(name),
		at = codeAt(e, rev),
		slots = F.slotsOf(at),
		s = F.suggest(slots, e.meta.fit || {});
	return { commit: at.commit, slots: slots.map((x) => x.slot), ...s, loaded: [...s.loaded] };
}
/**
 * Choose an entry's fit (source.json fit): calls { <key>: <slot> | null (none) | undefined (as suggested) }, with
 * { <entry slot>: [<slot>, ...] ([]: none) | undefined (as suggested) }; each slot one of its CODE's. -> the entry
 */
function setFit(name, { calls = {}, with: w = {} } = {}) {
	const e = get(name);
	if (e.meta.file) throw new Error(`${name}: one file, nothing to fit`);
	const slots = F.slotsOf(codeAt(e)).map((x) => x.slot),
		has = (s) => slots.some((x) => x.toLowerCase() === String(s).toLowerCase());
	const fit = { calls: { ...((e.meta.fit && e.meta.fit.calls) || {}) }, with: { ...((e.meta.fit && e.meta.fit.with) || {}) } };
	for (const [k, v] of Object.entries(calls)) {
		if (!/^[^\0]{1,100}$/.test(k)) throw new Error(`fit: ${JSON.stringify(k)}, a slot's number or name`);
		if (v === undefined) delete fit.calls[k];
		else if (v === null || has(v)) fit.calls[k] = v;
		else throw new Error(`fit: ${k} -> ${v}: no slot ${v} in ${name}`);
	}
	for (const [k, v] of Object.entries(w)) {
		if (!has(k)) throw new Error(`fit: no slot ${k} in ${name}`);
		if (v === undefined) delete fit.with[k];
		else if (Array.isArray(v) && v.every(has)) fit.with[k] = [...v];
		else throw new Error(`fit: ${k} runs first ${JSON.stringify(v)}: slots of ${name}`);
	}
	const meta = { ...e.meta, fit: { ...(Object.keys(fit.calls).length ? { calls: fit.calls } : {}), ...(Object.keys(fit.with).length ? { with: fit.with } : {}) } };
	if (!Object.keys(meta.fit).length) delete meta.fit;
	writeMeta(e.dir, meta);
	return entryOf(name, meta);
}

// ---- what a version reaches ----

const NET_NEW = new Set(["XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "RTCPeerConnection"]),
	JQ = new Set(["ajax", "get", "post", "getJSON", "getScript"]),
	GLOBALS = new Set(["window", "self", "globalThis", "parent", "top"]),
	NODE = new Set(["child_process", "fs", "fs/promises", "net", "http", "https", "http2", "tls", "dgram", "dns", "os", "worker_threads", "vm", "cluster", "inspector", "module", "process"]),
	HOST = /\b(?:https?|wss?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+|localhost)\b/gi,
	OPTS = { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true };
const isNode = (v) => v != null && typeof v === "object" && typeof v.type === "string";
const strOf = (n) => (n && n.type === "Literal" && typeof n.value === "string" ? n.value : n && n.type === "TemplateLiteral" && !n.expressions.length ? n.quasis[0].value.cooked : null);
const nameOf = (n) => (!n ? null : n.type === "Identifier" ? n.name : n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier" ? n.property.name : null);

// what one CODE text reaches: into the maps of out (what -> { what, n, at }), its servers' names into out.hosts
function reachesIn(text, where, out) {
	let ast;
	try {
		ast = acorn.parse(text, OPTS);
	} catch (e) {
		try {
			ast = acorn.parse(text, { ...OPTS, sourceType: "module" });
		} catch (x) {
			return out.unread.push(`${where}: ${e.message}`);
		}
	}
	const add = (m, what, n) => {
		const x = m.get(what) || m.set(what, { what, n: 0, at: [] }).get(what);
		x.n++;
		if (x.at.length < 3) x.at.push(`${where}:${n.loc.start.line}`);
	};
	const hosts = (s) => {
		for (const [, h] of String(s).matchAll(HOST)) out.hosts.set(h.toLowerCase(), (out.hosts.get(h.toLowerCase()) || 0) + 1);
	};
	const stack = [ast];
	while (stack.length) {
		const n = stack.pop();
		if (n.type === "CallExpression") {
			const fn = nameOf(n.callee),
				obj = n.callee.type === "MemberExpression" ? n.callee.object : null,
				on = nameOf(obj),
				a0 = strOf(n.arguments[0]),
				global = !obj || GLOBALS.has(on);
			if (fn === "fetch" && global) add(out.network, "fetch", n);
			else if (fn === "importScripts" && global) add(out.network, "importScripts", n);
			else if (fn === "sendBeacon") add(out.network, "sendBeacon", n);
			else if (obj && (on === "$" || on === "jQuery") && JQ.has(fn)) add(out.network, "$." + fn, n);
			else if (fn === "io" && global && a0 && /^(https?|wss?):/i.test(a0)) add(out.network, "socket.io", n);
			else if (fn === "createElement" && a0 && /^(script|iframe)$/i.test(a0)) add(out.network, `a <${a0.toLowerCase()}> element`, n);
			else if (fn === "eval" && global) add(out.code, "eval", n);
			else if (fn === "Function" && !obj) add(out.code, "Function", n);
			else if ((fn === "setTimeout" || fn === "setInterval") && global && a0 != null) add(out.code, fn + " of a string", n);
			else if (fn === "require" && !obj && a0 && NODE.has(a0.replace(/^node:/, ""))) add(out.node, `require("${a0}")`, n);
		} else if (n.type === "NewExpression") {
			const c = nameOf(n.callee);
			if (NET_NEW.has(c)) add(out.network, c, n);
			else if (c === "Function") add(out.code, "Function", n);
		} else if (n.type === "ImportExpression") add(out.network, "import()", n);
		else if (n.type === "ImportDeclaration" && typeof n.source.value === "string") {
			if (/^(https?):/i.test(n.source.value)) add(out.network, "import from a link", n);
			else if (NODE.has(n.source.value.replace(/^node:/, ""))) add(out.node, `import "${n.source.value}"`, n);
		} else if (n.type === "Literal" && typeof n.value === "string") hosts(n.value);
		else if (n.type === "TemplateElement") hosts(n.value.cooked ?? n.value.raw);
		for (const k of Object.keys(n)) {
			if (k === "loc") continue;
			const v = n[k];
			if (Array.isArray(v)) {
				for (let i = v.length - 1; i >= 0; i--) if (isNode(v[i])) stack.push(v[i]);
			} else if (isNode(v)) stack.push(v);
		}
	}
}

/**
 * What CODE reaches, from its files (a folder, its subfolders too, or a file; .git and node_modules left out); root:
 * its repo's top, for the signs of a build step there. -> { files, js, bytes, network, code (code it makes as it runs),
 * node (Node's modules: this machine's): [{ what, n, at: ["file:line"] }], hosts: [{ host, n }], build: [what tells of
 * a build step], unread: [a file not parsed: why] }
 */
function scan(where, { root = null } = {}) {
	const out = { files: 0, js: 0, bytes: 0, network: new Map(), code: new Map(), node: new Map(), hosts: new Map(), build: [], unread: [] },
		files = [];
	const walk = (d, rel) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (e.name === ".git" || e.name === "node_modules" || files.length >= 5000) continue;
			const p = path.join(d, e.name),
				r = rel ? rel + "/" + e.name : e.name;
			if (e.isDirectory()) walk(p, r);
			else if (e.isFile()) files.push([p, r]);
		}
	};
	if (fs.statSync(where).isDirectory()) walk(where, "");
	else files.push([where, path.basename(where)]);
	let ts = 0;
	for (const [p, r] of files) {
		const size = fs.statSync(p).size;
		out.files++;
		out.bytes += size;
		if (/\.tsx?$/.test(r)) ts++;
		if (!/\.(m|c)?js$/.test(r)) continue;
		out.js++;
		if (size > MAX_FILE) out.unread.push(`${r}: over ${MAX_FILE >> 20} MB`);
		else reachesIn(fs.readFileSync(p, "utf8"), r, out);
	}
	// a build step: a package's scripts, TypeScript, a bundler's config (at the repo's top or among the files)
	const tops = new Set([...(root && fs.existsSync(root) ? fs.readdirSync(root) : []), ...files.map(([, r]) => r)]);
	const pkg = [root && path.join(root, "package.json"), ...files.filter(([, r]) => r === "package.json").map(([p]) => p)].find((f) => f && fs.existsSync(f));
	if (pkg) {
		let j = null;
		try {
			j = JSON.parse(fs.readFileSync(pkg, "utf8"));
		} catch (e) {}
		const scripts = j && isObj(j.scripts) ? Object.keys(j.scripts) : [],
			deps = j ? Object.keys({ ...(j.dependencies || {}), ...(j.devDependencies || {}) }).length : 0;
		out.build.push(`package.json${scripts.length ? ": scripts " + scripts.slice(0, 6).join(", ") : ""}${deps ? `${scripts.length ? "," : ":"} ${deps} ${deps === 1 ? "dependency" : "dependencies"}` : ""}`);
	}
	if (ts || tops.has("tsconfig.json")) out.build.push(`TypeScript${ts ? `: ${ts} .ts files` : ""}`);
	for (const f of tops) if (/^(webpack|rollup|vite|esbuild|gulpfile|Gruntfile)\b.*\.(js|ts|mjs|cjs)$/.test(f) || f === "Makefile") out.build.push(f);
	const sorted = (m) => [...m.values()].sort((a, b) => b.n - a.n || (a.what < b.what ? -1 : 1));
	return { ...out, network: sorted(out.network), code: sorted(out.code), node: sorted(out.node), hosts: [...out.hosts].map(([host, n]) => ({ host, n })).sort((a, b) => b.n - a.n || (a.host < b.host ? -1 : 1)), build: [...new Set(out.build)] };
}

const scans = new Map();
/** What an entry's CODE reaches at a commit (default its pinned one; a rev: resolved): scan() plus its commit, once per commit */
function scanOf(name, rev = null) {
	const e = get(name),
		m = e.meta;
	if (m.kind === "path") return { commit: null, ...scan(m.path) };
	if (e.broken) throw new Error(`${name}: ${e.broken}`);
	const commit = rev == null ? m.commit : COMMIT.test(rev) ? rev : commitIn(e.repo, rev);
	if (!commit) throw new Error(`${name}: no revision ${rev}`);
	const key = `${e.repo}@${commit}:${m.sub || ""}`;
	if (!scans.has(key)) {
		const tree = GIT.treeOf({ repo: GIT.repoOf(e.repo), commit });
		scans.set(key, { commit, ...scan(path.join(tree, m.sub || ""), { root: tree }) });
	}
	return scans.get(key);
}

/** A scan's lines, for a terminal */
function scanLines(s) {
	const what = (xs) => xs.map((x) => `${x.what}${x.n > 1 ? " x" + x.n : ""} (${x.at.join(", ")}${x.n > x.at.length ? ", ..." : ""})`).join("; ");
	return [
		`${s.js} JS files${s.files > s.js ? ` (${s.files} files)` : ""}, ${Math.max(1, Math.round(s.bytes / 1024))} KB`,
		s.network.length ? `reaches other servers: ${what(s.network)}` : "no network calls found",
		...(s.hosts.length ? [`names servers: ${s.hosts.map((h) => h.host).join(", ")}`] : []),
		...(s.code.length ? [`makes code as it runs: ${what(s.code)}`] : []),
		...(s.node.length ? [`Node's modules (this machine's): ${what(s.node)}`] : []),
		...(s.build.length ? [`a build step: ${s.build.join("; ")} (not run here: its files run as they are, an ES module entry bundled)`] : []),
		...(s.unread.length ? [`not read: ${s.unread.join("; ")}`] : []),
	];
}

// ---- trust ----

const trustFile = () => path.join(dir(), "trust.json");
function trusts() {
	try {
		const t = JSON.parse(fs.readFileSync(trustFile(), "utf8"));
		return t && t.format === TRUST && isObj(t.commits) ? t.commits : {};
	} catch (e) {
		return {};
	}
}
/** Whether that commit's CODE is trusted here */
const trusted = (commit) => !!commit && Object.hasOwn(trusts(), commit);
/** Trust a commit's CODE (name, source: what it was, for the record; by: who asked) */
function trust(commit, { name = null, source = null, by = null, now = new Date() } = {}) {
	if (!COMMIT.test(String(commit))) throw new Error(`trust: ${commit} is not a commit`);
	const commits = { ...trusts(), [commit]: { name, source, at: now.toISOString(), by } },
		f = trustFile(),
		tmp = `${f}.${process.pid}.tmp`;
	fs.mkdirSync(dir(), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify({ format: TRUST, commits }, null, "\t") + "\n");
	fs.renameSync(tmp, f);
}

// the library's entry a code spec reads (its git repo, dir or file inside library_dir), else null
function specEntry(spec) {
	const lib = path.resolve(dir()),
		real = fs.existsSync(lib) ? fs.realpathSync(lib) : lib;
	for (const p of [spec.git && spec.git.repo, spec.dir, spec.file]) {
		if (!p) continue;
		const a = path.resolve(p);
		for (const base of new Set([lib, real]))
			if (a !== base && GIT.inside(base, a)) {
				const name = path.relative(base, a).split(path.sep)[0];
				return NAME.test(name) ? name : null;
			}
	}
	return null;
}
const commitOfGit = (g) => (g.commit ? g.commit : COMMIT.test(g.rev || "") ? g.rev : (() => {
	try {
		return GIT.resolve(g).commit;
	} catch (e) {
		return null;
	}
})());

/**
 * The library's CODE among these code specs ([[who, spec]]; spec.git: { repo, rev[, commit] }) at a commit not trusted
 * here: [{ name, commit, kind, web, label, view (to read that version), who: [...] }]; commit null: read off its repo,
 * not at a commit (refused too)
 */
function untrusted(list) {
	const t = trusts(),
		out = new Map();
	for (const [who, spec] of list) {
		const name = spec && specEntry(spec);
		if (!name) continue;
		const commit = spec.git ? commitOfGit(spec.git) : null;
		if (commit && Object.hasOwn(t, commit)) continue;
		const meta = readMeta(name),
			k = commit || "-" + name;
		const x = out.get(k) || out.set(k, { name, commit, kind: meta ? meta.kind : null, web: meta ? meta.web || meta.url || null : null, label: meta ? labelOf(meta) : name, view: meta ? viewOf(meta, commit) : null, who: [] }).get(k);
		if (!x.who.includes(who)) x.who.push(who);
	}
	return [...out.values()];
}
/** One of untrusted()'s, as a problem */
function untrustedText(u) {
	if (!u.commit) return `${u.who.join(", ")}: CODE ${u.name} of the library is read at a commit (code.git, or the CODE set ${u.name}), not off its repo`;
	return `CODE ${u.name} at ${u.commit.slice(0, 7)}${u.web ? ` (${u.web})` : ""}, for ${u.who.join(", ")}: not trusted here yet. Others' CODE runs at a version you trusted: the New sim form asks, or chronal library trust ${u.name}@${u.commit.slice(0, 7)}`;
}

/** Why a build in cwd may not run (the library's CODE at a commit not trusted here), else null */
function buildBlock(cwd) {
	const a = path.resolve(cwd);
	if (GIT.inside(path.resolve(dir()), a)) return `a build of the library's CODE runs in its commit's tree, not in ${a}`;
	for (const e of list()) {
		if (!e.repo || e.broken) continue;
		let trees;
		try {
			trees = GIT.treesOf(GIT.repoOf(e.repo));
		} catch (x) {
			continue;
		}
		if (!GIT.inside(trees, a) || a === trees) continue;
		const commit = path.relative(trees, a).split(path.sep)[0];
		return trusted(commit) ? null : `the build of CODE ${e.name} at ${commit.slice(0, 7)}: not run, its CODE is not trusted here yet`;
	}
	return null;
}

// what the prompt says of others' CODE: where it would run
const RISK = "chronal run runs it in its own process on this machine, with no sandbox: it can do what you can here.";

/**
 * Ask on a terminal whether to trust each of untrusted()'s (its source, commit and scan shown); the ones answered yes
 * are trusted (by: who asks). -> whether all of them are trusted now
 */
async function ask(list, { by = null } = {}) {
	const rl = require("node:readline/promises").createInterface({ input: process.stdin, output: process.stdout });
	let all = true;
	try {
		for (const u of list) {
			console.log(`\nOthers' CODE: ${u.name} at ${u.commit.slice(0, 7)}${u.web ? ` (${u.web})` : ""}, for ${u.who.join(", ")}`);
			try {
				for (const l of scanLines(scanOf(u.name, u.commit))) console.log("  " + l);
			} catch (e) {
				console.log(`  not read: ${e.message}`);
			}
			console.log(`  ${RISK}`);
			const a = (await rl.question(`  Trust ${u.name} at ${u.commit.slice(0, 7)}? [y/N] `)).trim().toLowerCase();
			if (a === "y" || a === "yes") trust(u.commit, { name: u.name, source: u.web, by });
			else all = false;
		}
	} finally {
		rl.close();
	}
	return all;
}

module.exports = { cli, FORMAT, NAME, RISK, dir, sourceOf, list, get, setDef, info, add, update, remove, revisions, revisionsIn, revOf, fitDef, fitInfo, setFit, specEntry, scan, scanOf, scanLines, trusted, trust, untrusted, untrustedText, buildBlock, ask };

// (the exports first: the CLI's add reads code_sets.js, which reads this module)
function cli(argv) {
	return (async () => {
		const flag = (f) => (argv.includes(f) ? (argv.splice(argv.indexOf(f), 1), true) : false),
			opt = (f) => {
				const i = argv.indexOf(f);
				if (i < 0) return null;
				const v = argv[i + 1];
				argv.splice(i, 2);
				return v;
			};
		const many = (f) => {
			const out = [];
			for (let v; (v = opt(f)) != null; ) out.push(v);
			return out;
		};
		const calls = many("--call"),
			withs = many("--with"),
			name = opt("--name"),
			copy = flag("--copy"),
			yes = flag("--yes"),
			[cmd = "list", arg] = argv,
			at = (s) => {
				const i = String(s || "").indexOf("@");
				return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, null];
			};
		const where = (e) => (e.meta.kind === "path" ? e.meta.path : `${e.meta.web || e.meta.url || { paste: "pasted", upload: "uploaded" }[e.meta.kind]}${e.meta.sub ? ` (${e.meta.sub})` : ""}`);
		if (cmd === "--help" || cmd === "help") {
			// the usage: this file's header lines that start with "//   chronal library"
			const head = fs.readFileSync(__filename, "utf8").split("\n").filter((l) => /^\/\/ {3}( {4,}|chronal library)/.test(l));
			return console.log("usage:\n" + head.map((l) => l.slice(5)).join("\n") + "\n(docs/reference/library.md)");
		}
		if (cmd === "list") {
			const es = list();
			console.log(`the CODE library (${dir()}): ${es.length ? "" : "empty: chronal library add <link | path>"}`);
			for (const e of es)
				console.log(`  ${e.name.padEnd(20)} ${e.meta.kind.padEnd(6)} ${e.meta.commit ? e.meta.commit.slice(0, 7) + (e.meta.follow && e.meta.follow.kind !== "commit" ? ` (${e.meta.follow.ref})` : "") + (trusted(e.meta.commit) ? "" : ", not trusted") : "as it is"}  ${where(e)}${e.broken ? `  BROKEN: ${e.broken}` : ""}`);
		} else if (cmd === "add") {
			if (!arg) throw new Error("add <link | path> [--name N] [--copy]");
			const taken = require("./code_sets").loadCodeSets().sets.filter((s) => !s.lib).map((s) => s.name);
			let r;
			if (copy) {
				const p = path.resolve(arg.replace(/^~(?=\/|$)/, os.homedir())),
					files = [];
				const walk = (d, rel) => {
					for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.name !== ".git" && e.name !== "node_modules") e.isDirectory() ? walk(path.join(d, e.name), rel + e.name + "/") : e.isFile() && files.push({ path: rel + e.name, text: fs.readFileSync(path.join(d, e.name), "utf8") });
				};
				if (fs.statSync(p).isFile()) files.push({ path: path.basename(p), text: fs.readFileSync(p, "utf8") });
				else walk(p, path.basename(p) + "/");
				r = await add({ files, name: name ?? path.basename(p).replace(/\.js$/, ""), taken });
			} else r = await add({ from: arg, name, taken });
			console.log(`${r.added ? "added" : "a new version of"} ${r.entry.name}: ${where(r.entry)}${r.commit ? ` at ${r.commit.slice(0, 7)}` : ""} (CODE set ${r.entry.name})`);
			if (r.commit && !trusted(r.commit)) console.log(`  not trusted yet: chronal library trust ${r.entry.name} (or the New sim form asks)`);
		} else if (cmd === "update") {
			const r = await update(arg);
			console.log(r.why ? `${arg}: ${r.why}` : r.moved ? `${arg}: ${r.was ? r.was.slice(0, 7) : "?"} -> ${r.commit.slice(0, 7)} (${r.count} commits)` : `${arg}: up to date at ${r.commit.slice(0, 7)}`);
		} else if (cmd === "remove") console.log(`removed ${remove(arg).name}`);
		else if (cmd === "revisions") {
			const r = revisions(arg);
			for (const [k, xs] of [["branches", r.branches], ["tags", r.tags]]) if (xs.length) console.log(`${k}: ${xs.map((x) => x.name).join(", ")}`);
			for (const c of r.commits) console.log(`  ${c.commit.slice(0, 7)} ${c.date.slice(0, 10)} ${c.subject}`);
		} else if (cmd === "scan" || cmd === "trust") {
			const [n, rev] = at(arg),
				s = scanOf(n, rev),
				e = get(n);
			console.log(`${n}${s.commit ? " at " + s.commit.slice(0, 7) : ""}: ${where(e)}${s.commit ? (trusted(s.commit) ? ", trusted" : ", not trusted") : ", read where it is (no trust needed)"}`);
			for (const l of scanLines(s)) console.log("  " + l);
			if (cmd === "trust" && s.commit && !trusted(s.commit)) {
				if (yes) trust(s.commit, { name: n, source: e.meta.web || e.meta.url, by: "library.js --yes" }), console.log(`trusted ${n} at ${s.commit.slice(0, 7)}`);
				else if (process.stdin.isTTY && process.stdout.isTTY) await ask([{ name: n, commit: s.commit, web: e.meta.web || e.meta.url, who: ["the runs"] }], { by: "library.js" });
				else throw new Error("trust: on a terminal it asks; --yes trusts without asking");
			}
		} else if (cmd === "fit") {
			const [n, rev] = at(arg),
				pair = (x, f) => {
					const i = x.indexOf("=");
					if (i < 1) throw new Error(`${f} ${x}: KEY=VALUE`);
					return [x.slice(0, i), x.slice(i + 1)];
				};
			if (calls.length || withs.length) {
				if (rev) throw new Error("fit: the pinned version's (no @<rev>) is chosen");
				setFit(n, {
					calls: Object.fromEntries(calls.map((x) => pair(x, "--call")).map(([k, v]) => [k, v === "auto" ? undefined : v === "none" ? null : v])),
					with: Object.fromEntries(withs.map((x) => pair(x, "--with")).map(([k, v]) => [k, v === "auto" ? undefined : v === "none" ? [] : v.split("+")])),
				});
			}
			const f = fitInfo(n, rev);
			console.log(`${n}${f.commit ? " at " + f.commit.slice(0, 7) : ""}: ${f.slots.length} slots`);
			for (const c of f.calls) console.log(`  ${c.fn}(${c.number ? c.key : JSON.stringify(c.key)}) -> ${c.to === undefined ? `? ${c.why}: --call ${c.key}=SLOT|none` : c.to === null ? "none" : c.to} ${c.to === undefined ? "" : `(${c.why}) `}[${c.where.slice(0, 3).join(", ")}${c.where.length > 3 ? ", ..." : ""}]`);
			for (const d of f.dynamic) console.log(`  ${d.where}:${d.line} ${d.text}: its slot is built as it runs (not fitted)`);
			for (const w of f.with) console.log(`  ${w.entry} runs first: ${w.slots.join(", ") || "nothing"} (${w.why})`);
			if (f.modules.length) console.log(`  ES modules (bundled when an entry): ${f.modules.join(", ")}`);
			for (const x of f.errors) console.log(`  not read: ${x}`);
			if (!f.calls.length && !f.dynamic.length && !f.with.length && !f.modules.length) console.log("  nothing to fit");
		} else throw new Error(`${cmd}: list, add, update, remove, revisions, scan, trust or fit`);
	})().catch((e) => {
		console.error(`chronal library: ${e.message}`);
		process.exit(2);
	});
}
