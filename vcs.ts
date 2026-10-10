#!/usr/bin/env node
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
import { Command, Option } from "commander"
import { execa }           from "execa"
import chalk               from "chalk"
import Table               from "cli-table3"

/*  type definitions  */
type Operation  = "merge" | "rebase" | "cherry-pick" | "revert" | "none"
type Verdict    = "NONE" | "RESOLVED" | "PARTIAL"
type Conflict   = { file: string, kind: "content" | "binary" | "submodule" | "rename" | "modify/delete" | "delete/delete" }
type Escalation = { file: string, lines: string, kind: string, ours: string, theirs: string, reason: string }
type Resolution = { verdict: Verdict, operation: Operation, escalations: Escalation[], backupDir: string }
type AIResult   = {
    files:   { file: string, resolved: boolean, remove: boolean, escalations: Escalation[] }[],
    touched: string[]
}

/*  verbosity level (0: information only, 1: additionally commands and Claude actions, 2: additionally comments)  */
let verbose = 0

/*  output information  */
const info = (msg: string) => {
    process.stderr.write(`${chalk.blue("vcs:")} ${msg}\n`)
}

/*  output a command (preceded by its comment) to be executed  */
const trace = (cmd: string, args: string[], what: string, env: Record<string, string> = {}) => {
    if (verbose >= 2)
        process.stderr.write(`# ${what}\n`)
    if (verbose >= 1) {
        const quote = (arg: string) => /^[A-Za-z0-9_.,:/@=+%^{}-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`
        const vars  = Object.entries(env).map(([ k, v ]) => `${k}=${quote(v)}`)
        process.stderr.write(`${chalk.blue(`$ ${[ ...vars, ...[ cmd, ...args ].map(quote) ].join(" ")}`)}\n`)
    }
}

/*  execute a Git command (without and with failing on errors)  */
const git = (dir: string, args: string[], what: string, env: Record<string, string> = {}) => {
    trace("git", [ "-C", dir, ...args ], what, env)
    return execa("git", [ "-C", dir, ...args ], { reject: false, stdin: "ignore", env })
}
const gitOK = async (dir: string, args: string[], what: string, env: Record<string, string> = {}) => {
    const result = await git(dir, args, what, env)
    if (result.failed)
        throw new Error(`command "git ${args.join(" ")}" failed: ${(result.stderr || result.stdout).trim()}`)
    return result.stdout
}

/*  check for existing path  */
const exists = (p: string) =>
    fs.promises.access(p).then(() => true, () => false)

/*  check for symbolic link  */
const isSymlink = (p: string) =>
    fs.promises.lstat(p).then((stat) => stat.isSymbolicLink(), () => false)

/*  determine basedir (explicitly given or auto-detected from CWD upwards)  */
const findBasedir = async (basedir?: string) => {
    if (basedir !== undefined) {
        basedir = path.resolve(basedir)
        if (!(await isSymlink(path.join(basedir, "active"))))
            throw new Error(`no "active" symlink found in basedir "${basedir}"`)
        return basedir
    }
    let dir = process.cwd()
    while (!(await isSymlink(path.join(dir, "active")))) {
        const parent = path.dirname(dir)
        if (parent === dir)
            throw new Error("no basedir found (no \"active\" symlink in current or any parent directory)")
        dir = parent
    }
    return dir
}

/*  determine directory of a worktree under basedir  */
const worktreeDir = async (basedir: string, name: string, mustExist = true) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "active")
        throw new Error(`invalid worktree name "${name}"`)
    const dir = path.join(basedir, name)
    if (mustExist && !(await exists(path.join(dir, ".git"))))
        throw new Error(`no worktree "${name}" found under basedir "${basedir}"`)
    return dir
}

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

/*  determine name of the master worktree under an initialized basedir
    (Git always lists the main worktree first)  */
const masterName = async (basedir: string) => {
    const list = await gitOK(path.join(basedir, "active"), [ "worktree", "list", "--porcelain" ], "list worktrees to determine the master worktree")
    const main = list.match(/^worktree (.+)$/m)?.[1]
    if (main === undefined)
        throw new Error(`no master worktree found under basedir "${basedir}"`)
    const rel = path.relative(await fs.promises.realpath(basedir), await fs.promises.realpath(main))
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep))
        throw new Error(`master worktree "${main}" not located directly under basedir "${basedir}"`)
    return rel
}

/*  atomically re-point the "active" symlink  */
const setActive = async (basedir: string, name: string) => {
    const tmp = path.join(basedir, `.active.${process.pid}`)
    await fs.promises.symlink(name, tmp)
    await fs.promises.rename(tmp, path.join(basedir, "active")).catch(async (err: unknown) => {
        await fs.promises.rm(tmp, { force: true })
        throw err
    })
}

/*  determine checked-out branch of a worktree  */
const currentBranch = async (dir: string) => {
    const branch = await gitOK(dir, [ "branch", "--show-current" ], "determine the checked-out branch")
    if (branch === "")
        throw new Error(`worktree "${dir}" has no checked-out branch (detached HEAD)`)
    return branch
}

/*  determine recorded parent branch of a branch  */
const parentBranch = async (dir: string, branch: string) => {
    const result = await git(dir, [ "config", "--get", `branch.${branch}.vcsParent` ], "determine the recorded parent branch")
    if (result.failed || result.stdout === "")
        throw new Error(`no parent branch recorded for branch "${branch}"`)
    return result.stdout
}

/*  determine configured upstream branch of a branch (or null)  */
const upstreamBranch = async (dir: string, branch: string) => {
    const format = "--format=%(upstream)%00%(upstream:short)%00%(upstream:remotename)"
    const result = await gitOK(dir, [ "for-each-ref", format, `refs/heads/${branch}` ], "determine the upstream branch")
    const [ ref = "", name = "", remote = "" ] = result.split("\0")
    return ref === "" ? null : { ref, name, remote }
}

/*  determine worktree directory where a branch is checked out (or empty)  */
const branchDir = async (dir: string, branch: string) => {
    let worktree = ""
    for (const line of (await gitOK(dir, [ "worktree", "list", "--porcelain" ], "list worktrees to find where the branch is checked out")).split("\n")) {
        if (line.startsWith("worktree "))
            worktree = line.slice("worktree ".length)
        else if (line === `branch refs/heads/${branch}`)
            return worktree
    }
    return ""
}

/*  determine in-progress Git operation  */
const theirsRefs: [ string, Operation ][] = [
    [ "MERGE_HEAD", "merge" ], [ "REBASE_HEAD", "rebase" ],
    [ "CHERRY_PICK_HEAD", "cherry-pick" ], [ "REVERT_HEAD", "revert" ]
]
const operation = async (dir: string): Promise<Operation> => {
    /*  detect rebase by its state directories only, as Git can leave a stale REBASE_HEAD behind  */
    const states: [ string, Operation ][] = [
        ...theirsRefs.filter(([ , op ]) => op !== "rebase"),
        [ "rebase-merge", "rebase" ], [ "rebase-apply", "rebase" ]
    ]
    const paths = (await gitOK(dir, [ "rev-parse", ...states.flatMap(([ state ]) => [ "--git-path", state ]) ],
        "determine paths of the in-progress operation state files")).split("\n")
    for (const [ i, [ , op ] ] of states.entries())
        if (await exists(path.resolve(dir, paths[i])))
            return op
    return "none"
}

/*  check for unmerged files  */
const hasUnmerged = async (dir: string) =>
    (await gitOK(dir, [ "diff", "--name-only", "--diff-filter=U" ], "list unmerged files")) !== ""

/*  check for conflict markers in a file  */
const hasMarkers = (file: string) =>
    fs.promises.readFile(file, "utf8").then((data) => /^(<{7}|\|{7}|>{7})( |$)/m.test(data), () => false)

/*  ensure a worktree has neither uncommitted changes nor an in-progress operation  */
const ensureClean = async (dir: string) => {
    if ((await gitOK(dir, [ "status", "--porcelain" ], "check for uncommitted changes")) !== "")
        throw new Error(`worktree "${dir}" has uncommitted changes`)
    const op = await operation(dir)
    if (op !== "none")
        throw new Error(`worktree "${dir}" has an in-progress ${op} operation`)
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

/*  JSON schema of the AI resolution result  */
const aiSchema = {
    type: "object",
    properties: {
        files: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    file:        { type: "string" },
                    resolved:    { type: "boolean" },
                    remove:      { type: "boolean" },
                    escalations: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                file:   { type: "string" },
                                lines:  { type: "string" },
                                kind:   { type: "string" },
                                ours:   { type: "string" },
                                theirs: { type: "string" },
                                reason: { type: "string" }
                            },
                            required: [ "file", "lines", "kind", "ours", "theirs", "reason" ]
                        }
                    }
                },
                required: [ "file", "resolved", "remove", "escalations" ]
            }
        },
        touched: { type: "array", items: { type: "string" } }
    },
    required: [ "files", "touched" ]
}

/*  let Claude semantically resolve the conflicted files
    (derived from the ASE "ase-repo-resolve" procedure)  */
const aiResolve = async (root: string, backupDir: string, op: Operation,
    theirs: string, conflicts: Conflict[], safe: boolean): Promise<AIResult | null> => {
    const sides = theirs !== "" ?
        `"ours" is HEAD and "theirs" is ${theirs}.` +
        (op === "rebase" ? " Under rebase, \"ours\" is the upstream the commits are replayed onto " +
            "and \"theirs\" is the replayed commit of the branch being rebased." : "") +
        (op === "revert" ? " Under revert, \"theirs\" is the inverse of the reverted commit." : "") :
        "Derive the sides from the labels of the conflict markers only."
    const prompt = `
You resolve the Git conflicts in the working directory "${root}"
(in-progress operation: ${op}). ${sides}

The overarching rule is: you MUST NEVER lose any change of any side. When in
doubt, a conflict stays EXACTLY as it is and is escalated -- an unresolved
conflict is always acceptable, a silently dropped change NEVER is.

Conflicted files (path and conflict kind):
${conflicts.map((c) => `- "${c.file}" (${c.kind})`).join("\n")}

Unmodified backups of all conflicted files exist below "${backupDir}"
(under the same relative paths). NEVER modify these backups.

Procedure:

1.  Determine the intents of both sides by running "git log --oneline -n 10 HEAD"${theirs !== "" ? `
    and "git log --oneline -n 10 ${theirs}" and "git show --stat ${theirs}"` : ""}.

2.  For every file of kind "content": split it into its conflict hunks, each
    consisting of the "ours" section (after "<<<<<<<"), the optional "base"
    section (after "|||||||"), and the "theirs" section (after "=======", up to
    ">>>>>>>"). If no base section exists, read the base version read-only via
    "git show :1:<file>" (if it exists). NEVER regenerate the markers via
    "git checkout --conflict=..." or "git checkout -m". For every hunk, understand
    WHAT each side changed relative to the base and WHY, and classify it:
    - trivial: both sides identical, differ in whitespace only, or one side
      equals the base -- take the side carrying the change.
    - independent: both sides changed different aspects -- combine both changes,
      ordering additions in a sensible way.
    - compatible: both sides changed the same aspect, but combinable (e.g., one
      side renamed an identifier, the other added a use of it) -- merge both, so
      both intents are honored.
    - unresolvable: both intents contradict each other, or you are not
      confident about a resolution.
    Replace every trivial, independent, and compatible hunk by its resolution
    (removing its conflict markers), but keep every unresolvable hunk VERBATIM
    including its conflict markers. Change NOTHING outside of the conflict hunks,
    except for a consequence of a compatible resolution strictly needed inside
    the same file.

3.  ${safe ?
    "There are no non-content conflicts to resolve." :
    `For every file of kind "modify/delete" or "rename": resolve it only if
    the intent is unambiguous and no change gets lost. If the deleting side
    moved the content (e.g., renamed or split the file), port the modification
    of the other side completely into the new location, list that new location
    in "touched", and set "remove" to true for the old file. If the deletion
    intentionally removed a feature, but the other side modified it, escalate.
    When uncertain, escalate, as keeping the conflict is always safe.`}

4.  Check the change preservation of every resolved hunk: every line which
    "ours" or "theirs" added, removed, or modified relative to the base MUST be
    reflected in the resolution, unless the deviation is justified by the intent
    of the other side. Without a base, every line of both sides MUST be
    reflected. Additionally, compare every resolved file against its backup via
    "git diff --no-index -- <backup> <file>" and verify that nothing changed
    outside of the conflict hunks. If a check fails for a hunk, restore this
    hunk verbatim from the backup (including its conflict markers) and escalate
    it with the reason "change preservation check failed". If the check cannot
    be decided for a file, restore the entire file from its backup and escalate
    all its hunks.

5.  NEVER run "git add", "git rm", "git checkout", "git commit", or any other
    state-changing Git command -- staging and continuing is done by the caller.

6.  Respond with the structured result only: one entry per conflicted file with
    "resolved" (true only if no conflict remains in the file), "remove", and
    "escalations" (one per unresolved hunk or file, each with its file, its line
    range or "*" for the whole file, its conflict kind, a one-line intent of
    "ours", a one-line intent of "theirs", and a one-line reason). Keep all
    texts short.
`
    const args = [
        "-p", prompt,
        "--output-format", "stream-json", "--verbose",
        "--json-schema", JSON.stringify(aiSchema),
        "--tools", "Read,Edit,Write,Bash",
        "--allowedTools", "Read", "Edit", "Write",
        "Bash(git log *)", "Bash(git show *)", "Bash(git diff *)",
        "--permission-mode", "dontAsk",
        "--add-dir", backupDir,
        "--no-session-persistence"
    ]
    trace("claude", args.map((arg, i) => i === 1 ? "<prompt>" : i === 6 ? "<schema>" : arg),
        "semantically resolve the conflicted files via Claude")
    const subprocess = execa("claude", args, { cwd: root, reject: false, stdin: "ignore" })
    let output: AIResult | null = null
    for await (const line of subprocess) {
        if (!line.startsWith("{"))
            continue
        let response: {
            type?:              string,
            is_error?:          boolean,
            structured_output?: AIResult,
            message?:           { content?: { type: string, text?: string, name?: string, input?: Record<string, unknown> }[] }
        }
        try {
            response = JSON.parse(line)
        }
        catch {
            /*  ignore unparsable output lines  */
            continue
        }
        if (response.type === "result" && !response.is_error && response.structured_output)
            output = response.structured_output
        else if (response.type === "assistant") {
            /*  show the actions (and under verbosity level 2 also the comments) of Claude  */
            for (const block of response.message?.content ?? []) {
                if (block.type === "text" && verbose >= 2 && (block.text ?? "").trim() !== "")
                    process.stderr.write((block.text ?? "").trim().split("\n").map((l) => `# ${l}\n`).join(""))
                else if (block.type === "tool_use" && verbose >= 1 && block.name !== "StructuredOutput") {
                    const input  = block.input ?? {}
                    const file   = typeof input.file_path === "string" ? input.file_path : ""
                    const detail = typeof input.command === "string" ? input.command :
                        file !== "" ? (file.startsWith(root + path.sep) ? path.relative(root, file) : file) :
                            JSON.stringify(input)
                    process.stderr.write(`${chalk.red(`claude> ${block.name}: ${detail.replace(/\s*\n\s*/g, " ")}`)}\n`)
                }
            }
        }
    }
    const result = await subprocess
    if (result.failed) {
        info(`Claude invocation failed: ${(result.stderr || result.stdout).trim()}`)
        return null
    }
    return output
}

