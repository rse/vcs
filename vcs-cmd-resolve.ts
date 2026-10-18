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
import chalk               from "chalk"

/*  own requirements  */
import {
    info, gitOK
} from "./vcs-util-base.js"
import {
    findBasedir, worktreeDir
} from "./vcs-util-repo.js"
import {
    resolveAndContinue, report
} from "./vcs-util-resolve.js"

/*  command: resolve  */
export const commandResolve = (program: Command) => {
    program.command("resolve")
        .description("resolve the conflicts in a worktree and continue its in-progress operation")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("[worktree]", "worktree to resolve (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string, safe: boolean }) => {
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const dir     = await worktreeDir(basedir, worktree)
            const res     = await resolveAndContinue(dir, opts.safe)
            await report(res)
            info(`resolve verdict: ${res.verdict === "PARTIAL" ? chalk.yellow(res.verdict) : chalk.green(res.verdict)}`)
            if (res.verdict === "PARTIAL")
                process.exitCode = 1
        })
}

