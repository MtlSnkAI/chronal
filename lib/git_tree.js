"use strict";
// CODE at a git revision: a setup's `code.git` ({ repo, rev }) reads every path of its code block that lies inside the
// repo (dir, file, append, build.cwd) from the repo's tree at that commit, extracted once (git archive, read-only on
// the repo) into cache/git/<repo name>-<hash>/<commit>/; build hooks run in that copy. Paths outside the repo stay.
const fs = require("node:fs"),
	path = require("node:path"),
	crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const CACHE = path.join(__dirname, "..", "cache", "git");
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).trim();
const inside = (root, p) => {
	const rel = path.relative(root, p);
	return !rel.startsWith("..") && !path.isAbsolute(rel);
};

const repos = new Map();
/** The work tree (top level) of the git repo holding p (its nearest existing ancestor); throws outside one */
function repoOf(p) {
	let d = path.resolve(p);
	while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
	if (!fs.statSync(d).isDirectory()) d = path.dirname(d);
	if (!repos.has(d))
		try {
			repos.set(d, git(d, "rev-parse", "--show-toplevel"));
		} catch (e) {
			throw new Error(`${p} is not in a git repository`);
		}
	return repos.get(d);
}

/** The full commit a revision (sha, branch, tag, HEAD~3) names in repo; throws when it names none */
function commitOf(repo, rev) {
	try {
		return git(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", rev + "^{commit}");
	} catch (e) {
		throw new Error(`no commit "${rev}" in ${repo}`);
	}
}

/** { repo, rev } (repo: any path inside it) -> { repo: its top level, rev, commit } */
function resolve(g) {
	const repo = repoOf(g.repo);
	return { repo, rev: g.rev, commit: commitOf(repo, g.rev) };
}

/** Whether p exists at the commit (inside the repo), else on disk */
function exists(g, p) {
	if (!inside(g.repo, p)) return fs.existsSync(p);
	const rel = path.relative(g.repo, p).split(path.sep).join("/");
	try {
		git(g.repo, "cat-file", "-e", `${g.commit}:${rel}`); // ("<commit>:" is its top)
		return true;
	} catch (e) {
		return false;
	}
}

/** Where a repo's trees go (repo: its top level): <treesOf(repo)>/<commit> */
const treesOf = (repo) => path.join(CACHE, `${path.basename(repo)}-${crypto.createHash("sha1").update(repo).digest("hex").slice(0, 8)}`);

/** The repo's tree at the commit, extracted once: its directory */
function treeOf(g) {
	const dir = path.join(treesOf(g.repo), g.commit);
	if (fs.existsSync(dir)) return dir;
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	// into a folder of its own, then renamed: a tree is whole or absent (a parallel run may win the rename)
	const tmp = `${dir}.${process.pid}.${Date.now()}.tmp`,
		tar = tmp + ".tar";
	try {
		fs.mkdirSync(tmp);
		git(g.repo, "archive", "--format=tar", "-o", tar, g.commit);
		execFileSync("tar", ["-xf", tar, "-C", tmp], { stdio: ["ignore", "ignore", "pipe"] });
		try {
			fs.renameSync(tmp, dir);
		} catch (e) {
			if (!fs.existsSync(dir)) throw e;
		}
	} finally {
		fs.rmSync(tar, { force: true });
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	return dir;
}

/** A code spec (absolute paths) with every path inside its git repo moved into the commit's tree (extracting it) */
function inTree(spec) {
	if (!spec.git) return spec;
	const g = spec.git.commit ? spec.git : resolve(spec.git),
		tree = treeOf(g),
		map = (p) => (p != null && inside(g.repo, p) ? path.join(tree, path.relative(g.repo, p)) : p);
	return {
		...spec, dir: map(spec.dir), file: map(spec.file), append: (spec.append || []).map(map),
		...(spec.build ? { build: { ...spec.build, cwd: map(spec.build.cwd) } } : {}), tree,
	};
}

module.exports = { repoOf, commitOf, resolve, exists, treesOf, treeOf, inTree, inside };