/*  determine and classify the unmerged files of a worktree  */
const classifyConflicts = async (root: string) => {
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
const backupFiles = async (root: string, backupDir: string, conflicts: Conflict[]) => {
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
const changedSide = async (root: string, file: string) => {
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

/*  resolve the conflicts of the in-progress operation of a worktree  */
const resolveConflicts = async (dir: string, safe: boolean): Promise<Resolution> => {
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
const resolveAndContinue = async (dir: string, safe: boolean): Promise<Resolution> => {
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
const report = async (res: Resolution) => {
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

/*  rebase a worktree onto its parent branch, resolving conflicts  */
const rebase = async (dir: string, parent: string, safe: boolean): Promise<Resolution | null> => {
    const result = await git(dir, [ "rebase", "--quiet", parent ], "rebase onto the parent branch")
    if (!result.failed)
        return null
    if (!(await hasUnmerged(dir))) {
        await git(dir, [ "rebase", "--abort" ], "abort the failed rebase")
        throw new Error(`rebase onto "${parent}" failed: ${(result.stderr || result.stdout).trim()}`)
    }
    return resolveAndContinue(dir, safe)
}

/*  stash uncommitted changes of a worktree (including untracked files)  */
const stashPush = async (dir: string, message: string) => {
    if ((await gitOK(dir, [ "status", "--porcelain" ], "check for uncommitted changes")) === "")
        return false
    await gitOK(dir, [ "stash", "push", "--quiet", "--include-untracked", "--message", message ], "stash the uncommitted changes")
    info(`uncommitted changes of worktree "${path.basename(dir)}" stashed`)
    return true
}

/*  restore stashed changes of a worktree, resolving conflicts
    (returns the resolution in case of escalated conflicts only)  */
const stashPop = async (dir: string, safe: boolean): Promise<Resolution | null> => {
    const result = await git(dir, [ "stash", "pop", "--quiet" ], "restore the stashed changes")
    if (result.failed) {
        if (!(await hasUnmerged(dir)))
            throw new Error(`failed to restore stashed changes of worktree "${path.basename(dir)}" (kept in stash): ` +
                `${(result.stderr || result.stdout).trim()}`)
        const res = await resolveConflicts(dir, safe)
        if (res.verdict === "PARTIAL")
            return res

        /*  unstage restored changes and drop the (on conflicts kept) stash  */
        await gitOK(dir, [ "reset", "--quiet" ], "unstage the restored changes")
        await gitOK(dir, [ "stash", "drop", "--quiet" ], "drop the stash kept on conflicts")
    }
    info(`uncommitted changes of worktree "${path.basename(dir)}" restored`)
    return null
}

/*  snapshot all staged, unstaged, and untracked files of a worktree into a stash-like
    commit (working copy tree, parents HEAD and index), without touching the worktree  */
const snapshot = async (dir: string) => {
    const index = path.resolve(dir, await gitOK(dir, [ "rev-parse", "--git-path", "index" ], "determine the path of the index"))
    const tmp   = `${index}.vcs-shuffle.${process.pid}`
    const wtree = await (async () => {
        if (await exists(index))
            await fs.promises.copyFile(index, tmp)
        await gitOK(dir, [ "add", "--all" ], "add all files to a temporary index", { GIT_INDEX_FILE: tmp })
        return gitOK(dir, [ "write-tree" ], "write the tree of the working copy", { GIT_INDEX_FILE: tmp })
    })().finally(() => fs.promises.rm(tmp, { force: true }))
    const itree   = await gitOK(dir, [ "write-tree" ], "write the tree of the index")
    const head    = await gitOK(dir, [ "rev-parse", "HEAD" ], "determine the current commit")
    const icommit = await gitOK(dir, [ "commit-tree", itree, "-p", head, "-m", "vcs shuffle: index" ], "create the commit of the index")
    return gitOK(dir, [ "commit-tree", wtree, "-p", head, "-p", icommit, "-m", "vcs shuffle: working copy" ], "create the commit of the working copy")
}

/*  clean a worktree to the state of a fresh fork: abort an in-progress operation,
    reset to HEAD, and remove all untracked (and optionally ignored) files  */
const cleanWorktree = async (dir: string, ignored: boolean) => {
    const op = await operation(dir)
    if (op !== "none")
        await gitOK(dir, [ op, "--abort" ], "abort the in-progress operation")
    await gitOK(dir, [ "reset", "--quiet", "--hard", "HEAD" ], "discard the staged and unstaged changes")
    await gitOK(dir, [ "clean", "--quiet", "--force", "-d", ...(ignored ? [ "-x" ] : []) ], "remove the untracked files")
}

;(async () => {
    /*  load my own information  */
    const packageInfo: { description: string, version: string } = JSON.parse(await fs.promises.readFile(new URL("../package.json", import.meta.url), "utf8"))

    /*  command-line option parsing  */
    const program = new Command()
    program
        .name("vcs")
        .description(packageInfo.description)
        .version(packageInfo.version, "-V, --version")
        .showHelpAfterError()

    /*  command: init  */
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

    /*  command: active  */
    program.command("active")
        .description("show the active worktree")
        .option("-d, --basedir <basedir>", "base directory")
        .action(async (opts: { basedir?: string }) => {
            const basedir = await findBasedir(opts.basedir)
            process.stdout.write(`${await fs.promises.readlink(path.join(basedir, "active"))}\n`)
        })

    /*  command: list  */
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

    /*  command: activate  */
    program.command("activate")
        .description("activate a worktree")
        .option("-d, --basedir <basedir>", "base directory")
        .argument("[worktree]", "worktree to activate (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string }) => {
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            await worktreeDir(basedir, worktree)
            await setActive(basedir, worktree)
        })

    /*  command: fork  */
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
            await gitOK(master, [ "config", `branch.${branch}.vcsParent`, parent ], "record the parent branch")
            info(`worktree "${worktree}" created with branch "${branch}" (parent branch "${parent}")`)
        })

    /*  command: sync  */
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

            /*  refresh parent branch, or (without a recorded one, as for
                the master worktree) fetch the upstream branch instead  */
            let parent = await parentBranch(dir, branch).catch(() => "")
            let target = `parent branch "${parent}"`
            if (parent !== "")
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
            const stashed   = await stashPush(dir, "vcs sync")
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
                info("rebase left in progress: resolve the escalated conflicts manually, " +
                    `stage them, and run "git rebase --continue"${stashNote}`)
                process.exitCode = 1
                return
            }

            /*  restore stashed changes, resolving conflicts  */
            const pres = stashed ? await stashPop(dir, opts.safe) : null
            if (pres !== null) {
                await report(pres)
                info("stashed changes restored with conflicts: resolve the escalated conflicts manually, " +
                    "and run \"git reset\" and \"git stash drop\"")
                process.exitCode = 1
                return
            }
            info(`worktree "${worktree}" synchronized onto ${target}`)
        })

    /*  command: merge  */
    program.command("merge")
        .description("merge a worktree into its parent branch")
        .option("-d, --basedir <basedir>", "base directory")
        .addOption(new Option("-m, --mode <mode>", "merge mode").choices([ "merge", "rebase", "squash" ]).default("rebase"))
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("[worktree]", "worktree to merge (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string, mode: "merge" | "rebase" | "squash", safe: boolean }) => {
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const dir     = await worktreeDir(basedir, worktree)
            const branch  = await currentBranch(dir)
            const parent  = await parentBranch(dir, branch)
            const fop     = await operation(dir)
            if (fop !== "none")
                throw new Error(`worktree "${dir}" has an in-progress ${fop} operation`)
            const pdir = await branchDir(dir, parent)
            if (pdir === "")
                throw new Error(`parent branch "${parent}" is not checked out in any worktree`)
            const op = await operation(pdir)
            if (op !== "none")
                throw new Error(`worktree "${pdir}" has an in-progress ${op} operation`)

            /*  in mode "rebase", rebase onto parent branch (unless already contained), while
                temporarily stashing uncommitted changes of worktree (including untracked files)
                -- completely before stashing in the parent worktree, as all worktrees share
                a single stash stack  */
            if (opts.mode === "rebase"
                && (await git(dir, [ "merge-base", "--is-ancestor", parent, "HEAD" ], "check whether the parent branch is already contained")).failed) {
                const fstashed = await stashPush(dir, "vcs merge")
                const restore  = async () => {
                    if (fstashed && (await git(dir, [ "stash", "pop", "--quiet" ], "restore the stashed changes after failure")).failed)
                        info(`uncommitted changes of worktree "${worktree}" remain stashed -- ` +
                            "run \"git stash pop\" there to restore them")
                }
                const res = await rebase(dir, parent, opts.safe).catch(async (err: unknown) => {
                    await git(dir, [ "rebase", "--abort" ], "abort the failed rebase")
                    await restore()
                    throw err
                })
                if (res !== null && res.verdict === "PARTIAL") {
                    await git(dir, [ "rebase", "--abort" ], "abort the rebase with unresolved conflicts")
                    await fs.promises.rm(res.backupDir, { recursive: true, force: true })
                    await restore()
                    await report(res)
                    throw new Error(`merge of branch "${branch}" into "${parent}" aborted due to unresolved conflicts`)
                }
                const fres = fstashed ? await stashPop(dir, opts.safe) : null
                if (fres !== null) {
                    await report(fres)
                    info(`branch "${branch}" rebased onto parent branch "${parent}", but not yet merged, as ` +
                        `stashed changes of worktree "${worktree}" restored with conflicts: resolve the escalated ` +
                        "conflicts manually, run \"git reset\" and \"git stash drop\", and re-run \"vcs merge\"")
                    process.exitCode = 1
                    return
                }
            }

            /*  stash uncommitted changes of parent worktree (including untracked files)  */
            const stashed = await stashPush(pdir, "vcs merge")
            try {
                if (opts.mode === "rebase")
                    /*  fast-forward parent branch (onto which the branch was rebased)  */
                    await gitOK(pdir, [ "merge", "--quiet", "--ff-only", branch ], "fast-forward the parent branch")
                else {
                    /*  merge or squash branch into parent branch
                        (overriding a "merge.ff=only" configuration on squash)  */
                    const args = opts.mode === "squash" ?
                        [ "-c", "merge.ff=true", "merge", "--quiet", "--squash", branch ] :
                        [ "merge", "--quiet", "--no-ff", "--no-edit", branch ]
                    const result = await git(pdir, args, "merge the branch into the parent branch")
                    if (result.failed) {
                        if (!(await hasUnmerged(pdir))) {
                            await git(pdir, [ "reset", "--quiet", "--merge" ], "abort the failed merge")
                            throw new Error(`merge of branch "${branch}" into "${parent}" failed: ${(result.stderr || result.stdout).trim()}`)
                        }
                        const res = await resolveConflicts(pdir, opts.safe).catch(async (err: unknown) => {
                            await git(pdir, [ "reset", "--quiet", "--merge" ], "abort the failed merge")
                            throw err
                        })
                        if (res.verdict !== "RESOLVED") {
                            await git(pdir, [ "reset", "--quiet", "--merge" ], "abort the merge with unresolved conflicts")
                            await fs.promises.rm(res.backupDir, { recursive: true, force: true })
                            await report(res)
                            throw new Error(`merge of branch "${branch}" into "${parent}" aborted due to unresolved conflicts`)
                        }
                    }
                    if (result.failed || (opts.mode === "squash" && (await git(pdir, [ "diff", "--cached", "--quiet" ], "check for staged changes")).failed))
                        await gitOK(pdir, [ "commit", "--quiet", "--no-edit" ], "commit the merge")
                }
                if (opts.mode !== "squash" && (await git(pdir, [ "merge-base", "--is-ancestor", branch, parent ], "check whether the branch landed on the parent branch")).failed)
                    throw new Error(`branch "${branch}" not contained in branch "${parent}" after merge`)
            }
            catch (err: unknown) {
                /*  restore stashed changes of parent worktree on the (aborted) original state  */
                if (stashed && (await git(pdir, [ "stash", "pop", "--quiet" ], "restore the stashed changes after failure")).failed)
                    info(`uncommitted changes of worktree "${path.basename(pdir)}" remain stashed -- ` +
                        "run \"git stash pop\" there to restore them")
                throw err
            }
            info(`worktree "${worktree}" (branch "${branch}") merged into parent branch "${parent}" (mode: ${opts.mode})`)

            /*  restore stashed changes of parent worktree, resolving conflicts  */
            const pres = stashed ? await stashPop(pdir, opts.safe) : null
            if (pres !== null) {
                await report(pres)
                info(`stashed changes of worktree "${path.basename(pdir)}" restored with conflicts: ` +
                    "resolve the escalated conflicts manually, and run \"git reset\" and \"git stash drop\"")
                process.exitCode = 1
            }
        })

    /*  command: resolve  */
    program.command("resolve")
        .description("resolve the conflicts in a worktree and continue its in-progress operation")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("[worktree]", "worktree to resolve (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string, safe: boolean }) => {
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const dir     = await worktreeDir(basedir, worktree)
            const res     = await resolveAndContinue(dir, opts.safe)
            await report(res)
            info(`resolve verdict: ${res.verdict === "PARTIAL" ? chalk.yellow(res.verdict) : chalk.green(res.verdict)}`)
            if (res.verdict === "PARTIAL")
                process.exitCode = 1
        })

    /*  command: shuffle  */
    program.command("shuffle")
        .description("move all staged, unstaged, and untracked files of the current worktree into the working copy of another worktree")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("<worktree>", "worktree to shuffle the files into")
        .action(async (worktree: string, opts: { basedir?: string, safe: boolean }) => {
            const basedir = await findBasedir(opts.basedir)
            const source  = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const sdir    = await worktreeDir(basedir, source)
            const tdir    = await worktreeDir(basedir, worktree)
            if (source === worktree)
                throw new Error(`cannot shuffle worktree "${source}" into itself`)
            for (const dir of [ sdir, tdir ]) {
                const op = await operation(dir)
                if (op !== "none")
                    throw new Error(`worktree "${dir}" has an in-progress ${op} operation`)
                if (await hasUnmerged(dir))
                    throw new Error(`worktree "${dir}" has unmerged files`)
            }

            /*  short-circuit processing if nothing is to be shuffled  */
            if ((await gitOK(sdir, [ "status", "--porcelain" ], "check for uncommitted changes")) === "") {
                info(`worktree "${source}" has no uncommitted changes to shuffle`)
                return
            }

            /*  snapshot current worktree and temporarily commit uncommitted changes of target worktree
                (as "git stash apply" refuses to merge into dirty files)  */
            const commit = await snapshot(sdir)
            const temp   = (await gitOK(tdir, [ "status", "--porcelain" ], "check for uncommitted changes")) !== ""
            if (temp) {
                await gitOK(tdir, [ "add", "--all" ], "stage the uncommitted changes of the target worktree")
                await gitOK(tdir, [ "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", "vcs shuffle: temporary commit" ],
                    "temporarily commit the uncommitted changes of the target worktree")
            }
            const uncommit = temp ? [ "reset", "--quiet", "HEAD~1" ] : [ "reset", "--quiet" ]
            const hint     = `run "git ${uncommit.filter((arg) => arg !== "--quiet").join(" ")}" there`

            /*  apply snapshot onto target worktree, resolving conflicts  */
            try {
                const result = await git(tdir, [ "stash", "apply", "--quiet", commit ], "apply the snapshot to the target worktree")
                if (result.failed) {
                    if (!(await hasUnmerged(tdir))) {
                        await gitOK(tdir, uncommit, "restore the original state of the target worktree")
                        throw new Error(`failed to shuffle files into worktree "${worktree}": ${(result.stderr || result.stdout).trim()}`)
                    }
                    const res = await resolveConflicts(tdir, opts.safe)
                    if (res.verdict === "PARTIAL") {
                        await report(res)
                        info(`files shuffled into worktree "${worktree}" with conflicts: resolve the escalated conflicts manually, ` +
                            `${hint}, and afterwards run "vcs clean" in worktree "${source}"`)
                        process.exitCode = 1
                        return
                    }
                }
            }
            catch (err: unknown) {
                if (temp && (await hasUnmerged(tdir)))
                    info(`uncommitted changes of worktree "${worktree}" remain temporarily committed -- ` +
                        `after resolving the conflicts, ${hint}`)
                throw err
            }

            /*  undo temporary commit and unstage all files of target worktree  */
            await gitOK(tdir, uncommit, temp ?
                "undo the temporary commit of the target worktree" :
                "unstage the shuffled files")

            /*  clean current worktree  */
            await cleanWorktree(sdir, false)
            info(`files of worktree "${source}" shuffled into worktree "${worktree}"`)
        })

    /*  command: clean  */
    program.command("clean")
        .description("reset a worktree to its HEAD and remove all staged, unstaged, and untracked files")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-i, --ignored", "remove ignored files, too", false)
        .argument("[worktree]", "worktree to clean (default: worktree of current directory)")
        .action(async (worktree: string | undefined, opts: { basedir?: string, ignored: boolean }) => {
            const basedir = await findBasedir(opts.basedir)

            /*  default to worktree containing the current directory  */
            if (worktree === undefined)
                worktree = path.basename(await gitOK(process.cwd(), [ "rev-parse", "--show-toplevel" ], "determine the worktree of the current directory"))
            const dir = await worktreeDir(basedir, worktree)
            await cleanWorktree(dir, opts.ignored)
            info(`worktree "${worktree}" cleaned`)
        })

    /*  command: rename  */
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

    /*  command: destroy  */
    program.command("destroy")
        .description("remove a worktree and its branch")
        .option("-d, --basedir <basedir>", "base directory")
        .argument("<worktree>", "worktree to destroy")
        .action(async (worktree: string, opts: { basedir?: string }) => {
            const basedir = await findBasedir(opts.basedir)
            const name    = await masterName(basedir)
            if (worktree === name)
                throw new Error(`master worktree "${name}" cannot be destroyed`)
            const dir    = await worktreeDir(basedir, worktree)
            const master = path.join(basedir, name)
            const branch = await currentBranch(dir)
            const parent = await parentBranch(dir, branch).catch(() => currentBranch(master))
            await ensureClean(dir)

            /*  ensure the branch landed on its parent branch (by merge, rebase, or squash)  */
            if ((await git(master, [ "merge-base", "--is-ancestor", branch, parent ], "check whether the branch is contained in the parent branch")).failed) {
                const tree  = await git(master, [ "merge-tree", "--write-tree", parent, branch ], "determine the tree of a merge of the branch into the parent branch")
                const ptree = await gitOK(master, [ "rev-parse", `${parent}^{tree}` ], "determine the tree of the parent branch")
                if (tree.failed || tree.stdout.split("\n")[0] !== ptree)
                    throw new Error(`branch "${branch}" is not merged into parent branch "${parent}"`)
            }

            /*  remove worktree and branch  */
            if ((await fs.promises.readlink(path.join(basedir, "active"))) === worktree)
                await setActive(basedir, name)
            await gitOK(master, [ "worktree", "remove", dir ], "remove the worktree")
            await gitOK(master, [ "branch", "--quiet", "-D", branch ], "delete the branch")
            info(`worktree "${worktree}" and branch "${branch}" destroyed`)
        })

    /*  add verbosity option to all commands  */
    for (const cmd of program.commands)
        cmd.addOption(new Option("-v, --verbose <num>", "verbosity level (0: information, 1: plus commands and Claude actions, 2: plus command and Claude comments)")
            .choices([ "0", "1", "2" ]).default("0"))
    program.hook("preAction", (_thisCommand, actionCommand) => {
        verbose = Number(actionCommand.opts<{ verbose: string }>().verbose)
    })

    await program.parseAsync(process.argv)
})().catch((err: unknown) => {
    /*  fatal error  */
    process.stderr.write(`${chalk.red("vcs: ERROR:")} ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
})

