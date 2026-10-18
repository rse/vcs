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
    info, git, gitOK, exists
} from "./vcs-util-base.js"
import {
    findBasedir, worktreeDir, masterName, parentBranch, branchDir
} from "./vcs-util-repo.js"

/*  command: checkout  */
export const commandCheckout = (program: Command) => {
    program.command("checkout")
        .description("create a worktree for an existing branch")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-b, --branch <branch>", "existing branch to check out (default: <worktree>)")
        .argument("<worktree>", "worktree to create")
        .argument("[parent-branch]", "parent branch to record (default: already recorded parent branch)")
        .action(async (worktree: string, parent: string | undefined, opts: { basedir?: string, branch?: string }) => {
            const basedir = await findBasedir(opts.basedir)
            const name    = await masterName(basedir)
            if (worktree === name)
                throw new Error(`worktree name "${name}" is reserved for master worktree`)
            const dir = await worktreeDir(basedir, worktree, false)
            if (await exists(dir))
                throw new Error(`directory "${dir}" already exists`)
            const master = path.join(basedir, name)
            const branch = opts.branch ?? worktree
            if ((await git(master, [ "rev-parse", "--verify", "--quiet", `refs/heads/${branch}` ], "check for the existence of the branch")).failed)
                throw new Error(`branch "${branch}" does not exist (use "fork" to create it)`)
            if (parent !== undefined) {
                if (parent === branch)
                    throw new Error(`branch "${branch}" cannot be its own parent branch`)
                if ((await git(master, [ "rev-parse", "--verify", "--quiet", `refs/heads/${parent}` ], "check for the existence of the parent branch")).failed)
                    throw new Error(`parent branch "${parent}" does not exist`)
            }

            /*  drop stale references of manually removed worktree directories and ensure the branch is free  */
            await gitOK(master, [ "worktree", "prune" ], "prune the references of missing worktrees")
            const other = await branchDir(master, branch)
            if (other !== "")
                throw new Error(`branch "${branch}" is already checked out in worktree "${other}"`)

            /*  create worktree and record or reuse parent branch  */
            await gitOK(master, [ "worktree", "add", "--quiet", dir, branch ], "create the worktree for the existing branch")
            if (parent !== undefined)
                await gitOK(master, [ "config", `branch.${branch}.vcsParent`, parent ], "record the parent branch")
            else
                parent = await parentBranch(master, branch).catch(() => undefined)
            info(`worktree "${worktree}" created for existing branch "${branch}" ` +
                (parent !== undefined ? `(parent branch "${parent}")` : "(no parent branch recorded)"))
        })
}

