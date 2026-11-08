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

/*  external requirements  */
import { Command }         from "commander"

/*  own requirements  */
import {
    info, gitOK
} from "./vcs-util-base.js"
import {
    findBasedir, worktreeDir, masterName, currentBranch, parentBranch, operation
} from "./vcs-util-repo.js"

/*  command: uncommit  */
export const commandUncommit = (program: Command) => {
    program.command("uncommit")
        .description("undo the last (or all) commits of a worktree since its fork point, keeping their changes staged")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-a, --all", "undo all commits since the fork point", false)
        .argument("[worktree]", "worktree to undo the commits of (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string, all: boolean }) => {
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const dir     = await worktreeDir(basedir, worktree)
            const branch  = await currentBranch(dir)
            const parent  = await parentBranch(dir, branch).catch(async () => currentBranch(path.join(basedir, await masterName(basedir))))
            if (parent === branch)
                throw new Error(`branch "${branch}" has no parent branch to uncommit towards`)
            const op      = await operation(dir)
            if (op !== "none")
                throw new Error(`worktree "${dir}" has an in-progress ${op} operation`)

            /*  ensure the branch has commits of its own since the fork point (the merge base)  */
            const base  = await gitOK(dir, [ "merge-base", parent, "HEAD" ], "determine the fork point")
            const count = Number(await gitOK(dir, [ "rev-list", "--count", `${base}..HEAD` ], "count the commits since the fork point"))
            if (count === 0)
                throw new Error(`branch "${branch}" has no commits since its fork point from parent branch "${parent}"`)

            /*  undo the last or all commits, keeping their changes staged  */
            await gitOK(dir, [ "reset", "--quiet", "--soft", opts.all ? base : "HEAD~1" ], "undo the commits, keeping their changes staged")
            info(`worktree "${worktree}" (branch "${branch}"): ${opts.all ? count : 1} commit(s) undone, changes kept staged`)
        })
}

