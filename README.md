
VCS
===

**Worktree Management for Git Version Control System**

Abstract
--------

This is a small Command-Line Interface (CLI) for managing a Git
worktree-based workflow inside a *basedir*. The basedir directly contains
the Git repository clone `master`, any number of Git worktrees of it,
and a symbolic link `active`, which points to either `master` or one of
the worktrees. Worktrees are forked from a parent branch, synchronized
with it, and merged back into it, where Git conflicts are resolved
semantically and safely with the help of Claude Code (`claude -p`).

Installation
------------

```
$ npm install -g vcs
```

Usage
-----

```
$ vcs init     [-d <basedir>] -r <repo-url>
$ vcs active   [-d <basedir>]
$ vcs activate [-d <basedir>] <worktree>
$ vcs fork     [-d <basedir>] [-b <branch>] <worktree> [<parent-branch>]
$ vcs sync     [-d <basedir>] [-s] <worktree>
$ vcs merge    [-d <basedir>] [-m merge|rebase|squash] [-s] <worktree>
$ vcs resolve  [-d <basedir>] [-s] <worktree>
$ vcs destroy  [-d <basedir>] <worktree>
```

- `-d <basedir>`, `--basedir <basedir>`<br/>
  Base directory. By default, it is auto-detected as the current
  directory or the nearest parent directory containing an `active`
  symbolic link (for `init`: the current directory).
- `init -r <repo-url>`<br/>
  Create the basedir with a clone of the Git repository `<repo-url>`
  in `master` and activate `master`.
- `active`<br/>
  Show the active worktree.
- `activate <worktree>`<br/>
  Activate the worktree by re-pointing the `active` symbolic link.
- `fork [-b <branch>] <worktree> [<parent-branch>]`<br/>
  Create the worktree with the new branch `<branch>` (default:
  `<worktree>`), based on the parent branch `<parent-branch>` (default:
  the branch of the active worktree). The parent branch is recorded for
  `sync`, `merge`, and `destroy`.
- `sync [-s] <worktree>`<br/>
  Fetch `origin`, fast-forward the parent branch, and rebase the
  worktree onto it, resolving conflicts. On unresolvable conflicts, the
  rebase is left in progress for manual resolution.
- `merge [-m merge|rebase|squash] [-s] <worktree>`<br/>
  Merge the worktree into its parent branch with a merge commit
  (`merge`, default), a rebase and fast-forward (`rebase`), or a single
  squashed commit (`squash`), resolving conflicts. On unresolvable
  conflicts, the merge is aborted.
- `resolve [-s] <worktree>`<br/>
  Resolve the conflicts in the worktree and continue its in-progress
  operation.
- `destroy <worktree>`<br/>
  Remove the worktree and its branch, if the branch has landed on its
  parent branch. If the worktree was active, `master` is activated.
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

