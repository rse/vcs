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
    info, git, gitOK
} from "./vcs-util-base.js"
import {
    findBasedir, worktreeDir, masterName, setActive,
    currentBranch, parentBranch, operation
} from "./vcs-util-repo.js"

/*  ensure a worktree has neither uncommitted changes nor an in-progress operation  */
const ensureClean = async (dir: string) => {
    if ((await gitOK(dir, [ "status", "--porcelain" ], "check for uncommitted changes")) !== "")
        throw new Error(`worktree "${dir}" has uncommitted changes`)
    const op = await operation(dir)
    if (op !== "none")
        throw new Error(`worktree "${dir}" has an in-progress ${op} operation`)
}

/*  command: destroy  */
export const commandDestroy = (program: Command) => {
    program.command("destroy")
        .description("remove a worktree and its branch")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-f, --force", "destroy even with uncommitted changes or a not landed branch")
        .argument("<worktree>", "worktree to destroy")
        .action(async (worktree: string, opts: { basedir?: string, force?: boolean }) => {
            const basedir = await findBasedir(opts.basedir)
            const name    = await masterName(basedir)
            if (worktree === name)
                throw new Error(`master worktree "${name}" cannot be destroyed`)
            const dir    = await worktreeDir(basedir, worktree)
            const master = path.join(basedir, name)
            const branch = await currentBranch(dir)
            const parent = await parentBranch(dir, branch).catch(() => currentBranch(master))
            if (!opts.force)
                await ensureClean(dir)

            /*  ensure the branch landed on its parent branch (by merge, rebase, or squash),
                where a squash is detected by the branch tip recorded by "merge" (as its
                conflict resolutions cannot be reproduced) or by an idempotent re-merge  */
            if (!opts.force && (await git(master, [ "merge-base", "--is-ancestor", branch, parent ], "check whether the branch is contained in the parent branch")).failed) {
                const squashed = await git(master, [ "config", "--get", `branch.${branch}.vcs-squashed` ], "determine the recorded squashed branch tip")
                const tip      = await gitOK(master, [ "rev-parse", branch ], "determine the tip of the branch")
                if (squashed.failed || squashed.stdout !== tip) {
                    const tree  = await git(master, [ "merge-tree", "--write-tree", parent, branch ], "determine the tree of a merge of the branch into the parent branch")
                    const ptree = await gitOK(master, [ "rev-parse", `${parent}^{tree}` ], "determine the tree of the parent branch")
                    if (tree.failed || tree.stdout.split("\n")[0] !== ptree)
                        throw new Error(`branch "${branch}" is not merged into parent branch "${parent}"`)
                }
            }

            /*  remove worktree and branch (from within the master worktree, as
                the current directory might be inside the removed worktree)  */
            if ((await fs.promises.readlink(path.join(basedir, "active"))) === worktree)
                await setActive(basedir, name)
            process.chdir(master)
            await gitOK(master, [ "worktree", "remove", ...(opts.force ? [ "--force" ] : []), dir ], "remove the worktree")
            await gitOK(master, [ "branch", "--quiet", "-D", branch ], "delete the branch")
            info(`worktree "${worktree}" and branch "${branch}" destroyed`)
        })
}

