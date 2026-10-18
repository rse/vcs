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
    info, gitOK, exists, isSymlink
} from "./vcs-util-base.js"
import {
    worktreeDir, setActive
} from "./vcs-util-repo.js"

/*  detect name of the master worktree under a (not yet initialized) basedir:
    the directory the ".git" files of the linked worktrees point into, or (if there
    are no linked worktrees yet) the single directory with a ".git" directory  */
const findMaster = async (basedir: string) => {
    const real    = await fs.promises.realpath(basedir).catch(() => basedir)
    const linked  = new Set<string>()
    const primary = new Set<string>()
    const entries = await fs.promises.readdir(basedir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "active")
            continue
        const dotgit = path.join(basedir, entry.name, ".git")
        const stat   = await fs.promises.stat(dotgit).catch(() => null)
        if (stat === null)
            continue
        if (stat.isDirectory())
            primary.add(entry.name)
        else if (stat.isFile()) {
            const m = (await fs.promises.readFile(dotgit, "utf8")).match(/^gitdir:\s*(.+?)\s*$/m)
            if (m === null)
                continue
            const unresolved = path.resolve(path.join(basedir, entry.name), m[1])
            const gitdir     = await fs.promises.realpath(unresolved).catch(() => unresolved)
            const rel        = path.relative(real, gitdir)
            if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel))
                linked.add(rel.split(path.sep)[0])
        }
    }
    const names = linked.size > 0 ? linked : primary
    if (names.size > 1)
        throw new Error(`ambiguous master worktree under basedir "${basedir}": ` +
            `${[ ...names ].map((n) => `"${n}"`).join(", ")}`)
    return names.size === 0 ? null : [ ...names ][0]
}

/*  command: init  */
export const commandInit = (program: Command) => {
    program.command("init")
        .description("create basedir with a clone of a Git repository in a master worktree (or take existing master worktree)")
        .option("-d, --basedir <basedir>", "base directory", ".")
        .option("-r, --repo <repo-url>", "URL of the Git repository to clone (required if no master worktree exists)")
        .action(async (opts: { basedir: string, repo?: string }) => {
            const basedir = path.resolve(opts.basedir)
            const master  = await findMaster(basedir)
            if (await isSymlink(path.join(basedir, "active")))
                throw new Error(`basedir "${basedir}" is already initialized`)
            if (master !== null && opts.repo !== undefined)
                throw new Error(`option "--repo" not applicable, as master worktree "${master}" already exists`)
            if (master !== null) {
                /*  take existing master worktree as is  */
                await setActive(basedir, master)
                info(`basedir "${basedir}" initialized with existing master worktree "${master}"`)
            }
            else {
                if (opts.repo === undefined)
                    throw new Error("option \"--repo\" is required, as no master worktree exists")

                /*  clone into master worktree named after the default branch of the repository  */
                await fs.promises.mkdir(basedir, { recursive: true })
                const head = await gitOK(basedir, [ "ls-remote", "--symref", "--", opts.repo, "HEAD" ], "determine the default branch of the repository")
                const name = head.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)?.[1] ?? "master"
                const dir  = await worktreeDir(basedir, name, false)
                if (await exists(dir))
                    throw new Error(`directory "${dir}" already exists`)
                await gitOK(basedir, [ "clone", "--quiet", "--", opts.repo, name ], "clone the repository into the master worktree")
                await setActive(basedir, name)
                info(`basedir "${basedir}" initialized with clone of "${opts.repo}" in master worktree "${name}"`)
            }
        })
}

