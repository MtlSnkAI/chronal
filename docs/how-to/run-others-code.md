# Run someone else's CODE

Try a published bot on your characters (or on its author's, from their public page) without installing it on live.

## 1. Add it to the library

```sh
chronal library add https://github.com/<owner>/<repo>
```

It is cloned and pinned to its newest commit, under the name `<owner>-<repo>` (`--name` to choose one). A folder, a
file, a gist or any git link work too; the dashboard's New sim also takes a paste or uploaded files (CODE, Add CODE).

## 2. Look at what it reaches, then trust it

The sim runs CODE with no sandbox: it can do anything your user can on this machine. So others' CODE only runs at a
commit you trusted.

```sh
chronal library scan <name>     # network calls, servers named, code made at run time, Node modules, a build step
chronal library trust <name>    # asks, then trusts this commit
```

The New sim form shows the same and has a Trust button. A new commit (after `chronal library update <name>`) is asked
about again.

## 3. Fit it

Published CODE was written for its author's account: numbered slots, helpers in other slots, entries named after
their characters. ChronAL suggests a fit:

```sh
chronal library fit <name>
```

It lists the calls it fitted by file names, the calls it couldn't (`--call 100=none` or `--call 100=utils` decides),
and the helper slots each entry runs first (`--with Entry=helpers+more`). Your choices are kept for every run of it.
[Fitting](../reference/library.md#fitting-others-code).

## 4. Run it

```sh
chronal new --chars Merch,Ranger,Priest --code-set <name> --check
```

Each character runs the entry the library guesses for it (its name, else its class, else a main slot...); the
printout says which and why, and `--missing Priest=priest_main` picks another. Names of the author's characters in the
CODE are mapped to yours (`--code-name TheirRanger=Ranger` chooses).

A setup can also take the set directly: `chronal run my.json --code-set <name>`. That runs each character's slot
named like it, without guessing: for the others, `--missing Ran1=ranger` names the slot (`chronal run` stops and lists
the set's slots otherwise).

## Your own CODE from another folder

`chronal library add ~/al/otherbot` reads the folder where it is (`dir:` set): no pin, no trust prompt. `--copy` copies
it as it is now, as a version of its own.
