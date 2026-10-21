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
import { execa }           from "execa"

/*  own requirements  */
import {
    trace, gitOK
} from "./vcs-util-base.js"
import {
    findBasedir, worktreeDir, masterName, currentBranch, parentBranch
} from "./vcs-util-repo.js"

/*  command: diff  */
export const commandDiff = (program: Command) => {
    program.command("diff")
        .description("show the changes of a worktree against its parent branch")
        .option("-d, --basedir <basedir>", "base directory")
        .argument("[worktree]", "worktree to show the changes of (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string }) => {
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const dir     = await worktreeDir(basedir, worktree)
            const branch  = await currentBranch(dir)
            const parent  = await parentBranch(dir, branch).catch(async () => currentBranch(path.join(basedir, await masterName(basedir))))
            if (parent === branch)
                throw new Error(`branch "${branch}" cannot be diffed against itself`)

            /*  show unified diff of committed and uncommitted changes since the fork point
                (with stdio inherited, so Git can apply its pager and colors)  */
            const args = [ "-C", dir, "diff", "--merge-base", parent ]
            trace("git", args, "show the changes against the parent branch")
            const result = await execa("git", args, { reject: false, stdio: "inherit" })
            if (result.failed)
                throw new Error(`command "git ${args.slice(2).join(" ")}" failed`)
        })
}

