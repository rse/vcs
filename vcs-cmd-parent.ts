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
    info, git, gitOK
} from "./vcs-util-base.js"
import {
    findBasedir, worktreeDir, masterName, currentBranch, parentBranch
} from "./vcs-util-repo.js"

/*  command: parent  */
export const commandParent = (program: Command) => {
    program.command("parent")
        .description("show or record the parent branch of a worktree")
        .option("-d, --basedir <basedir>", "base directory")
        .argument("<worktree>", "worktree to show or record the parent branch for")
        .argument("[parent-branch]", "parent branch to record (default: show recorded parent branch)")
        .action(async (worktree: string, parent: string | undefined, opts: { basedir?: string }) => {
            const basedir = await findBasedir(opts.basedir)
            const name    = await masterName(basedir)
            if (worktree === name)
                throw new Error(`master worktree "${name}" has no parent branch`)
            const dir    = await worktreeDir(basedir, worktree)
            const master = path.join(basedir, name)
            const branch = await currentBranch(dir)

            /*  show recorded parent branch (default: branch of master worktree)  */
            if (parent === undefined) {
                parent = await parentBranch(master, branch).catch(() => undefined)
                info(`worktree "${worktree}" (branch "${branch}") ` +
                    (parent !== undefined ? `has parent branch "${parent}"` :
                        `has no parent branch recorded, defaulting to master branch "${await currentBranch(master)}"`))
                return
            }

            /*  record parent branch (and drop legacy key "vcsParent" of vcs <= 0.9.6)  */
            if (parent === branch)
                throw new Error(`branch "${branch}" cannot be its own parent branch`)
            if ((await git(master, [ "rev-parse", "--verify", "--quiet", `refs/heads/${parent}` ], "check for the existence of the parent branch")).failed)
                throw new Error(`parent branch "${parent}" does not exist`)
            await gitOK(master, [ "config", `branch.${branch}.vcs-parent`, parent ], "record the parent branch")
            await git(master, [ "config", "--unset", `branch.${branch}.vcsParent` ], "remove the legacy recorded parent branch")
            info(`worktree "${worktree}" (branch "${branch}") recorded with parent branch "${parent}"`)
        })
}

