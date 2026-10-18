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
import chalk               from "chalk"

/*  own requirements  */
import {
    info, git, gitOK, exists
} from "./vcs-util-base.js"
import {
    type Operation,
    theirsRefs, operation, hasUnmerged
} from "./vcs-util-repo.js"
import {
    type Conflict, type Escalation,
    hasMarkers, classifyConflicts, backupFiles, changedSide
} from "./vcs-util-conflict.js"
import {
    aiResolve
} from "./vcs-util-claude.js"

/*  type definitions  */
type Verdict    = "NONE" | "RESOLVED" | "PARTIAL"
export type Resolution = { verdict: Verdict, operation: Operation, escalations: Escalation[], backupDir: string }

/*  resolve the conflicts of the in-progress operation of a worktree  */
export const resolveConflicts = async (dir: string, safe: boolean): Promise<Resolution> => {
    const root   = await gitOK(dir, [ "rev-parse", "--show-toplevel" ], "determine the root directory of the worktree")
    const gitDir = await gitOK(dir, [ "rev-parse", "--absolute-git-dir" ], "determine the Git directory of the worktree")
    const op     = await operation(root)
    let theirs   = theirsRefs.find(([ , o ]) => o === op)?.[0] ?? ""
    const other  = theirs !== "" ? await git(root, [ "rev-parse", "--verify", "--quiet", theirs ], "determine the commit of the other side") : null
    const oid    = other !== null && !other.failed ? other.stdout : ""
    if (oid === "")
        theirs = ""

    /*  determine and classify unmerged files  */
    const conflicts = await classifyConflicts(root)

    /*  short-circuit processing if nothing is to be resolved  */
    const head      = await gitOK(root, [ "rev-parse", "HEAD" ], "determine the current commit")
    const backupDir = path.join(gitDir, "vcs-resolve", `${head}-${oid !== "" ? oid : "none"}`)
    if (conflicts.length === 0)
        return { verdict: "NONE", operation: op, escalations: [], backupDir }

    /*  back up files  */
    await backupFiles(root, backupDir, conflicts)

    /*  resolve non-content conflicts deterministically and collect the remaining ones  */
    const escalations: Escalation[] = []
    const escalate = (c: Conflict, reason: string) =>
        escalations.push({ file: c.file, lines: "*", kind: c.kind, ours: "", theirs: "", reason })
    const toStage: string[] = []
    const toAI: Conflict[] = []
    for (const c of conflicts) {
        if (c.kind === "content")
            toAI.push(c)
        else if (safe)
            escalate(c, "non-content conflict not touched in safe mode")
        else if (c.kind === "delete/delete")
            await gitOK(root, [ "rm", "--quiet", "--", c.file ], "remove the file deleted on both sides")
        else if (c.kind === "binary" || c.kind === "submodule") {
            /*  take the changed side if the other side left it unchanged  */
            const side = await changedSide(root, c.file)
            if (side === undefined)
                escalate(c, "both sides changed differently")
            else if (c.kind === "submodule")
                await gitOK(root, [ "update-index", "--cacheinfo", `${side.mode},${side.oid},${c.file}` ], "take the submodule commit of the changed side")
            else {
                await gitOK(root, [ "checkout", side.flag, "--", c.file ], "take the file of the changed side")
                toStage.push(c.file)
            }
        }
        else
            toAI.push(c)
    }

    /*  resolve remaining conflicts semantically via Claude  */
    if (toAI.length > 0) {
        info(`resolving ${toAI.length} conflicted file(s) via Claude`)
        for (const c of toAI)
            info(`${chalk.blue("▶")} ${c.file} (${c.kind})`)
        const result = await aiResolve(root, backupDir, op, theirs, toAI, safe)
        if (result === null) {
            /*  restore all files from their backups  */
            for (const c of toAI) {
                const backup = path.join(backupDir, c.file)
                if (await exists(backup))
                    await fs.promises.copyFile(backup, path.join(root, c.file))
                escalate(c, "AI resolution failed")
            }
        }
        else {
            for (const c of toAI) {
                const file = path.join(root, c.file)
                const r    = result.files.find((f) => f.file === c.file)
                if (r === undefined)
                    escalate(c, "no resolution reported")
                else if (r.escalations.length > 0)
                    escalations.push(...r.escalations)
                else if (!r.resolved)
                    escalate(c, "not resolved")
                else if (r.remove && c.kind !== "content")
                    await gitOK(root, [ "rm", "--quiet", "--ignore-unmatch", "--", c.file ], "remove the file moved away by the AI resolution")
                else if (!(await exists(file)))
                    escalate(c, "resolved file is missing")
                else if (await hasMarkers(file))
                    escalate(c, "leftover conflict markers")
                else
                    toStage.push(c.file)
            }
            for (const file of result.touched) {
                const abs = path.resolve(root, file)
                const rel = path.relative(root, abs)
                if (!abs.startsWith(root + path.sep) || toAI.some((c) => c.file === rel))
                    continue
                if ((await exists(abs)) && !(await hasMarkers(abs)))
                    toStage.push(rel)
            }
        }
    }

    /*  stage fully resolved files  */
    if (toStage.length > 0)
        await gitOK(root, [ "add", "--", ...toStage ], "stage the resolved files")

    /*  determine verdict (keeping backups in case of escalations)  */
    if (escalations.length === 0) {
        await fs.promises.rm(backupDir, { recursive: true, force: true })
        return { verdict: "RESOLVED", operation: op, escalations, backupDir: "" }
    }
    return { verdict: "PARTIAL", operation: op, escalations, backupDir }
}

/*  resolve conflicts and continue the in-progress operation
    (repeatedly, as a rebase can stop at the next conflicting commit)  */
export const resolveAndContinue = async (dir: string, safe: boolean): Promise<Resolution> => {
    for (;;) {
        const res = await resolveConflicts(dir, safe)
        if (res.verdict !== "RESOLVED" || res.operation === "none")
            return res
        const result = await git(dir, [ "-c", "core.editor=true", res.operation, "--continue" ], "continue the in-progress operation")
        if (!result.failed)
            return res
        if (!(await hasUnmerged(dir)))
            throw new Error(`failed to continue ${res.operation}: ${(result.stderr || result.stdout).trim()}`)
        info(`${res.operation} continued -- resolving next conflicts`)
    }
}

/*  report the escalated conflicts  */
export const report = async (res: Resolution) => {
    for (const e of res.escalations) {
        process.stderr.write(`${chalk.yellow("▶")} ${e.file}:${e.lines} (${e.kind}): ${e.reason}\n`)
        if (e.ours !== "")
            process.stderr.write(`    ${chalk.grey("ours:")}   ${e.ours}\n`)
        if (e.theirs !== "")
            process.stderr.write(`    ${chalk.grey("theirs:")} ${e.theirs}\n`)
    }
    if (res.escalations.length > 0 && res.backupDir !== "" && (await exists(res.backupDir)))
        process.stderr.write(`    ${chalk.grey("backups:")} ${res.backupDir}\n`)
}

