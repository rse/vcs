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
import { execa }           from "execa"
import chalk               from "chalk"

/*  own requirements  */
import {
    verbose, info, trace
} from "./vcs-util-base.js"
import {
    type Operation
} from "./vcs-util-repo.js"
import {
    type Conflict, type Escalation
} from "./vcs-util-conflict.js"

/*  type definitions  */
export type AIResult = {
    files:   { file: string, resolved: boolean, remove: boolean, escalations: Escalation[] }[],
    touched: string[]
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
export const aiResolve = async (root: string, backupDir: string, op: Operation,
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
    /*  determine the conflicted file a tool use refers to (by its file path or command)  */
    const conflictOf = (input: Record<string, unknown>) => {
        const file = typeof input.file_path === "string" ? path.resolve(root, input.file_path) : ""
        const cmd  = typeof input.command   === "string" ? input.command : ""
        return conflicts
            .filter((c) => file !== "" ?
                (file === path.join(root, c.file) || file === path.join(backupDir, c.file)) :
                cmd.includes(c.file))
            .sort((a, b) => b.file.length - a.file.length)[0]
    }
    const seen = new Set<string>()
    let current = ""

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
                else if (block.type === "tool_use" && block.name !== "StructuredOutput") {
                    const input = block.input ?? {}

                    /*  report the progress whenever Claude switches to another conflicted file  */
                    const c = conflictOf(input)
                    if (c !== undefined && c.file !== current) {
                        current = c.file
                        if (seen.has(c.file))
                            info(`${chalk.blue("▷")} revisiting ${c.file}`)
                        else {
                            seen.add(c.file)
                            info(`${chalk.blue("▷")} resolving ${c.file} [${seen.size}/${conflicts.length}]`)
                        }
                    }
                    if (verbose >= 1) {
                        const file   = typeof input.file_path === "string" ? input.file_path : ""
                        const detail = typeof input.command === "string" ? input.command :
                            file !== "" ? (file.startsWith(root + path.sep) ? path.relative(root, file) : file) :
                                JSON.stringify(input)
                        process.stderr.write(`${chalk.red(`claude> ${block.name}: ${detail.replace(/\s*\n\s*/g, " ")}`)}\n`)
                    }
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

