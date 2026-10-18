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

/*  own requirements  */
import {
    gitOK, exists
} from "./vcs-util-base.js"

/*  type definitions  */
export type Conflict   = { file: string, kind: "content" | "binary" | "submodule" | "rename" | "modify/delete" | "delete/delete" }
export type Escalation = { file: string, lines: string, kind: string, ours: string, theirs: string, reason: string }

/*  check for conflict markers in a file  */
export const hasMarkers = (file: string) =>
    fs.promises.readFile(file, "utf8").then((data) => /^(<{7}|\|{7}|>{7})( |$)/m.test(data), () => false)

/*  determine and classify the unmerged files of a worktree  */
export const classifyConflicts = async (root: string) => {
    const conflicts: Conflict[] = []
    const status = await gitOK(root, [ "-c", "core.quotepath=off", "status", "--porcelain=v1", "-z" ], "list the status of all files")
    for (const entry of status.split("\0")) {
        const m = entry.match(/^(UU|AA|UD|DU|AU|UA|DD) (.+)$/)
        if (m === null)
            continue
        const [ , code, file ] = m
        let kind: Conflict["kind"]
        if (code === "DD")
            kind = "delete/delete"
        else if (code === "UD" || code === "DU")
            kind = "modify/delete"
        else if (code === "AU" || code === "UA")
            kind = "rename"
        else if (/^160000 /m.test(await gitOK(root, [ "ls-files", "-u", "--", file ], "check whether the unmerged file is a submodule")))
            kind = "submodule"
        else
            kind = (await hasMarkers(path.join(root, file))) ? "content" : "binary"
        conflicts.push({ file, kind })
    }
    return conflicts
}

/*  back up conflicted files (never overwriting the more original state of an earlier run)  */
export const backupFiles = async (root: string, backupDir: string, conflicts: Conflict[]) => {
    for (const c of conflicts) {
        const src = path.join(root, c.file)
        const dst = path.join(backupDir, c.file)
        if ((await exists(src)) && !(await exists(dst))) {
            await fs.promises.mkdir(path.dirname(dst), { recursive: true })
            await fs.promises.copyFile(src, dst)
        }
    }
}

/*  determine the side which changed an unmerged file the other side left unchanged  */
export const changedSide = async (root: string, file: string) => {
    const stages: Record<string, { mode: string, oid: string }> = {}
    for (const line of (await gitOK(root, [ "ls-files", "-u", "--", file ], "list the stages of the unmerged file")).split("\n")) {
        const m = line.match(/^(\d+) ([0-9a-f]+) ([123])\t/)
        if (m !== null)
            stages[m[3]] = { mode: m[1], oid: m[2] }
    }
    const base = stages["1"]?.oid
    if (base !== undefined && stages["2"]?.oid === base && stages["3"] !== undefined)
        return { ...stages["3"], flag: "--theirs" }
    if (base !== undefined && stages["3"]?.oid === base && stages["2"] !== undefined)
        return { ...stages["2"], flag: "--ours" }
    return undefined
}

