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
    findBasedir, worktreeDir, masterName, currentBranch
} from "./vcs-util-repo.js"

/*  command: fork  */
export const commandFork = (program: Command) => {
    program.command("fork")
        .description("create a worktree with a branch based on a parent branch")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-b, --branch <branch>", "branch to create (default: <worktree>)")
        .argument("<worktree>", "worktree to create")
        .argument("[parent-branch]", "parent branch (default: branch of active worktree)")
        .action(async (worktree: string, parent: string | undefined, opts: { basedir?: string, branch?: string }) => {
            const basedir = await findBasedir(opts.basedir)
            const name    = await masterName(basedir)
            if (worktree === name)
                throw new Error(`worktree name "${name}" is reserved for master worktree`)
            const dir = await worktreeDir(basedir, worktree, false)
            if (await exists(dir))
                throw new Error(`directory "${dir}" already exists`)
            const master = path.join(basedir, name)
            if (parent === undefined)
                parent = await currentBranch(await fs.promises.realpath(path.join(basedir, "active")))
            if ((await git(master, [ "rev-parse", "--verify", "--quiet", `refs/heads/${parent}` ], "check for the existence of the parent branch")).failed)
                throw new Error(`parent branch "${parent}" does not exist`)
            const branch = opts.branch ?? worktree
            await gitOK(master, [ "worktree", "add", "--quiet", "-b", branch, dir, parent ], "create the worktree with a new branch")
            await gitOK(master, [ "config", `branch.${branch}.vcs-parent`, parent ], "record the parent branch")
            info(`worktree "${worktree}" created with branch "${branch}" (parent branch "${parent}")`)
        })
}

