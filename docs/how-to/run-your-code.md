# Run your own CODE

Your CODE runs as you would paste it into the game's CODE editor: nothing in it needs to change.

No CODE yet? ChronAL's example bot runs for any class: `chronal new --char Ran1:ranger:40 --char Pri1:priest:40
--run`, or `--code-set example` on any setup ([CODE sets](../reference/library.md#code-sets)); its files in
`codes/example/` are a starting point.

## One file

The quickest way, without writing a setup:

```sh
chronal run --code ~/al/farm.js --class ranger --level 40 --at main:-1175:422 --duration 30m
```

`--farm squigtoad` also gives the CODE `chronal.params.farm` (the spot and monsters), for CODE that reads it.

For anything more (several characters, gear, a party), write a setup: start from `chronal example | grep -v '^\s*//'
> my.json` and point a character's `code` at your file. Paths are relative to the setup file.

```json
{
	"format": "chronal-setup/1",
	"name": "my ranger",
	"run": { "duration": "30m" },
	"characters": [
		{ "name": "Ran1", "class": "ranger", "state": { "level": 40 }, "at": "main:-1175:422", "code": { "file": "farm.js" } }
	]
}
```

## A folder of slots

If your CODE loads other slots (`require_code("utils")`, `load_code("config")`), point `dir` at the folder: every
`*.js` in it is a slot named after its file, as the game names them. `entry` picks the slot a character runs; without
it, the slot named like the character.

```json
"defaults": { "code": { "dir": "../mybot" } },
"characters": [
	{ "name": "Ran1", "class": "ranger", "code": { "entry": "ranger" } },
	{ "name": "Pri1", "class": "priest", "code": { "entry": "priest" } }
]
```

A slot number (`load_code(3)`) doesn't work as is: the sim knows slots by name. Give it a name with `fit.calls`
(`"fit": { "calls": { "3": "utils" } }`).

## A build step

If you build your CODE (a bundler, templating), give the command, and the run builds before it reads the folder:

```json
"code": { "dir": "../mybot/dist", "build": { "cmd": ["node", "build.js"], "cwd": "../mybot" } }
```

`--no-build` skips it (e.g. many runs at once: build once first).

## An older version of your CODE

To compare your CODE with how it was, read it from git: `"git": { "rev": "HEAD~3" }` (or a branch, a tag, a commit)
in the code block runs the files as they were at that commit, built there. On the command line:
`chronal run my.json --code-set dir:../mybot@HEAD~3`, or a set of your sets file at `<set>@<rev>`
([CODE sets](../reference/library.md#code-sets)).

## Edit it on the dashboard, run it again, compare

The dashboard's **CODE** page opens a set's files in the game's own editor. A save checks the syntax, then goes where
the set allows: your folder is written in place; CODE ChronAL keeps (a paste, files, a copy) gets a new version (a
commit: `<set>@<commit>` is the older one); ChronAL's example bot, a pull or others' CODE becomes your copy in the
library. Under the editor, **Runs with this CODE** runs each of them again with what you saved, at its own seed, and
links the new run to **Compare** with the old one.

A run's setup file takes another CODE set the same way: `chronal run live/<id>.setup.json --code-set mine` (or Rerun,
CODE: another set).

## Report what your CODE is doing

The dashboard shows the game's numbers for any CODE. To also see what your CODE is doing (its mode, a status tree, its
role), set a `chronal` object in it:

```js
var chronal = (self.chronal = self.chronal || {});
chronal.mode = () => (character.rip ? "dead" : smart.moving ? "travel" : "farm");
chronal.status = () => ({ target: (get_targeted_monster() || {}).mtype || null });
```

The dashboard then shows time per mode, the status tree, and conditions can read them. On live the object is unused.

If you'd rather not touch your CODE, put this in a separate file and append it in your setups:
`"code": { "dir": "../mybot", "append": ["adapter.js"] }`. [What CODE reports](../reference/reporting.md).

## Give your CODE its spot

`params` arrive in your CODE as `chronal.params` before it runs:

```json
"params": { "farm": { "map": "main", "x": -1175, "y": 422, "monsters": ["squigtoad"] } }
```

If your CODE has its own config, map them in the adapter:
`if (chronal.params && chronal.params.farm) MyConfig.spot = chronal.params.farm;`.

## Check before you run

```sh
chronal run my.json --check
```

lists every problem at once, and warns of slots your CODE asks for (by a literal name, or by a number no `fit.calls`
names) that the setup doesn't give.
