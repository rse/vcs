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
    info, git, gitOK, exists, quote
} from "./vcs-util-base.js"
import {
    findBasedir, worktreeDir, masterName, currentBranch, parentBranch, branchDir,
    operation
} from "./vcs-util-repo.js"
import {
    type Resolution,
    report
} from "./vcs-util-resolve.js"
import {
    rebase, stashPush, stashPop
} from "./vcs-util-sync.js"

/*  determine configured upstream branch of a branch (or null)  */
const upstreamBranch = async (dir: string, branch: string) => {
    const format = "--format=%(upstream)%00%(upstream:short)%00%(upstream:remotename)"
    const result = await gitOK(dir, [ "for-each-ref", format, `refs/heads/${branch}` ], "determine the upstream branch")
    const [ ref = "", name = "", remote = "" ] = result.split("\0")
    return ref === "" ? null : { ref, name, remote }
}

/*  fast-forward a local branch to its "origin" counterpart  */
const refreshBranch = async (dir: string, branch: string) => {
    if ((await git(dir, [ "remote", "get-url", "origin" ], "check for an \"origin\" remote")).failed)
        return
    await gitOK(dir, [ "fetch", "--quiet", "origin" ], "fetch changes from \"origin\"")
    const remote = `refs/remotes/origin/${branch}`
    const counts = await git(dir, [ "rev-list", "--left-right", "--count", `refs/heads/${branch}...${remote}` ],
        "count the commits the branch is ahead of and behind the remote-tracking branch")
    if (counts.failed)
        return
    const [ ahead, behind ] = counts.stdout.split("\t").map(Number)
    if (behind === 0)
        return
    if (ahead > 0) {
        info(`branch "${branch}" diverged from "origin/${branch}" -- not fast-forwarded`)
        return
    }
    const bdir = await branchDir(dir, branch)
    if (bdir !== "")
        await gitOK(bdir, [ "merge", "--quiet", "--ff-only", remote ], "fast-forward the checked-out branch")
    else
        await gitOK(dir, [ "update-ref", `refs/heads/${branch}`, remote ], "fast-forward the not checked-out branch")
}

/*  output hints on the expected next steps after escalated conflicts
    of the rebase or of the restoration of the stashed changes  */
const hintNextSteps = async (res: Resolution, mode: "rebase" | "stash", stashed: boolean) => {
    const files = [ ...new Map(res.escalations.map((e) => [ e.file, e.kind ])) ]
    const list  = files.map(([ file ]) => quote(file)).join(" ")
    const steps: [ string, ...string[] ][] = []
    if (mode === "rebase")
        steps.push([ "inspect the changes of the replayed commit", `git show REBASE_HEAD -- ${list}` ])
    else
        steps.push([ "inspect the stashed changes", `git diff stash@{0}^1 stash@{0} -- ${list}` ])
    for (const [ file, kind ] of files) {
        const f = quote(file)
        if (kind === "modify/delete")
            steps.push([ `keep or delete "${file}"`,
                `git add -- ${f}  # keep`,
                `git rm -- ${f}   # delete` ])
        else if (kind === "binary")
            steps.push([ `take one side of "${file}"`,
                `git checkout --ours -- ${f} && git add -- ${f}    # take ours`,
                `git checkout --theirs -- ${f} && git add -- ${f}  # take theirs` ])
        else if (kind === "content")
            steps.push([ `edit the conflict markers in "${file}" and stage it`, `git add -- ${f}` ])
        else
            steps.push([ `resolve "${file}" (${kind}) and stage it`, `git add -- ${f}` ])
    }
    if (mode === "rebase") {
        steps.push([ "continue the rebase", "git rebase --continue" ])
        steps.push([ "resolve further conflicts of the continued rebase (if any)", "vcs resolve" ])
        if (stashed)
            steps.push([ "restore the stashed changes", "git stash pop" ])
    }
    else {
        steps.push([ "unstage the restored changes", "git reset" ])
        steps.push([ "drop the stash kept on conflicts", "git stash drop" ])
    }
    if (res.backupDir !== "" && (await exists(res.backupDir)))
        steps.push([ "remove the backups", `rm -rf ${quote(res.backupDir)}` ])
    info("next steps:")
    steps.forEach(([ what, ...cmds ], i) => {
        info(`  ${i + 1}. ${what}:`)
        for (const cmd of cmds)
            info(`     ${chalk.blue(`$ ${cmd}`)}`)
    })
    if (mode === "rebase") {
        info("  or abandon the synchronization instead:")
        info(`     ${chalk.blue(`$ git rebase --abort${stashed ? " && git stash pop" : ""}`)}`)
    }
}

/*  command: sync  */
export const commandSync = (program: Command) => {
    program.command("sync")
        .description("rebase a worktree onto its (refreshed) parent branch")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("[worktree]", "worktree to synchronize (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string, safe: boolean }) => {
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const dir     = await worktreeDir(basedir, worktree)
            const branch  = await currentBranch(dir)
            const op      = await operation(dir)
            if (op !== "none")
                throw new Error(`worktree "${dir}" has an in-progress ${op} operation`)

            /*  refresh parent branch (default: branch of master worktree), or
                (for the master worktree itself) fetch the upstream branch instead  */
            let parent = await parentBranch(dir, branch).catch(async () => currentBranch(path.join(basedir, await masterName(basedir))))
            let target = `parent branch "${parent}"`
            if (parent !== branch)
                await refreshBranch(dir, parent)
            else {
                const upstream = await upstreamBranch(dir, branch)
                if (upstream === null)
                    throw new Error(`neither parent nor upstream branch recorded for branch "${branch}"`)
                if (upstream.remote !== "" && upstream.remote !== ".")
                    await gitOK(dir, [ "fetch", "--quiet", upstream.remote ], `fetch changes from "${upstream.remote}"`)
                parent = upstream.ref
                target = `upstream branch "${upstream.name}"`
            }

            /*  short-circuit processing if already up-to-date  */
            if (!(await git(dir, [ "merge-base", "--is-ancestor", parent, "HEAD" ], "check whether the parent branch is already contained")).failed) {
                info(`worktree "${worktree}" already up-to-date with ${target}`)
                return
            }

            /*  stash uncommitted changes (including untracked files)  */
            const stashed   = await stashPush(dir, "vcs sync", parent)
            const stashNote = stashed ? " -- afterwards, run \"git stash pop\" to restore the stashed changes" : ""

            /*  rebase onto parent branch  */
            const res = await rebase(dir, parent, opts.safe).catch(async (err: unknown) => {
                if (stashed && (await operation(dir)) === "none")
                    await gitOK(dir, [ "stash", "pop", "--quiet" ], "restore the stashed changes after failure")
                else if (stashed)
                    info(`uncommitted changes remain stashed${stashNote}`)
                throw err
            })
            if (res !== null && res.verdict === "PARTIAL") {
                await report(res)
                info("rebase left in progress with escalated conflicts to be resolved manually")
                await hintNextSteps(res, "rebase", stashed)
                process.exitCode = 1
                return
            }

            /*  restore stashed changes, resolving conflicts  */
            const pres = stashed ? await stashPop(dir, opts.safe) : null
            if (pres !== null) {
                await report(pres)
                info("stashed changes restored with escalated conflicts to be resolved manually")
                await hintNextSteps(pres, "stash", stashed)
                process.exitCode = 1
                return
            }
            info(`worktree "${worktree}" synchronized onto ${target}`)
        })
}

