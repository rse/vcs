
VCS
===

**Worktree Management for Git Version Control System**

Abstract
--------

This is a small Command-Line Interface (CLI) for managing a Git
worktree-based workflow inside a *basedir*. The basedir directly contains
the Git repository clone (the *master worktree*, usually named `master`
or `main`), any number of Git worktrees of it, and a symbolic link
`active`, which points to either the master worktree or one of the
worktrees. The master worktree is auto-detected as the directory the
`.git` files of the worktrees point into (or, without any worktrees,
as the single directory with a `.git` directory). Worktrees are forked from a parent branch, synchronized
with it, and merged back into it, where Git conflicts are resolved
semantically and safely with the help of Claude Code (`claude -p`).

Installation
------------

```
$ npm install -g @rse/vcs
```

Usage
-----

```
$ vcs init     [-v <num>] [-d <basedir>] [-r <repo-url>]
$ vcs list     [-v <num>] [-d <basedir>]
$ vcs active   [-v <num>] [-d <basedir>]
$ vcs activate [-v <num>] [-d <basedir>] [<worktree>]
$ vcs fork     [-v <num>] [-d <basedir>] [-b <branch>] <worktree> [<parent-branch>]
$ vcs sync     [-v <num>] [-d <basedir>] [-s] [<worktree>]
$ vcs merge    [-v <num>] [-d <basedir>] [-m merge|rebase|squash] [-s] [<worktree>]
$ vcs resolve  [-v <num>] [-d <basedir>] [-s] [<worktree>]
$ vcs shuffle  [-v <num>] [-d <basedir>] [-s] <worktree>
$ vcs clean    [-v <num>] [-d <basedir>] [-i] [<worktree>]
$ vcs rename   [-v <num>] [-d <basedir>] <worktree-old> <worktree-new>
$ vcs destroy  [-v <num>] [-d <basedir>] <worktree>
```

- `-v <num>`, `--verbose <num>`<br/>
  Verbosity level: `0` (default) prints nothing (except errors), `1`
  prints information and every executed command (as `$ <command>`),
  and `2` additionally prints a brief comment (as `# <comment>`)
  before every executed command.
- `-d <basedir>`, `--basedir <basedir>`<br/>
  Base directory. By default, it is auto-detected as the current
  directory or the nearest parent directory containing an `active`
  symbolic link (for `init`: the current directory).
- `init [-r <repo-url>]`<br/>
  Create the basedir with a clone of the Git repository `<repo-url>`
  in the master worktree, named after the default branch of the
  repository, and activate it. If a master worktree already exists,
  `-r` has to be omitted and the existing master worktree is taken as is.
- `list`<br/>
  List all worktrees as a table with their directory, worktree name
  (`-` if not located directly under the basedir), branch, and an `X`
  marker for the master, the active, and the current worktree (the one
  containing the current directory). The master worktree
  is rendered in bold and the active worktree in blue.
- `active`<br/>
  Show the active worktree.
- `activate [<worktree>]`<br/>
  Activate the worktree (default: the worktree containing the current
  directory, determined via its Git root) by re-pointing the `active`
  symbolic link.
- `fork [-b <branch>] <worktree> [<parent-branch>]`<br/>
  Create the worktree with the new branch `<branch>` (default:
  `<worktree>`), based on the parent branch `<parent-branch>` (default:
  the branch of the active worktree). The parent branch is recorded for
  `sync`, `merge`, and `destroy`.
- `sync [-s] [<worktree>]`<br/>
  Fetch `origin`, fast-forward the parent branch, and rebase the
  worktree (default: the worktree containing the current directory) onto
  it, resolving conflicts. If the worktree is already up-to-date with
  the parent branch, nothing else happens. Uncommitted changes
  (including untracked files) are stashed before and restored after the
  rebase, resolving conflicts, too. On unresolvable conflicts, the
  rebase or restoration is left in progress for manual resolution.
- `merge [-m merge|rebase|squash] [-s] [<worktree>]`<br/>
  Merge the worktree (default: the worktree containing the current
  directory) into its parent branch with a merge commit (`merge`,
  default), a rebase and fast-forward (`rebase`), or a single squashed
  commit (`squash`), resolving conflicts. On unresolvable conflicts, the
  merge is aborted. Uncommitted changes (including untracked files) of
  the worktree of the parent branch are stashed before and restored
  after the merge, resolving conflicts, too.
- `resolve [-s] [<worktree>]`<br/>
  Resolve the conflicts in the worktree (default: the worktree containing
  the current directory) and continue its in-progress operation.
- `shuffle [-s] <worktree>`<br/>
  Move all staged, unstaged, and untracked files of the worktree
  containing the current directory into the working copy of the
  worktree `<worktree>`, where they stay uncommitted, resolving
  conflicts, both with its branch and with its own uncommitted changes
  (temporarily committed during the operation). On success, the
  current worktree is cleaned (see `clean`). On unresolvable conflicts,
  the current worktree is kept untouched for manual resolution in the
  other worktree.
- `clean [-i] [<worktree>]`<br/>
  Abort any in-progress operation of the worktree (default: the worktree
  containing the current directory), reset it to its `HEAD`, and remove
  all untracked files (with `-i` also all ignored files), so the
  worktree looks as freshly forked.
- `rename <worktree-old> <worktree-new>`<br/>
  Rename the worktree, both its directory and its Git worktree
  reference. If its branch is named after the worktree, the branch
  is renamed, too, and child branches are re-pointed to it. If the
  worktree was active, the renamed worktree is activated.
- `destroy <worktree>`<br/>
  Remove the worktree and its branch, if the branch has landed on its
  parent branch. If the worktree was active, the master worktree is
  activated.
- `-s`, `--safe`<br/>
  Never touch non-content conflicts (binary, submodule, modify/delete,
  rename, delete/delete), but always escalate them. Without this option,
  they are resolved only if their intent is unambiguous.

Conflict Resolution
-------------------

Conflicts are resolved *semantically*: trivial, independent, and
compatible conflict hunks are resolved, while contradicting hunks are
kept as-is with their conflict markers and escalated. No change is ever
lost: all conflicted files are backed up before, every resolution is
checked for change preservation, and files with leftover conflict
markers are never staged. Only the results and one-line information on
escalated conflicts are shown.

License
-------

Copyright &copy; 2026 Dr. Ralf S. Engelschall (http://engelschall.com/)

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

