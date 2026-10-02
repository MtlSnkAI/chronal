# The CODE library and fitting others' CODE

The CODE library keeps CODE from elsewhere (someone's published bot, or yours from another folder) in config
`library_dir` (default `library/`, gitignored). Each one is a CODE set named after it, so `chronal run --code-set`,
`chronal new` and the dashboard's New sim take it like any other set.

```sh
chronal library                                                 # the library
chronal library add https://github.com/<owner>/<repo>            # its default branch, pinned to its newest commit
chronal library add https://github.com/<owner>/<repo>/tree/<branch>/src   # a folder at a branch (/blob/...: a file)
chronal library add https://gist.github.com/<user>/<id> --name theirs     # a gist; any git link; a raw file's link
chronal library add ~/al/bot                                    # a folder of this machine, read where it is
chronal library add ~/al/bot --copy                             # ... copied as it is now
chronal library update <name> | remove <name> | revisions <name>
chronal library scan <name>[@<rev>]                             # what that version reaches
chronal library trust <name>[@<rev>] [--yes]                    # trust that version
chronal library fit <name>[@<rev>] [--call K=SLOT|none|auto]... [--with ENTRY=S1+S2|none|auto]...
```

## Adding

- **Links:** a GitHub repo, folder or file (`github.com/...`, `/tree/<ref>/<path>`, `/blob/<ref>/<file>`,
  `/commit/<sha>`, `raw.githubusercontent.com`), a gist, a GitLab-style link (`/-/tree/`, `/-/blob/`), any git URL;
  another link (a raw file, a pastebin) is downloaded. A GitHub repo is named `<owner>-<repo>` unless `--name`.
- **The dashboard** (New sim, CODE, Add CODE) also takes a pasted CODE, files or a folder.
- **The CODE page's copy**: editing CODE that isn't yours to change (ChronAL's example bot, a pull, a link's commit)
  saves a copy as files under a name of yours, keeping who runs which slot (the set's `entries`, `classes`) and what it
  copies (`copy_of`); its next saves are its new versions. A copy of CODE that was yours, or of a trusted version, is
  trusted.
- **A folder of this machine** is read where it is, as `dir:<path>`: not pinned and never asked about (it's yours).

## Pinned versions

Each one (but a local folder) is a git repo in `library/<name>/repo` pinned to one commit (`library/<name>/source.json`).
Runs read its CODE at that commit and record it. `update` fetches it again and pins the newest commit of the branch or
tag it follows (a link to a commit follows none); a paste or files under a name already there are its new version.
`<name>@<rev>` (a branch, tag or commit) runs any other version.

## Trust

The sim runs CODE in its own process with no sandbox: it can do whatever your user can on this machine, and a build
step runs here too. So others' CODE runs, and builds, only at a commit you trusted (`library/trust.json`); each new
commit is asked about again.

A version not trusted yet is shown with what its files reach: network calls (`fetch`, `XMLHttpRequest`, `WebSocket`,
`$.ajax`, `import()`, a script element, a Worker), the servers its files name, code it makes as it runs (`eval`,
`Function`, a timer given text), Node's modules (`require("fs")`), signs of a build step (`package.json`, TypeScript,
a bundler's config: shown, not run), and files it couldn't read. `chronal library scan <name>` prints the same.

Trust it in the New sim form (Trust), with `chronal library trust <name>`, or with `--trust` on `chronal run` and
`chronal new`; on a terminal `chronal run` asks. Otherwise the setup isn't resolved and the run stops (`--check`:
`untrusted: [{ name, commit, web }]`).

## Fitting others' CODE

CODE published as files was written for its author's account: slots they numbered (`load_code(2)`) or named in the
game (`require_code("actions")` of a file `actions.2.js`), helpers kept in another slot and called without loading it,
entries named after their characters, ES modules their own loader imports. ChronAL fits it (a code block's `fit`):

- **Calls:** a `load_code` / `require_code` of a number or a name no slot has loads the slot its files' names give
  (`02_constants.js`, `2_requires.js`, `constants.2.js`: slot 2; `actions.2.js`: named `actions`). One none gives is
  listed: give it a slot, or nothing (`load_code` then does nothing, `require_code` returns `{}`); left so, the run
  fails when the CODE gets there. A slot the CODE computes as it runs (`load_code(cfg.slot)`) can't be fitted.
- **Helpers:** an entry that calls functions it doesn't define (and the game's page doesn't have) runs first the slots
  whose top level defines them (`with: { "Bramble": ["helpers"] }`).
- **Entries:** a character whose slot isn't there runs the slot its file names it by (`Name.6101872310222848.js`),
  else the slot of a character known here of its class (a pull's, a public page's), else one named for its class
  (`priest.js`, `10_priest.js`), else a main one (`main`, `master`, `index`, `start`, `bot`, `run`...), else the one
  using its class's skills most, else the only one; slots another loads are helpers, not entries. `chronal new` says
  which and why (`--missing NAME=SLOT` picks another); the New sim form shows it in its Fit rows.
- **ES modules:** an entry with `import` / `export` runs bundled with what it imports (esbuild: relative imports, and
  `"/x"` from the entry's folder as a loader's server serves them; a package's or a link's import is not bundled, and
  the setup isn't resolved).
- **Names:** then `code_names` maps the names of its author's characters to the run's ([setup](setup.md)).

`source.json` keeps the fit suggested for its commit (`fit_auto`) and the one chosen (`fit`: the form's Fit rows,
`chronal library fit`); a run uses the chosen fit over the suggested one. What the published files lack (a slot never published, the
characters' names in a config) stays the author's to give: a slot, nothing, or code names.

## CODE sets

Every setup's `code` block can be swapped for a named set at run time: `chronal run <setup> --code-set NAME` (its
`extra`, `params`, states and party stay). `chronal code-sets` lists the sets (`--names A,B`: which entry each would
run).

- **Built in:** `example`, ChronAL's example bot (`codes/example/`): `priest` for priests, `merchant` for merchants
  (waits in town with its stand open, casts Merchant's Luck), `fighter` for every other class (farms its spot, rests
  when the storage key `mode` is `"rest"`; with no spot in `params.farm`, the nearest monster it can take on around
  where it starts: no bosses, no training dummies, so place it at its spot with `at`). `chronal new` and New sim use it when there is no template and no pull,
  with the party formed by the sim's invites. A set of your file named `example` replaces it.
- **A sets file** (config `code_sets`; format `chronal-code-sets/1`; paths relative to it):
  `{ "format": "chronal-code-sets/1", "sets": { "<name>": { "note", "pull" | "dir" | "file", "recursive", "entry",
  "entries": { <character>: <slot> }, "classes": { <class> | "*": <slot> }, "prelude", "append", "build", "fit", "git"
  } } }`. The keys are a setup's `code` keys; `pull`: `"latest"`, `"<account>"` or `"<account>/<time>"`: that pull's
  CODE slots, so every character runs its own live slot.
- **A character's entry** in a set: `entries[its name]`, else `classes[its class]`, else `classes["*"]`, else `entry`,
  else the slot named after it.
- **Without a file:** every pull is a set (`pull:latest`, `pull:<account>`, `pull:<account>/<time>`), and any folder or
  file is one (`dir:<path>`, `file:<path>`).
- **The library:** each of its CODE is a set named after it, at its pinned commit, fitted.
- **Revisions:** any set but a pull at a git revision: `<set>@<rev>` (`mine@HEAD~1`, `mine@v1.2`), pinned to its commit
  when read.
- **A character the set has no entry for** stops nothing silently: it is named, and asked about on a terminal (a slot
  of the set, `idle`: in game with no CODE, or `exclude`: out of the run and its party). `--missing
  NAME=SLOT|idle|exclude[,...]` (`*=...` for all) chooses without asking.
- The resolved setup records the set in `source.code_set`.
