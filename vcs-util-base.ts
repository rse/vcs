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

/*  external requirements  */
import { execa }           from "execa"
import chalk               from "chalk"

/*  verbosity level (0: information only, 1: additionally commands and Claude actions, 2: additionally comments)  */
export let verbose = 0
export const setVerbose = (level: number) => {
    verbose = level
}

/*  output information  */
export const info = (msg: string) => {
    process.stderr.write(`${chalk.blue("vcs:")} ${msg}\n`)
}

/*  output a command (preceded by its comment) to be executed  */
export const trace = (cmd: string, args: string[], what: string, env: Record<string, string> = {}) => {
    if (verbose >= 2)
        process.stderr.write(`# ${what}\n`)
    if (verbose >= 1) {
        const quote = (arg: string) => /^[A-Za-z0-9_.,:/@=+%^{}-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`
        const vars  = Object.entries(env).map(([ k, v ]) => `${k}=${quote(v)}`)
        process.stderr.write(`${chalk.blue(`$ ${[ ...vars, ...[ cmd, ...args ].map(quote) ].join(" ")}`)}\n`)
    }
}

/*  execute a Git command (without and with failing on errors)  */
export const git = (dir: string, args: string[], what: string, env: Record<string, string> = {}) => {
    trace("git", [ "-C", dir, ...args ], what, env)
    return execa("git", [ "-C", dir, ...args ], { reject: false, stdin: "ignore", env })
}
export const gitOK = async (dir: string, args: string[], what: string, env: Record<string, string> = {}) => {
    const result = await git(dir, args, what, env)
    if (result.failed)
        throw new Error(`command "git ${args.join(" ")}" failed: ${(result.stderr || result.stdout).trim()}`)
    return result.stdout
}

/*  check for existing path  */
export const exists = (p: string) =>
    fs.promises.access(p).then(() => true, () => false)

/*  check for symbolic link  */
export const isSymlink = (p: string) =>
    fs.promises.lstat(p).then((stat) => stat.isSymbolicLink(), () => false)

