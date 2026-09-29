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

/*  type definitions  */
type Operation  = "merge" | "rebase" | "cherry-pick" | "revert" | "none"
type Verdict    = "NONE" | "RESOLVED" | "PARTIAL"
type Conflict   = { file: string, kind: string }
type Escalation = { file: string, lines: string, kind: string, ours: string, theirs: string, reason: string }
type Resolution = { verdict: Verdict, operation: Operation, escalations: Escalation[], backupDir: string }
type AIResult   = {
    files:   { file: string, resolved: boolean, remove: boolean, escalations: Escalation[] }[],
    touched: string[]
}

/*  output information  */
const info = (msg: string) => {
    process.stderr.write(`${chalk.blue("vcs:")} ${msg}\n`)
}

/*  execute a Git command (without and with failing on errors)  */
const git = (dir: string, args: string[]) =>
    execa("git", [ "-C", dir, ...args ], { reject: false, stdin: "ignore" })
const gitOK = async (dir: string, args: string[]) => {
    const result = await git(dir, args)
    if (result.failed)
        throw new Error(`command "git ${args.join(" ")}" failed: ${(result.stderr || result.stdout).trim()}`)
    return result.stdout
}

/*  check for symbolic link  */
const isSymlink = (p: string) => {
    try {
        return fs.lstatSync(p).isSymbolicLink()
    }
    catch {
        return false
    }
}

/*  determine basedir (explicitly given or auto-detected from CWD upwards)  */
const findBasedir = (basedir?: string) => {
    if (basedir !== undefined) {
        basedir = path.resolve(basedir)
        if (!isSymlink(path.join(basedir, "active")))
            throw new Error(`no "active" symlink found in basedir "${basedir}"`)
        return basedir
    }
    let dir = process.cwd()
    while (!isSymlink(path.join(dir, "active"))) {
        const parent = path.dirname(dir)
        if (parent === dir)
            throw new Error("no basedir found (no \"active\" symlink in current or any parent directory)")
        dir = parent
    }
    return dir
}

/*  determine directory of a worktree under basedir  */
const worktreeDir = (basedir: string, name: string, mustExist = true) => {
    if (!name.match(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) || name === "active")
        throw new Error(`invalid worktree name "${name}"`)
    const dir = path.join(basedir, name)
    if (mustExist && !fs.existsSync(path.join(dir, ".git")))
        throw new Error(`no worktree "${name}" found under basedir "${basedir}"`)
    return dir
}

/*  atomically re-point the "active" symlink  */
const setActive = (basedir: string, name: string) => {
    const tmp = path.join(basedir, `.active.${process.pid}`)
    fs.symlinkSync(name, tmp)
    fs.renameSync(tmp, path.join(basedir, "active"))
}

/*  determine checked-out branch of a worktree  */
const currentBranch = async (dir: string) => {
    const branch = await gitOK(dir, [ "branch", "--show-current" ])
    if (branch === "")
        throw new Error(`worktree "${dir}" has no checked-out branch (detached HEAD)`)
    return branch
}

/*  determine recorded parent branch of a branch  */
const parentBranch = async (dir: string, branch: string) => {
    const result = await git(dir, [ "config", "--get", `branch.${branch}.vcsParent` ])
    if (result.failed || result.stdout === "")
        throw new Error(`no parent branch recorded for branch "${branch}"`)
    return result.stdout
}

