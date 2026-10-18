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
import chalk               from "chalk"
import Table               from "cli-table3"

/*  own requirements  */
import {
    git, gitOK
} from "./vcs-util-base.js"
import { findBasedir }     from "./vcs-util-repo.js"

/*  command: list  */
export const commandList = (program: Command) => {
    program.command("list")
        .description("list all worktrees")
        .option("-d, --basedir <basedir>", "base directory")
        .action(async (opts: { basedir?: string }) => {
            const basedir = await findBasedir(opts.basedir)
            const real    = await fs.promises.realpath(basedir)
            const active  = await fs.promises.readlink(path.join(basedir, "active"))
            const list    = await gitOK(path.join(basedir, "active"), [ "worktree", "list", "--porcelain" ], "list worktrees")
            const top     = await git(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory")
            const current = top.failed ? "" : await fs.promises.realpath(top.stdout).catch(() => top.stdout)
            const table   = new Table({
                head:      [ "Directory", "Worktree", "Branch", "Master", "Active", "Current" ],
                colAligns: [ "left", "left", "left", "center", "center", "center" ],
                style:     { head: [ "bold" ], compact: true }
            })
            for (const [ i, block ] of list.split(/\n\n+/).entries()) {
                const dir = block.match(/^worktree (.+)$/m)?.[1]
                if (dir === undefined)
                    continue

                /*  worktree name only for directories located directly under basedir  */
                const wt     = await fs.promises.realpath(dir).catch(() => dir)
                const rel    = path.relative(real, wt)
                const name   = rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep) ? "-" : rel
                const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ??
                    (/^bare$/m.test(block) ? "(bare)" : "(detached)")

                /*  render master worktree (listed first by Git) in bold and active worktree in blue  */
                const isMaster = i === 0
                const isActive = name === active
                let style = (s: string) => s
                if (isMaster && isActive)
                    style = chalk.blue.bold
                else if (isMaster)
                    style = chalk.bold
                else if (isActive)
                    style = chalk.blue
                table.push([ style(dir), style(name), style(branch),
                    style(isMaster ? "X" : ""), style(isActive ? "X" : ""), style(wt === current ? "X" : "") ])
            }
            process.stdout.write(`${table.toString()}\n`)
        })
}

