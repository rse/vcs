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

/*  external requirements  */
import { Command, Option } from "commander"
import chalk               from "chalk"

/*  own requirements  */
import { setVerbose }      from "./vcs-util-base.js"
import { commandInit }     from "./vcs-cmd-init.js"
import { commandActive }   from "./vcs-cmd-active.js"
import { commandList }     from "./vcs-cmd-list.js"
import { commandActivate } from "./vcs-cmd-activate.js"
import { commandFork }     from "./vcs-cmd-fork.js"
import { commandCheckout } from "./vcs-cmd-checkout.js"
import { commandParent }   from "./vcs-cmd-parent.js"
import { commandDiff }     from "./vcs-cmd-diff.js"
import { commandSync }     from "./vcs-cmd-sync.js"
import { commandMerge }    from "./vcs-cmd-merge.js"
import { commandResolve }  from "./vcs-cmd-resolve.js"
import { commandShuffle }  from "./vcs-cmd-shuffle.js"
import { commandClean }    from "./vcs-cmd-clean.js"
import { commandRename }   from "./vcs-cmd-rename.js"
import { commandDestroy }  from "./vcs-cmd-destroy.js"

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

    /*  define all commands  */
    commandInit(program)
    commandActive(program)
    commandList(program)
    commandActivate(program)
    commandFork(program)
    commandCheckout(program)
    commandParent(program)
    commandDiff(program)
    commandSync(program)
    commandMerge(program)
    commandResolve(program)
    commandShuffle(program)
    commandClean(program)
    commandRename(program)
    commandDestroy(program)

    /*  add verbosity option to all commands  */
    for (const cmd of program.commands)
        cmd.addOption(new Option("-v, --verbose <num>", "verbosity level (0: information, 1: plus commands and Claude actions, 2: plus command and Claude comments)")
            .choices([ "0", "1", "2" ]).default("0"))
    program.hook("preAction", (_thisCommand, actionCommand) => {
        setVerbose(Number(actionCommand.opts<{ verbose: string }>().verbose))
    })

    await program.parseAsync(process.argv)
})().catch((err: unknown) => {
    /*  fatal error  */
    process.stderr.write(`${chalk.red("vcs: ERROR:")} ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
})