/*  determine worktree directory where a branch is checked out (or empty)  */
const branchDir = async (dir: string, branch: string) => {
    let worktree = ""
    for (const line of (await gitOK(dir, [ "worktree", "list", "--porcelain" ])).split("\n")) {
        if (line.startsWith("worktree "))
            worktree = line.substring(9)
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
    for (const [ ref, op ] of theirsRefs)
        if (!(await git(dir, [ "rev-parse", "--verify", "--quiet", ref ])).failed)
            return op
    for (const state of [ "rebase-merge", "rebase-apply" ])
        if (fs.existsSync(path.resolve(dir, await gitOK(dir, [ "rev-parse", "--git-path", state ]))))
            return "rebase"
    return "none"
}

/*  check for unmerged files  */
const hasUnmerged = async (dir: string) =>
    (await gitOK(dir, [ "diff", "--name-only", "--diff-filter=U" ])) !== ""

/*  check for conflict markers in a file  */
const hasMarkers = (file: string) =>
    fs.existsSync(file) && /^(<{7}|\|{7}|>{7})( |$)/m.test(fs.readFileSync(file, "utf8"))

/*  ensure a worktree has neither uncommitted changes nor an in-progress operation  */
const ensureClean = async (dir: string) => {
    if ((await gitOK(dir, [ "status", "--porcelain" ])) !== "")
        throw new Error(`worktree "${dir}" has uncommitted changes`)
    const op = await operation(dir)
    if (op !== "none")
        throw new Error(`worktree "${dir}" has an in-progress ${op} operation`)
}

/*  fast-forward a local branch to its "origin" counterpart  */
const refreshBranch = async (dir: string, branch: string) => {
    if ((await git(dir, [ "remote", "get-url", "origin" ])).failed)
        return
    await gitOK(dir, [ "fetch", "--quiet", "origin" ])
    const remote = `refs/remotes/origin/${branch}`
    if ((await git(dir, [ "rev-parse", "--verify", "--quiet", remote ])).failed)
        return
    if ((await git(dir, [ "merge-base", "--is-ancestor", branch, remote ])).failed) {
        info(`branch "${branch}" diverged from "origin/${branch}" -- not fast-forwarded`)
        return
    }
    const bdir = await branchDir(dir, branch)
    if (bdir !== "")
        await gitOK(bdir, [ "merge", "--quiet", "--ff-only", remote ])
    else
        await gitOK(dir, [ "update-ref", `refs/heads/${branch}`, remote ])
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

1.  Determine the intents of both sides by running "git log --oneline -n 10 HEAD"
    ${theirs !== "" ? `and "git log --oneline -n 10 ${theirs}" and "git show --stat ${theirs}"` : ""}.

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
    const result = await execa("claude", [
        "-p", prompt,
        "--output-format", "json",
        "--json-schema", JSON.stringify(aiSchema),
        "--tools", "Read,Edit,Write,Bash",
        "--allowedTools", "Read", "Edit", "Write",
        "Bash(git log *)", "Bash(git show *)", "Bash(git diff *)",
        "--permission-mode", "dontAsk",
        "--add-dir", backupDir,
        "--no-session-persistence"
    ], { cwd: root, reject: false, stdin: "ignore" })
    if (result.failed)
        return null
    for (const line of result.stdout.split("\n")) {
        if (!line.startsWith("{"))
            continue
        try {
            const response = JSON.parse(line)
            if (response.type === "result" && !response.is_error && response.structured_output)
                return response.structured_output as AIResult
        }
        catch {
            continue
        }
    }
    return null
}

/*  resolve the conflicts of the in-progress operation of a worktree  */
const resolveConflicts = async (dir: string, safe: boolean): Promise<Resolution> => {
    const root   = await gitOK(dir, [ "rev-parse", "--show-toplevel" ])
    const gitDir = await gitOK(dir, [ "rev-parse", "--absolute-git-dir" ])
    const op     = await operation(root)
    let theirs   = theirsRefs.find(([ , o ]) => o === op)?.[0] ?? ""
    const other  = theirs !== "" ? await git(root, [ "rev-parse", "--verify", "--quiet", theirs ]) : null
    if (other === null || other.failed)
        theirs = ""

    /*  determine and classify unmerged files  */
    const conflicts: Conflict[] = []
    const status = await gitOK(root, [ "-c", "core.quotepath=off", "status", "--porcelain=v1", "-z" ])
    for (const entry of status.split("\0")) {
        const m = entry.match(/^(UU|AA|UD|DU|AU|UA|DD) (.+)$/)
        if (m === null)
            continue
        const [ , code, file ] = m
        let kind
        if (code === "DD")
            kind = "delete/delete"
        else if (code === "UD" || code === "DU")
            kind = "modify/delete"
        else if (code === "AU" || code === "UA")
            kind = "rename"
        else if ((await gitOK(root, [ "ls-files", "-u", "--", file ])).match(/^160000 /m))
            kind = "submodule"
        else
            kind = hasMarkers(path.join(root, file)) ? "content" : "binary"
        conflicts.push({ file, kind })
    }

    /*  short-circuit processing if nothing is to be resolved  */
    const head = await gitOK(root, [ "rev-parse", "HEAD" ])
    const backupDir = path.join(gitDir, "vcs-resolve", `${head}-${theirs !== "" ? other!.stdout : "none"}`)
    if (conflicts.length === 0)
        return { verdict: "NONE", operation: op, escalations: [], backupDir }

    /*  back up files (never overwriting the more original state of an earlier run)  */
    for (const c of conflicts) {
        const src = path.join(root, c.file)
        const dst = path.join(backupDir, c.file)
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.mkdirSync(path.dirname(dst), { recursive: true })
            fs.copyFileSync(src, dst)
        }
    }

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
            await gitOK(root, [ "rm", "--quiet", "--", c.file ])
        else if (c.kind === "binary" || c.kind === "submodule") {
            /*  take the changed side if the other side left it unchanged  */
            const stages: Record<string, { mode: string, oid: string }> = {}
            for (const line of (await gitOK(root, [ "ls-files", "-u", "--", c.file ])).split("\n")) {
                const m = line.match(/^(\d+) ([0-9a-f]+) ([123])\t/)
                if (m !== null)
                    stages[m[3]] = { mode: m[1], oid: m[2] }
            }
            const base = stages["1"]?.oid
            const side = base === undefined ? undefined :
                stages["2"]?.oid === base ? stages["3"] :
                stages["3"]?.oid === base ? stages["2"] : undefined
            if (side === undefined)
                escalate(c, "both sides changed differently")
            else if (c.kind === "submodule")
                await gitOK(root, [ "update-index", "--cacheinfo", `${side.mode},${side.oid},${c.file}` ])
            else {
                await gitOK(root, [ "checkout", side === stages["2"] ? "--ours" : "--theirs", "--", c.file ])
                toStage.push(c.file)
            }
        }
        else
            toAI.push(c)
    }

    /*  resolve remaining conflicts semantically via Claude  */
    if (toAI.length > 0) {
        info(`resolving ${toAI.length} conflicted file(s) via Claude`)
        const result = await aiResolve(root, backupDir, op, theirs, toAI, safe)
        if (result === null) {
            /*  restore all files from their backups  */
            for (const c of toAI) {
                const backup = path.join(backupDir, c.file)
                if (fs.existsSync(backup))
                    fs.copyFileSync(backup, path.join(root, c.file))
                escalate(c, "AI resolution failed")
            }
        }
        else {
            for (const c of toAI) {
                const file = path.join(root, c.file)
                const r = result.files.find((f) => f.file === c.file)
                if (r === undefined)
                    escalate(c, "no resolution reported")
                else if (!r.resolved || r.escalations.length > 0)
                    escalations.push(...(r.escalations.length > 0 ? r.escalations :
                        [ { file: c.file, lines: "*", kind: c.kind, ours: "", theirs: "", reason: "not resolved" } ]))
                else if (r.remove)
                    await gitOK(root, [ "rm", "--quiet", "--ignore-unmatch", "--", c.file ])
                else if (!fs.existsSync(file))
                    escalate(c, "resolved file is missing")
                else if (hasMarkers(file))
                    escalate(c, "leftover conflict markers")
                else
                    toStage.push(c.file)
            }
            for (const file of result.touched) {
                const abs = path.resolve(root, file)
                if (abs.startsWith(root + path.sep) && fs.existsSync(abs) && !hasMarkers(abs))
                    toStage.push(path.relative(root, abs))
            }
        }
    }

    /*  stage fully resolved files  */
    if (toStage.length > 0)
        await gitOK(root, [ "add", "--", ...toStage ])

    /*  determine verdict (keeping backups in case of escalations)  */
    if (escalations.length === 0) {
        fs.rmSync(backupDir, { recursive: true, force: true })
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
        const result = await git(dir, [ "-c", "core.editor=true", res.operation, "--continue" ])
        if (!result.failed)
            return res
        if (!(await hasUnmerged(dir)))
            throw new Error(`failed to continue ${res.operation}: ${(result.stderr || result.stdout).trim()}`)
        info(`${res.operation} continued -- resolving next conflicts`)
    }
}

