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

/*  external requirements  */
import { Command, Option } from "commander"

/*  own requirements  */
import {
    info, git, gitOK, gitTTY
} from "./vcs-util-base.js"
import {
    findBasedir, worktreeDir, masterName, currentBranch, parentBranch, branchDir,
    operation, hasUnmerged
} from "./vcs-util-repo.js"
import {
    resolveConflicts, report
} from "./vcs-util-resolve.js"
import {
    rebase, stashPush, stashPop
} from "./vcs-util-sync.js"

/*  command: merge  */
export const commandMerge = (program: Command) => {
    program.command("merge")
        .description("merge a worktree into its parent branch")
        .option("-d, --basedir <basedir>", "base directory")
        .addOption(new Option("-m, --mode <mode>", "merge mode").choices([ "merge", "rebase", "squash" ]).default("squash"))
        .option("-i, --interactive", "interactively edit the commit message (mode \"squash\" only)", false)
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("[worktree]", "worktree to merge (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string, mode: "merge" | "rebase" | "squash", interactive: boolean, safe: boolean }) => {
            if (opts.interactive && opts.mode !== "squash")
                throw new Error("option \"--interactive\" is supported in mode \"squash\" only")
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const dir     = await worktreeDir(basedir, worktree)
            const branch  = await currentBranch(dir)
            const parent  = await parentBranch(dir, branch).catch(async () => currentBranch(path.join(basedir, await masterName(basedir))))
            if (parent === branch)
                throw new Error(`branch "${branch}" cannot be merged into itself`)
            const fop     = await operation(dir)
            if (fop !== "none")
                throw new Error(`worktree "${dir}" has an in-progress ${fop} operation`)
            const pdir = await branchDir(dir, parent)
            if (pdir === "")
                throw new Error(`parent branch "${parent}" is not checked out in any worktree`)
            const op = await operation(pdir)
            if (op !== "none")
                throw new Error(`worktree "${pdir}" has an in-progress ${op} operation`)

            /*  in mode "rebase", rebase onto parent branch (unless already contained), while
                temporarily stashing uncommitted changes of worktree (including untracked files)
                -- completely before stashing in the parent worktree, as all worktrees share
                a single stash stack  */
            if (opts.mode === "rebase"
                && (await git(dir, [ "merge-base", "--is-ancestor", parent, "HEAD" ], "check whether the parent branch is already contained")).failed) {
                const fstashed = await stashPush(dir, "vcs merge", parent)
                const restore  = async () => {
                    if (fstashed && (await git(dir, [ "stash", "pop", "--quiet" ], "restore the stashed changes after failure")).failed)
                        info(`uncommitted changes of worktree "${worktree}" remain stashed -- ` +
                            "run \"git stash pop\" there to restore them")
                }
                const res = await rebase(dir, parent, opts.safe).catch(async (err: unknown) => {
                    await git(dir, [ "rebase", "--abort" ], "abort the failed rebase")
                    await restore()
                    throw err
                })
                if (res !== null && res.verdict === "PARTIAL") {
                    await git(dir, [ "rebase", "--abort" ], "abort the rebase with unresolved conflicts")
                    await fs.promises.rm(res.backupDir, { recursive: true, force: true })
                    await restore()
                    await report(res)
                    throw new Error(`merge of branch "${branch}" into "${parent}" aborted due to unresolved conflicts`)
                }
                const fres = fstashed ? await stashPop(dir, opts.safe) : null
                if (fres !== null) {
                    await report(fres)
                    info(`branch "${branch}" rebased onto parent branch "${parent}", but not yet merged, as ` +
                        `stashed changes of worktree "${worktree}" restored with conflicts: resolve the escalated ` +
                        "conflicts manually, run \"git reset\" and \"git stash drop\", and re-run \"vcs merge\"")
                    process.exitCode = 1
                    return
                }
            }

            /*  stash uncommitted changes of parent worktree (including untracked files)  */
            const stashed = await stashPush(pdir, "vcs merge")
            try {
                if (opts.mode === "rebase")
                    /*  fast-forward parent branch (onto which the branch was rebased)  */
                    await gitOK(pdir, [ "merge", "--quiet", "--ff-only", branch ], "fast-forward the parent branch")
                else {
                    /*  merge or squash branch into parent branch
                        (overriding a "merge.ff=only" configuration on squash)  */
                    const args = opts.mode === "squash" ?
                        [ "-c", "merge.ff=true", "merge", "--quiet", "--squash", branch ] :
                        [ "merge", "--quiet", "--no-ff", "--no-edit", branch ]
                    const result = await git(pdir, args, "merge the branch into the parent branch")
                    if (result.failed) {
                        if (!(await hasUnmerged(pdir))) {
                            await git(pdir, [ "reset", "--quiet", "--merge" ], "abort the failed merge")
                            throw new Error(`merge of branch "${branch}" into "${parent}" failed: ${(result.stderr || result.stdout).trim()}`)
                        }
                        const res = await resolveConflicts(pdir, opts.safe).catch(async (err: unknown) => {
                            await git(pdir, [ "reset", "--quiet", "--merge" ], "abort the failed merge")
                            throw err
                        })
                        if (res.verdict !== "RESOLVED") {
                            await git(pdir, [ "reset", "--quiet", "--merge" ], "abort the merge with unresolved conflicts")
                            await fs.promises.rm(res.backupDir, { recursive: true, force: true })
                            await report(res)
                            throw new Error(`merge of branch "${branch}" into "${parent}" aborted due to unresolved conflicts`)
                        }
                    }
                    if (result.failed || (opts.mode === "squash" && (await git(pdir, [ "diff", "--cached", "--quiet" ], "check for staged changes")).failed)) {
                        if (opts.interactive) {
                            /*  commit with the message edited via $GIT_EDITOR, core.editor, $VISUAL, or $EDITOR  */
                            if ((await gitTTY(pdir, [ "commit", "--quiet", "--edit" ], "commit the merge with an edited message")).failed) {
                                await git(pdir, [ "reset", "--quiet", "--merge" ], "abort the merge with an aborted commit")
                                throw new Error(`merge of branch "${branch}" into "${parent}" aborted due to aborted commit`)
                            }
                        }
                        else
                            await gitOK(pdir, [ "commit", "--quiet", "--no-edit" ], "commit the merge")
                    }
                }
                if (opts.mode !== "squash" && (await git(pdir, [ "merge-base", "--is-ancestor", branch, parent ], "check whether the branch landed on the parent branch")).failed)
                    throw new Error(`branch "${branch}" not contained in branch "${parent}" after merge`)
            }
            catch (err: unknown) {
                /*  restore stashed changes of parent worktree on the (aborted) original state  */
                if (stashed && (await git(pdir, [ "stash", "pop", "--quiet" ], "restore the stashed changes after failure")).failed)
                    info(`uncommitted changes of worktree "${path.basename(pdir)}" remain stashed -- ` +
                        "run \"git stash pop\" there to restore them")
                throw err
            }

            /*  record the squashed branch tip, as a squash leaves no ancestry for "destroy" to check  */
            if (opts.mode === "squash")
                await gitOK(pdir, [ "config", `branch.${branch}.vcs-squashed`,
                    await gitOK(pdir, [ "rev-parse", branch ], "determine the tip of the branch") ], "record the squashed branch tip")
            info(`worktree "${worktree}" (branch "${branch}") merged into parent branch "${parent}" (mode: ${opts.mode})`)

            /*  restore stashed changes of parent worktree, resolving conflicts  */
            const pres = stashed ? await stashPop(pdir, opts.safe) : null
            if (pres !== null) {
                await report(pres)
                info(`stashed changes of worktree "${path.basename(pdir)}" restored with conflicts: ` +
                    "resolve the escalated conflicts manually, and run \"git reset\" and \"git stash drop\"")
                process.exitCode = 1
            }
        })
}

