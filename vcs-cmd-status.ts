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
    findBasedir, worktreeDir, masterName, currentBranch, parentBranch
} from "./vcs-util-repo.js"

/*  command: status  */
export const commandStatus = (program: Command) => {
    program.command("status")
        .description("show the changed files of a worktree against its parent branch")
        .option("-d, --basedir <basedir>", "base directory")
        .argument("[worktree]", "worktree to show the changed files of (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string }) => {
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const dir     = await worktreeDir(basedir, worktree)
            const branch  = await currentBranch(dir)
            const parent  = await parentBranch(dir, branch).catch(async () => currentBranch(path.join(basedir, await masterName(basedir))))
            if (parent === branch)
                throw new Error(`branch "${branch}" cannot be compared against itself`)

            /*  determine committed, staged, and unstaged (including untracked) files
                (later layers override earlier ones, so each file is marked by its most recent change)  */
            const files = new Map<string, [ string, string ]>()
            const kinds: Record<string, string> = { A: "A", D: "R" }
            const layers: [ string, string[], string ][] = [
                [ "C", [ "diff", "--name-status", "-z", "--no-renames", "--merge-base", parent, "HEAD" ], "determine the committed files" ],
                [ "S", [ "diff", "--name-status", "-z", "--no-renames", "--cached" ],                    "determine the staged files" ],
                [ "U", [ "diff", "--name-status", "-z", "--no-renames" ],                                "determine the unstaged files" ]
            ]
            for (const [ mark, args, what ] of layers) {
                const fields = (await gitOK(dir, args, what)).split("\0").filter((f) => f !== "")
                for (let i = 0; i + 1 < fields.length; i += 2)
                    files.set(fields[i + 1], [ mark, kinds[fields[i]] ?? "M" ])
            }
            const untracked = await gitOK(dir, [ "ls-files", "--others", "--exclude-standard", "-z" ], "determine the untracked files")
            for (const file of untracked.split("\0").filter((f) => f !== ""))
                files.set(file, [ "U", "A" ])

            /*  output files sorted by path  */
            const markColor: Record<string, (s: string) => string> = { U: chalk.red,  S: chalk.blue, C: chalk.black }
            const kindColor: Record<string, (s: string) => string> = { A: chalk.blue, R: chalk.red,  M: chalk.black }
            for (const file of [ ...files.keys() ].sort()) {
                const [ mark, kind ] = files.get(file)!
                info(`${chalk.blue("▶")} ${markColor[mark](mark)} ${chalk.blue("▷")} ${kindColor[kind](kind)}: ${file}`)
            }
        })
}
