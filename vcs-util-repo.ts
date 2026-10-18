/*!
**  VCS -- Worktree Management for Git Version Control System
**  Copyright (c) 2026 Dr. Ralf S. Engelschall <rse@engelschall.com>
**
**  Permission is hereby granted, free of charge, to any person obtaining
**  a copy of this software and associated documentation files (the
**  "Software"), to deal in the Software without restriction, including
**  without limitation the rights to use, copy, modify, merge, publish,
**  distribute, sublicense, and/or sell copies of the Software, and to
**  permit persons to whom the Software is furnished to do so, subject to
**  the following conditions:
**
**  The above copyright notice and this permission notice shall be included
**  in all copies or substantial portions of the Software.
**
**  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
**  EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
**  MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
**  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
**  CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
**  TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
**  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

/*  internal requirements  */
import fs                  from "node:fs"
import path                from "node:path"

/*  own requirements  */
import {
    git, gitOK, exists, isSymlink
} from "./vcs-util-base.js"

/*  type definitions  */
export type Operation = "merge" | "rebase" | "cherry-pick" | "revert" | "none"

/*  determine basedir (explicitly given or auto-detected from CWD upwards)  */
export const findBasedir = async (basedir?: string) => {
    if (basedir !== undefined) {
        basedir = path.resolve(basedir)
        if (!(await isSymlink(path.join(basedir, "active"))))
            throw new Error(`no "active" symlink found in basedir "${basedir}"`)
        return basedir
    }
    let dir = process.cwd()
    while (!(await isSymlink(path.join(dir, "active")))) {
        const parent = path.dirname(dir)
        if (parent === dir)
            throw new Error("no basedir found (no \"active\" symlink in current or any parent directory)")
        dir = parent
    }
    return dir
}

/*  determine directory of a worktree under basedir  */
export const worktreeDir = async (basedir: string, name: string, mustExist = true) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "active")
        throw new Error(`invalid worktree name "${name}"`)
    const dir = path.join(basedir, name)
    if (mustExist && !(await exists(path.join(dir, ".git"))))
        throw new Error(`no worktree "${name}" found under basedir "${basedir}"`)
    return dir
}

/*  determine name of the master worktree under an initialized basedir
    (Git always lists the main worktree first)  */
export const masterName = async (basedir: string) => {
    const list = await gitOK(path.join(basedir, "active"), [ "worktree", "list", "--porcelain" ], "list worktrees to determine the master worktree")
    const main = list.match(/^worktree (.+)$/m)?.[1]
    if (main === undefined)
        throw new Error(`no master worktree found under basedir "${basedir}"`)
    const rel = path.relative(await fs.promises.realpath(basedir), await fs.promises.realpath(main))
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep))
        throw new Error(`master worktree "${main}" not located directly under basedir "${basedir}"`)
    return rel
}

/*  atomically re-point the "active" symlink  */
export const setActive = async (basedir: string, name: string) => {
    const tmp = path.join(basedir, `.active.${process.pid}`)
    await fs.promises.symlink(name, tmp)
    await fs.promises.rename(tmp, path.join(basedir, "active")).catch(async (err: unknown) => {
        await fs.promises.rm(tmp, { force: true })
        throw err
    })
}

/*  determine checked-out branch of a worktree  */
export const currentBranch = async (dir: string) => {
    const branch = await gitOK(dir, [ "branch", "--show-current" ], "determine the checked-out branch")
    if (branch === "")
        throw new Error(`worktree "${dir}" has no checked-out branch (detached HEAD)`)
    return branch
}

/*  determine recorded parent branch of a branch  */
export const parentBranch = async (dir: string, branch: string) => {
    const result = await git(dir, [ "config", "--get", `branch.${branch}.vcsParent` ], "determine the recorded parent branch")
    if (result.failed || result.stdout === "")
        throw new Error(`no parent branch recorded for branch "${branch}"`)
    return result.stdout
}

/*  determine worktree directory where a branch is checked out (or empty)  */
export const branchDir = async (dir: string, branch: string) => {
    let worktree = ""
    for (const line of (await gitOK(dir, [ "worktree", "list", "--porcelain" ], "list worktrees to find where the branch is checked out")).split("\n")) {
        if (line.startsWith("worktree "))
            worktree = line.slice("worktree ".length)
        else if (line === `branch refs/heads/${branch}`)
            return worktree
    }
    return ""
}

/*  determine in-progress Git operation  */
export const theirsRefs: [ string, Operation ][] = [
    [ "MERGE_HEAD", "merge" ], [ "REBASE_HEAD", "rebase" ],
    [ "CHERRY_PICK_HEAD", "cherry-pick" ], [ "REVERT_HEAD", "revert" ]
]
export const operation = async (dir: string): Promise<Operation> => {
    /*  detect rebase by its state directories only, as Git can leave a stale REBASE_HEAD behind  */
    const states: [ string, Operation ][] = [
        ...theirsRefs.filter(([ , op ]) => op !== "rebase"),
        [ "rebase-merge", "rebase" ], [ "rebase-apply", "rebase" ]
    ]
    const paths = (await gitOK(dir, [ "rev-parse", ...states.flatMap(([ state ]) => [ "--git-path", state ]) ],
        "determine paths of the in-progress operation state files")).split("\n")
    for (const [ i, [ , op ] ] of states.entries())
        if (await exists(path.resolve(dir, paths[i])))
            return op
    return "none"
}

/*  check for unmerged files  */
export const hasUnmerged = async (dir: string) =>
    (await gitOK(dir, [ "diff", "--name-only", "--diff-filter=U" ], "list unmerged files")) !== ""

/*  clean a worktree to the state of a fresh fork: abort an in-progress operation,
    reset to HEAD, and remove all untracked (and optionally ignored) files  */
export const cleanWorktree = async (dir: string, ignored: boolean) => {
    const op = await operation(dir)
    if (op !== "none")
        await gitOK(dir, [ op, "--abort" ], "abort the in-progress operation")
    await gitOK(dir, [ "reset", "--quiet", "--hard", "HEAD" ], "discard the staged and unstaged changes")
    await gitOK(dir, [ "clean", "--quiet", "--force", "-d", ...(ignored ? [ "-x" ] : []) ], "remove the untracked files")
}

