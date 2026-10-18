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
import path                from "node:path"

/*  own requirements  */
import {
    info, git, gitOK
} from "./vcs-util-base.js"
import { hasUnmerged }     from "./vcs-util-repo.js"
import {
    type Resolution,
    resolveConflicts, resolveAndContinue
} from "./vcs-util-resolve.js"

/*  rebase a worktree onto its parent branch, resolving conflicts  */
export const rebase = async (dir: string, parent: string, safe: boolean): Promise<Resolution | null> => {
    const result = await git(dir, [ "rebase", "--quiet", parent ], "rebase onto the parent branch")
    if (!result.failed) {
        info(`branch of worktree "${path.basename(dir)}" rebased onto "${parent}"`)
        return null
    }
    if (!(await hasUnmerged(dir))) {
        await git(dir, [ "rebase", "--abort" ], "abort the failed rebase")
        throw new Error(`rebase onto "${parent}" failed: ${(result.stderr || result.stdout).trim()}`)
    }
    const res = await resolveAndContinue(dir, safe)
    if (res.verdict !== "PARTIAL")
        info(`branch of worktree "${path.basename(dir)}" rebased onto "${parent}" (with resolved conflicts)`)
    return res
}

/*  stash uncommitted changes of a worktree (including untracked files), but, for a
    subsequent rebase onto a branch, only if they could actually interfere with it  */
export const stashPush = async (dir: string, message: string, onto = "") => {
    if ((await gitOK(dir, [ "status", "--porcelain" ], "check for uncommitted changes")) === "")
        return false
    if (onto !== "" && (await gitOK(dir, [ "status", "--porcelain", "--untracked-files=no" ], "check for uncommitted changes of tracked files")) === "") {
        /*  with untracked files only, a rebase is affected just by untracked files (or their
            leading directories) colliding with files written by it, i.e., files of the target
            branch or of the replayed commits  */
        const list = async (args: string[], what: string) =>
            (await gitOK(dir, [ "-c", "core.quotePath=false", ...args ], what)).split("\n").filter((f) => f !== "")
        const prefixes = (f: string) =>
            f.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"))
        const written = new Set([
            ...(await list([ "ls-tree", "-r", "--name-only", onto ], "list the files of the target branch")),
            ...(await list([ "log", "--name-only", "--format=", `${onto}..HEAD` ], "list the files of the replayed commits"))
        ].flatMap(prefixes))
        const untracked = await list([ "ls-files", "--others", "--exclude-standard" ], "list the untracked files")
        if (!untracked.some((f) => prefixes(f).some((p) => written.has(p))))
            return false
    }
    await gitOK(dir, [ "stash", "push", "--quiet", "--include-untracked", "--message", message ], "stash the uncommitted changes")
    info(`uncommitted changes of worktree "${path.basename(dir)}" stashed`)
    return true
}

/*  restore stashed changes of a worktree, resolving conflicts
    (returns the resolution in case of escalated conflicts only)  */
export const stashPop = async (dir: string, safe: boolean): Promise<Resolution | null> => {
    const result = await git(dir, [ "stash", "pop", "--quiet" ], "restore the stashed changes")
    if (result.failed) {
        if (!(await hasUnmerged(dir)))
            throw new Error(`failed to restore stashed changes of worktree "${path.basename(dir)}" (kept in stash): ` +
                `${(result.stderr || result.stdout).trim()}`)
        const res = await resolveConflicts(dir, safe)
        if (res.verdict === "PARTIAL")
            return res

        /*  unstage restored changes and drop the (on conflicts kept) stash  */
        await gitOK(dir, [ "reset", "--quiet" ], "unstage the restored changes")
        await gitOK(dir, [ "stash", "drop", "--quiet" ], "drop the stash kept on conflicts")
    }
    info(`uncommitted changes of worktree "${path.basename(dir)}" restored`)
    return null
}

