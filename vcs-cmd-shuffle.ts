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
import { Command }         from "commander"

/*  own requirements  */
import {
    info, git, gitOK, exists
} from "./vcs-util-base.js"
import {
    findBasedir, worktreeDir,
    operation, hasUnmerged, cleanWorktree
} from "./vcs-util-repo.js"
import {
    resolveConflicts, report
} from "./vcs-util-resolve.js"

/*  snapshot all staged, unstaged, and untracked files of a worktree into a stash-like
    commit (working copy tree, parents HEAD and index), without touching the worktree  */
const snapshot = async (dir: string) => {
    const index = path.resolve(dir, await gitOK(dir, [ "rev-parse", "--git-path", "index" ], "determine the path of the index"))
    const tmp   = `${index}.vcs-shuffle.${process.pid}`
    const wtree = await (async () => {
        if (await exists(index))
            await fs.promises.copyFile(index, tmp)
        await gitOK(dir, [ "add", "--all" ], "add all files to a temporary index", { GIT_INDEX_FILE: tmp })
        return gitOK(dir, [ "write-tree" ], "write the tree of the working copy", { GIT_INDEX_FILE: tmp })
    })().finally(() => fs.promises.rm(tmp, { force: true }))
    const itree   = await gitOK(dir, [ "write-tree" ], "write the tree of the index")
    const head    = await gitOK(dir, [ "rev-parse", "HEAD" ], "determine the current commit")
    const icommit = await gitOK(dir, [ "commit-tree", itree, "-p", head, "-m", "vcs shuffle: index" ], "create the commit of the index")
    return gitOK(dir, [ "commit-tree", wtree, "-p", head, "-p", icommit, "-m", "vcs shuffle: working copy" ], "create the commit of the working copy")
}

/*  command: shuffle  */
export const commandShuffle = (program: Command) => {
    program.command("shuffle")
        .description("move all staged, unstaged, and untracked files of the current worktree into the working copy of another worktree")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("<worktree>", "worktree to shuffle the files into")
        .action(async (worktree: string, opts: { basedir?: string, safe: boolean }) => {
            const basedir = await findBasedir(opts.basedir)
            const source  = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const sdir    = await worktreeDir(basedir, source)
            const tdir    = await worktreeDir(basedir, worktree)
            if (source === worktree)
                throw new Error(`cannot shuffle worktree "${source}" into itself`)
            for (const dir of [ sdir, tdir ]) {
                const op = await operation(dir)
                if (op !== "none")
                    throw new Error(`worktree "${dir}" has an in-progress ${op} operation`)
                if (await hasUnmerged(dir))
                    throw new Error(`worktree "${dir}" has unmerged files`)
            }

            /*  short-circuit processing if nothing is to be shuffled  */
            if ((await gitOK(sdir, [ "status", "--porcelain" ], "check for uncommitted changes")) === "") {
                info(`worktree "${source}" has no uncommitted changes to shuffle`)
                return
            }

            /*  snapshot current worktree and temporarily commit uncommitted changes of target worktree
                (as "git stash apply" refuses to merge into dirty files)  */
            const commit = await snapshot(sdir)
            const temp   = (await gitOK(tdir, [ "status", "--porcelain" ], "check for uncommitted changes")) !== ""
            if (temp) {
                await gitOK(tdir, [ "add", "--all" ], "stage the uncommitted changes of the target worktree")
                await gitOK(tdir, [ "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", "vcs shuffle: temporary commit" ],
                    "temporarily commit the uncommitted changes of the target worktree")
            }
            const uncommit = temp ? [ "reset", "--quiet", "HEAD~1" ] : [ "reset", "--quiet" ]
            const hint     = `run "git ${uncommit.filter((arg) => arg !== "--quiet").join(" ")}" there`

            /*  apply snapshot onto target worktree, resolving conflicts  */
            try {
                const result = await git(tdir, [ "stash", "apply", "--quiet", commit ], "apply the snapshot to the target worktree")
                if (result.failed) {
                    if (!(await hasUnmerged(tdir))) {
                        await gitOK(tdir, uncommit, "restore the original state of the target worktree")
                        throw new Error(`failed to shuffle files into worktree "${worktree}": ${(result.stderr || result.stdout).trim()}`)
                    }
                    const res = await resolveConflicts(tdir, opts.safe)
                    if (res.verdict === "PARTIAL") {
                        await report(res)
                        info(`files shuffled into worktree "${worktree}" with conflicts: resolve the escalated conflicts manually, ` +
                            `${hint}, and afterwards run "vcs clean" in worktree "${source}"`)
                        process.exitCode = 1
                        return
                    }
                }
            }
            catch (err: unknown) {
                if (temp && (await hasUnmerged(tdir)))
                    info(`uncommitted changes of worktree "${worktree}" remain temporarily committed -- ` +
                        `after resolving the conflicts, ${hint}`)
                throw err
            }

            /*  undo temporary commit and unstage all files of target worktree  */
            await gitOK(tdir, uncommit, temp ?
                "undo the temporary commit of the target worktree" :
                "unstage the shuffled files")

            /*  clean current worktree  */
            await cleanWorktree(sdir, false)
            info(`files of worktree "${source}" shuffled into worktree "${worktree}"`)
        })
}

