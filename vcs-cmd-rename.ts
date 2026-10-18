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
    findBasedir, worktreeDir, masterName, setActive,
    currentBranch, operation
} from "./vcs-util-repo.js"

/*  command: rename  */
export const commandRename = (program: Command) => {
    program.command("rename")
        .description("rename a worktree and its branch")
        .option("-d, --basedir <basedir>", "base directory")
        .argument("<worktree-old>", "worktree to rename")
        .argument("<worktree-new>", "new name of worktree")
        .action(async (oldName: string, newName: string, opts: { basedir?: string }) => {
            const basedir = await findBasedir(opts.basedir)
            const name    = await masterName(basedir)
            if (oldName === name)
                throw new Error(`master worktree "${name}" cannot be renamed`)
            if (newName === name)
                throw new Error(`worktree name "${name}" is reserved for master worktree`)
            const oldDir = await worktreeDir(basedir, oldName)
            const newDir = await worktreeDir(basedir, newName, false)
            if (await exists(newDir))
                throw new Error(`directory "${newDir}" already exists`)
            const master = path.join(basedir, name)
            const branch = await currentBranch(oldDir)
            const op     = await operation(oldDir)
            if (op !== "none")
                throw new Error(`worktree "${oldDir}" has an in-progress ${op} operation`)

            /*  rename branch only if named after the worktree (not explicitly chosen on fork)  */
            const newBranch = branch === oldName ? newName : branch
            if (newBranch !== branch && !(await git(master, [ "rev-parse", "--verify", "--quiet", `refs/heads/${newBranch}` ], "check for the existence of the new branch")).failed)
                throw new Error(`branch "${newBranch}" already exists`)

            /*  repair references of a manually moved worktree and move worktree directory (Git updates its references)  */
            await gitOK(master, [ "worktree", "repair", oldDir ], "repair the references of the worktree")
            await gitOK(master, [ "worktree", "move", oldDir, newDir ], "move the worktree")

            /*  rename administrative directory of worktree (paths inside it are sibling-relative or absolute and stay valid)  */
            const dotgit = path.join(newDir, ".git")
            const m      = (await fs.promises.readFile(dotgit, "utf8")).match(/^gitdir:\s*(.+?)\s*$/m)
            if (m !== null && path.basename(m[1]) === oldName) {
                const oldAdmin = path.resolve(newDir, m[1])
                const newAdmin = path.join(path.dirname(oldAdmin), newName)
                if (!(await exists(newAdmin))) {
                    await fs.promises.rename(oldAdmin, newAdmin)
                    await fs.promises.writeFile(dotgit, `gitdir: ${path.join(path.dirname(m[1]), newName)}\n`, "utf8")
                }
            }

            /*  rename branch (Git moves its config section) and re-point child branches  */
            if (newBranch !== branch) {
                await gitOK(newDir, [ "branch", "-m", branch, newBranch ], "rename the branch")
                const children = await git(master, [ "config", "--get-regexp", "^branch\\..+\\.vcsparent$" ], "list the recorded parent branches")
                for (const line of children.failed ? [] : children.stdout.split("\n")) {
                    const c = line.match(/^(branch\..+\.vcsparent) (.*)$/i)
                    if (c !== null && c[2] === branch)
                        await gitOK(master, [ "config", c[1], newBranch ], "re-point the recorded parent branch of a child branch")
                }
            }

            /*  re-point "active" symlink  */
            if ((await fs.promises.readlink(path.join(basedir, "active"))) === oldName)
                await setActive(basedir, newName)
            info(`worktree "${oldName}" (branch "${branch}") renamed to "${newName}" (branch "${newBranch}")`)
        })
}

