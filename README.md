
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

Behind the Scenes
-----------------

The following outlines the major logical Git operations performed per
command (similar to the output of `-v 1`, but without the `-C <dir>`
options and the minor read-only queries). Comments name the worktree
each operation runs in and the conditions under which it happens.

- `init`:

  ```sh
  # (only without an existing master worktree)
  git ls-remote --symref -- <repo-url> HEAD            # determine default branch <name>
  git clone --quiet -- <repo-url> <name>
  ln -s <name> active                                  # (atomically)
  ```

- `list`:

  ```sh
  git worktree list --porcelain
  ```

- `active`:

  ```sh
  readlink active
  ```

- `activate`:

  ```sh
  git rev-parse --show-toplevel                        # (only without <worktree>)
  ln -s <worktree> active                              # (atomically)
  ```

- `fork`:

  ```sh
  git branch --show-current                            # in active worktree (only without <parent-branch>)
  git worktree add --quiet -b <branch> <worktree> <parent-branch>
  git config branch.<branch>.vcsParent <parent-branch>
  ```

- `sync`:

  ```sh
  git config --get branch.<branch>.vcsParent           # determine <parent-branch>
  git fetch --quiet origin                             # (only with an "origin" remote)
  git merge --quiet --ff-only origin/<parent-branch>   # in worktree of <parent-branch> (if behind), or
  git update-ref refs/heads/<parent-branch> refs/remotes/origin/<parent-branch>  # (if not checked out)
  git merge-base --is-ancestor <parent-branch> HEAD    # (stop here, if already up-to-date)
  git stash push --quiet --include-untracked           # (only with uncommitted changes)
  git rebase --quiet <parent-branch>
  vcs resolve                                          # (only on conflicts, see "resolve")
  git stash pop --quiet                                # (only with stashed changes)
  vcs resolve                                          # (only on conflicts, see "resolve")
  git reset --quiet && git stash drop --quiet          # (only on resolved conflicts)
  ```

- `merge`:

  ```sh
  git config --get branch.<branch>.vcsParent           # determine <parent-branch>
  git stash push --quiet --include-untracked           # in worktree of <parent-branch> (only with uncommitted changes)

  # mode "merge" (in worktree of <parent-branch>)
  git merge --quiet --no-ff --no-edit <branch>
  vcs resolve                                          # (only on conflicts, see "resolve")
  git commit --quiet --no-edit                         # (only on resolved conflicts)

  # mode "squash" (in worktree of <parent-branch>)
  git merge --quiet --squash <branch>
  vcs resolve                                          # (only on conflicts, see "resolve")
  git commit --quiet --no-edit                         # (only with staged changes)

  # mode "rebase"
  git rebase --quiet <parent-branch>                   # in <worktree>
  vcs resolve                                          # in <worktree> (only on conflicts, see "resolve")
  git merge --quiet --ff-only <branch>                 # in worktree of <parent-branch>

  git reset --quiet --merge                            # (only on unresolved conflicts in modes "merge" and "squash")
  git rebase --abort                                   # (only on unresolved conflicts in mode "rebase")
  git merge-base --is-ancestor <branch> <parent-branch>  # (not in mode "squash")
  git stash pop --quiet                                # in worktree of <parent-branch> (only with stashed changes)
  vcs resolve                                          # (only on conflicts, see "resolve")
  git reset --quiet && git stash drop --quiet          # (only on resolved conflicts)
  ```

- `resolve`:

  ```sh
  git status --porcelain=v1 -z                         # determine and classify unmerged files
  cp <file> .git/.../vcs-resolve/<head>-<theirs>/      # back up all conflicted files
  git rm --quiet -- <file>                             # (only for delete/delete conflicts)
  git checkout --ours|--theirs -- <file>               # (only for binary conflicts changed on one side only)
  git update-index --cacheinfo <mode>,<oid>,<file>     # (only for submodule conflicts changed on one side only)
  claude -p <prompt> ...                               # (only for remaining conflicts)
  git add -- <file> ...                                # stage all fully resolved files
  git -c core.editor=true <operation> --continue       # (only with in-progress operation; repeatedly on rebase)
  ```

- `shuffle`:

  ```sh
  # in current worktree: snapshot into a stash-like commit (current worktree stays untouched)
  GIT_INDEX_FILE=<tmp-index> git add --all             # (on a copy of the index)
  GIT_INDEX_FILE=<tmp-index> git write-tree            # determine <working-tree>
  git write-tree                                       # determine <index-tree>
  git commit-tree <index-tree> -p HEAD -m "vcs shuffle: index"  # determine <index-commit>
  git commit-tree <working-tree> -p HEAD -p <index-commit> -m "vcs shuffle: working copy"  # determine <commit>

  # in <worktree>: apply snapshot
  git add --all                                        # (only with uncommitted changes)
  git commit --quiet --no-verify --no-gpg-sign -m "vcs shuffle: temporary commit"  # (only with uncommitted changes)
  git stash apply --quiet <commit>
  vcs resolve                                          # (only on conflicts, see "resolve")
  git reset --quiet HEAD~1                             # (only with temporary commit), or
  git reset --quiet                                    # (only without temporary commit)

  # in current worktree
  vcs clean
  ```

- `clean`:

  ```sh
  git <operation> --abort                              # (only with in-progress operation)
  git reset --quiet --hard HEAD
  git clean --quiet --force -d [-x]                    # ("-x" only with option "-i")
  ```

- `rename`:

  ```sh
  git worktree repair <worktree-old>
  git worktree move <worktree-old> <worktree-new>
  mv .git/worktrees/<worktree-old> .git/worktrees/<worktree-new>  # (and adjust ".git" file of worktree)
  git branch -m <worktree-old> <worktree-new>          # (only if branch is named after worktree)
  git config branch.<child>.vcsParent <worktree-new>   # (only for child branches)
  ln -s <worktree-new> active                          # (only if worktree was active, atomically)
  ```

- `destroy`:

  ```sh
  git merge-base --is-ancestor <branch> <parent-branch>  # check whether branch landed, or else
  git merge-tree --write-tree <parent-branch> <branch>   # check whether squashed branch landed
  ln -s <master> active                                  # (only if worktree was active, atomically)
  git worktree remove <worktree>
  git branch --quiet -D <branch>
  ```

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