/*  report the escalated conflicts  */
const report = (res: Resolution) => {
    for (const e of res.escalations) {
        process.stderr.write(`${chalk.yellow("▶")} ${e.file}:${e.lines} (${e.kind}): ${e.reason}\n`)
        if (e.ours !== "")
            process.stderr.write(`    ${chalk.grey("ours:")}   ${e.ours}\n`)
        if (e.theirs !== "")
            process.stderr.write(`    ${chalk.grey("theirs:")} ${e.theirs}\n`)
    }
    if (res.escalations.length > 0 && res.backupDir !== "" && fs.existsSync(res.backupDir))
        process.stderr.write(`    ${chalk.grey("backups:")} ${res.backupDir}\n`)
}

/*  rebase a worktree onto its parent branch, resolving conflicts  */
const rebase = async (dir: string, parent: string, safe: boolean): Promise<Resolution | null> => {
    const result = await git(dir, [ "rebase", "--quiet", parent ])
    if (!result.failed)
        return null
    if (!(await hasUnmerged(dir))) {
        await git(dir, [ "rebase", "--abort" ])
        throw new Error(`rebase onto "${parent}" failed: ${(result.stderr || result.stdout).trim()}`)
    }
    return resolveAndContinue(dir, safe)
}

;(async () => {
    /*  load my own information  */
    const packageInfo = JSON.parse(await fs.promises.readFile(new URL("../package.json", import.meta.url), "utf8"))

    /*  command-line option parsing  */
    const program = new Command()
    program
        .name("vcs")
        .description(packageInfo.description)
        .version(packageInfo.version, "-V, --version")
        .showHelpAfterError()

    /*  command: init  */
    program.command("init")
        .description("create basedir with a clone of a Git repository in \"master\"")
        .option("-d, --basedir <basedir>", "base directory", ".")
        .requiredOption("-r, --repo <repo-url>", "URL of the Git repository to clone")
        .action(async (opts: { basedir: string, repo: string }) => {
            const basedir = path.resolve(opts.basedir)
            if (fs.existsSync(path.join(basedir, "master")) || isSymlink(path.join(basedir, "active")))
                throw new Error(`basedir "${basedir}" is already initialized`)
            fs.mkdirSync(basedir, { recursive: true })
            await gitOK(basedir, [ "clone", "--quiet", opts.repo, "master" ])
            setActive(basedir, "master")
            info(`basedir "${basedir}" initialized with clone of "${opts.repo}"`)
        })

    /*  command: active  */
    program.command("active")
        .description("show the active worktree")
        .option("-d, --basedir <basedir>", "base directory")
        .action((opts: { basedir?: string }) => {
            const basedir = findBasedir(opts.basedir)
            process.stdout.write(`${fs.readlinkSync(path.join(basedir, "active"))}\n`)
        })

    /*  command: activate  */
    program.command("activate")
        .description("activate a worktree")
        .option("-d, --basedir <basedir>", "base directory")
        .argument("<worktree>", "worktree to activate")
        .action((worktree: string, opts: { basedir?: string }) => {
            const basedir = findBasedir(opts.basedir)
            worktreeDir(basedir, worktree)
            setActive(basedir, worktree)
        })

    /*  command: fork  */
    program.command("fork")
        .description("create a worktree with a branch based on a parent branch")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-b, --branch <branch>", "branch to create (default: <worktree>)")
        .argument("<worktree>", "worktree to create")
        .argument("[parent-branch]", "parent branch (default: branch of active worktree)")
        .action(async (worktree: string, parent: string | undefined, opts: { basedir?: string, branch?: string }) => {
            const basedir = findBasedir(opts.basedir)
            if (worktree === "master")
                throw new Error("worktree name \"master\" is reserved")
            const dir = worktreeDir(basedir, worktree, false)
            if (fs.existsSync(dir))
                throw new Error(`directory "${dir}" already exists`)
            const master = path.join(basedir, "master")
            if (parent === undefined)
                parent = await currentBranch(fs.realpathSync(path.join(basedir, "active")))
            if ((await git(master, [ "rev-parse", "--verify", "--quiet", `refs/heads/${parent}` ])).failed)
                throw new Error(`parent branch "${parent}" does not exist`)
            const branch = opts.branch ?? worktree
            await gitOK(master, [ "worktree", "add", "--quiet", "-b", branch, dir, parent ])
            await gitOK(master, [ "config", `branch.${branch}.vcsParent`, parent ])
            info(`worktree "${worktree}" created with branch "${branch}" (parent branch "${parent}")`)
        })

    /*  command: sync  */
    program.command("sync")
        .description("rebase a worktree onto its (refreshed) parent branch")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("<worktree>", "worktree to synchronize")
        .action(async (worktree: string, opts: { basedir?: string, safe: boolean }) => {
            const basedir = findBasedir(opts.basedir)
            const dir     = worktreeDir(basedir, worktree)
            const branch  = await currentBranch(dir)
            const parent  = await parentBranch(dir, branch)
            await ensureClean(dir)
            await refreshBranch(dir, parent)
            const res = await rebase(dir, parent, opts.safe)
            if (res !== null && res.verdict === "PARTIAL") {
                report(res)
                info("rebase left in progress: resolve the escalated conflicts manually, " +
                    "stage them, and run \"git rebase --continue\"")
                process.exitCode = 1
                return
            }
            info(`worktree "${worktree}" synchronized onto parent branch "${parent}"`)
        })

    /*  command: merge  */
    program.command("merge")
        .description("merge a worktree into its parent branch")
        .option("-d, --basedir <basedir>", "base directory")
        .addOption(new Option("-m, --mode <mode>", "merge mode").choices([ "merge", "rebase", "squash" ]).default("merge"))
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("<worktree>", "worktree to merge")
        .action(async (worktree: string, opts: { basedir?: string, mode: string, safe: boolean }) => {
            const basedir = findBasedir(opts.basedir)
            const dir     = worktreeDir(basedir, worktree)
            const branch  = await currentBranch(dir)
            const parent  = await parentBranch(dir, branch)
            await ensureClean(dir)
            const pdir = await branchDir(dir, parent)
            if (pdir === "")
                throw new Error(`parent branch "${parent}" is not checked out in any worktree`)
            await ensureClean(pdir)
            if (opts.mode === "rebase") {
                /*  rebase onto parent branch and fast-forward parent branch  */
                const res = await rebase(dir, parent, opts.safe)
                if (res !== null && res.verdict === "PARTIAL") {
                    await git(dir, [ "rebase", "--abort" ])
                    fs.rmSync(res.backupDir, { recursive: true, force: true })
                    report(res)
                    throw new Error(`merge of branch "${branch}" into "${parent}" aborted due to unresolved conflicts`)
                }
                await gitOK(pdir, [ "merge", "--quiet", "--ff-only", branch ])
            }
            else {
                /*  merge or squash branch into parent branch  */
                const args = opts.mode === "squash" ?
                    [ "merge", "--quiet", "--squash", branch ] :
                    [ "merge", "--quiet", "--no-ff", "--no-edit", branch ]
                const result = await git(pdir, args)
                if (result.failed) {
                    if (!(await hasUnmerged(pdir))) {
                        await git(pdir, [ "reset", "--quiet", "--merge" ])
                        throw new Error(`merge of branch "${branch}" into "${parent}" failed: ${(result.stderr || result.stdout).trim()}`)
                    }
                    const res = await resolveConflicts(pdir, opts.safe)
                    if (res.verdict !== "RESOLVED") {
                        await git(pdir, [ "reset", "--quiet", "--merge" ])
                        fs.rmSync(res.backupDir, { recursive: true, force: true })
                        report(res)
                        throw new Error(`merge of branch "${branch}" into "${parent}" aborted due to unresolved conflicts`)
                    }
                }
                if (result.failed || (opts.mode === "squash" && (await git(pdir, [ "diff", "--cached", "--quiet" ])).failed))
                    await gitOK(pdir, [ "commit", "--quiet", "--no-edit" ])
            }
            if (opts.mode !== "squash" && (await git(pdir, [ "merge-base", "--is-ancestor", branch, parent ])).failed)
                throw new Error(`branch "${branch}" not contained in branch "${parent}" after merge`)
            info(`worktree "${worktree}" (branch "${branch}") merged into parent branch "${parent}" (mode: ${opts.mode})`)
        })

    /*  command: resolve  */
    program.command("resolve")
        .description("resolve the conflicts in a worktree and continue its in-progress operation")
        .option("-d, --basedir <basedir>", "base directory")
        .option("-s, --safe", "never touch non-content conflicts", false)
        .argument("<worktree>", "worktree to resolve")
        .action(async (worktree: string, opts: { basedir?: string, safe: boolean }) => {
            const basedir = findBasedir(opts.basedir)
            const dir     = worktreeDir(basedir, worktree)
            const res     = await resolveAndContinue(dir, opts.safe)
            report(res)
            info(`resolve verdict: ${res.verdict === "PARTIAL" ? chalk.yellow(res.verdict) : chalk.green(res.verdict)}`)
            if (res.verdict === "PARTIAL")
                process.exitCode = 1
        })

    /*  command: destroy  */
    program.command("destroy")
        .description("remove a worktree and its branch")
        .option("-d, --basedir <basedir>", "base directory")
        .argument("<worktree>", "worktree to destroy")
        .action(async (worktree: string, opts: { basedir?: string }) => {
            const basedir = findBasedir(opts.basedir)
            if (worktree === "master")
                throw new Error("worktree \"master\" cannot be destroyed")
            const dir    = worktreeDir(basedir, worktree)
            const master = path.join(basedir, "master")
            const branch = await currentBranch(dir)
            const parent = await parentBranch(dir, branch).catch(() => currentBranch(master))
            await ensureClean(dir)

            /*  ensure the branch landed on its parent branch (by merge, rebase, or squash)  */
            if ((await git(master, [ "merge-base", "--is-ancestor", branch, parent ])).failed) {
                const tree   = await git(master, [ "merge-tree", "--write-tree", parent, branch ])
                const ptree  = await gitOK(master, [ "rev-parse", `${parent}^{tree}` ])
                if (tree.failed || tree.stdout.split("\n")[0] !== ptree)
                    throw new Error(`branch "${branch}" is not merged into parent branch "${parent}"`)
            }

            /*  remove worktree and branch  */
            if (fs.readlinkSync(path.join(basedir, "active")) === worktree)
                setActive(basedir, "master")
            await gitOK(master, [ "worktree", "remove", dir ])
            await gitOK(master, [ "branch", "--quiet", "-D", branch ])
            info(`worktree "${worktree}" and branch "${branch}" destroyed`)
        })

    await program.parseAsync(process.argv)
})().catch((err: Error) => {
    /*  fatal error  */
    process.stderr.write(`${chalk.red("vcs: ERROR:")} ${err.message}\n`)
    process.exit(1)
})

