import readline from "readline"
import chalk from "chalk"
import ora from "ora"
import { getProjectContext } from "./context.js"
import { askModel, ollama, buildSystemPrompt } from "./llm.js"
import { webSearch } from "./search.js"
import { renderHeader } from "./header.js"
import { models } from "./models.js"
import { state } from "./state.js"
import { parseEdits, applyEdits, undoLast } from "./apply.js"
import { renderEditSummary } from "./render.js"
import { extractReferences, buildReferenceContext, completeReference } from "./references.js"

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true
})

let cancelGen = null
let atHintShown = false

function findCommonPrefix(strings) {
  if (strings.length === 0) return ""
  let prefix = strings[0]
  for (let i = 1; i < strings.length; i++) {
    while (strings[i].indexOf(prefix) !== 0) {
      prefix = prefix.slice(0, -1)
      if (!prefix) return ""
    }
  }
  return prefix
}

// Drive @-ref completion ourselves. We always show *some* visible result so
// the user knows TAB fired — silent failure is the worst outcome here.
function handleTabCompletion() {
  const line = rl.line
  const cursor = rl.cursor
  const before = line.slice(0, cursor)
  const after = line.slice(cursor)

  const result = completeReference(before, process.cwd())
  if (!result) {
    process.stdout.write("\n  (no @-reference at cursor)\n")
    rl._refreshLine()
    return
  }

  const { completions, prefix } = result

  if (completions.length === 0) {
    process.stdout.write(`\n  (no matches for ${prefix} in ${process.cwd()})\n`)
    rl._refreshLine()
    return
  }

  const beforePrefix = before.slice(0, before.length - prefix.length)

  if (completions.length === 1) {
    const insertion = completions[0]
    rl.line = beforePrefix + insertion + after
    rl.cursor = beforePrefix.length + insertion.length
    rl._refreshLine()
    return
  }

  const common = findCommonPrefix(completions)
  if (common.length > prefix.length) {
    rl.line = beforePrefix + common + after
    rl.cursor = beforePrefix.length + common.length
    rl._refreshLine()
    return
  }

  const shared = findCommonPrefix(completions)
  process.stdout.write("\n")
  for (const c of completions) {
    const dim = c.slice(0, shared.length)
    const bright = c.slice(shared.length)
    process.stdout.write("  " + chalk.gray(dim) + chalk.cyan(bright) + "\n")
  }
  process.stdout.write("\n")
  rl._refreshLine()
}

const _origTtyWrite = rl._ttyWrite.bind(rl)
rl._ttyWrite = function (s, key) {
  if (cancelGen) {
    if (key && key.ctrl && key.name === "d") cancelGen()
    return
  }
  // Detect TAB by raw sequence OR key name — some terminals don't populate
  // key.name. Also accept either path so we don't miss the keystroke.
  const isTab =
    s === "\t" ||
    (key && key.name === "tab" && !key.ctrl && !key.meta && !key.shift) ||
    (key && key.sequence === "\t" && !key.ctrl && !key.meta && !key.shift)

  if (isTab) {
    const before = rl.line.slice(0, rl.cursor)
    if (/@[^\s@]*$/.test(before)) {
      handleTabCompletion()
      return  // always consume TAB when at an @-ref
    }
  }

  const result = _origTtyWrite(s, key)

  // First time user types @ in a session, show a one-time hint
  if (!atHintShown && s && s.includes("@")) {
    atHintShown = true
    process.stdout.write("\n  " + chalk.gray("tip: press ") + chalk.cyan("TAB") + chalk.gray(" after @ to autocomplete file paths") + "\n")
    rl._refreshLine()
  }

  return result
}

function runWithCancel(workFn) {
  return new Promise((resolve, reject) => {
    const myCancel = () => {
      if (cancelGen === myCancel) cancelGen = null
      try { ollama.abort() } catch {}
      const err = new Error("Cancelled")
      err.name = "AbortError"
      reject(err)
    }
    cancelGen = myCancel
    const clear = () => { if (cancelGen === myCancel) cancelGen = null }
    workFn().then(
      (val) => { clear(); resolve(val) },
      (err) => { clear(); reject(err) }
    )
  })
}

const theme = {
  primary: chalk.hex("#4FC3F7"),
  secondary: chalk.hex("#81D4FA"),
  dim: chalk.gray,
  success: chalk.hex("#4FC3F7"),
  error: chalk.red
}

function newSession() {
  return {
    messages: [{ role: "system", content: buildSystemPrompt() }],
    turnCount: 0
  }
}

export async function startCLI() {
  await renderHeader()
  let session = newSession()

  rl.on("close", () => {
    console.log(theme.dim("\nGoodbye 👋"))
    process.exit(0)
  })

  function prompt() {
    rl.question(theme.primary("❯ "), async (input) => {
      if (!input.trim()) return prompt()

      if (input === "exit") {
        console.log(theme.dim("\nGoodbye 👋"))
        process.exit(0)
      }

      if (input === "?" || input === "/help") {
        console.log(theme.primary("\nShortcuts & commands:"))
        console.log(theme.secondary("  /models      ") + theme.dim("list available models"))
        console.log(theme.secondary("  /model       ") + theme.dim("show the active model"))
        console.log(theme.secondary("  /model <x>   ") + theme.dim("switch model by name or number"))
        console.log(theme.secondary("  /undo        ") + theme.dim("revert the last applied file changes"))
        console.log(theme.secondary("  /clear       ") + theme.dim("clear screen + reset conversation"))
        console.log(theme.primary("\nFile references (TAB to complete):"))
        console.log(theme.secondary("  @path/to/file       ") + theme.dim("inject a file"))
        console.log(theme.secondary("  @file.js            ") + theme.dim("bare filename — searches the tree"))
        console.log(theme.secondary("  @core/*.js          ") + theme.dim("glob — inject all matches"))
        console.log(theme.secondary("  @**/chat.js         ") + theme.dim("recursive glob"))
        console.log(theme.secondary("  @core/chat.js:50-100") + theme.dim(" only those lines"))
        console.log(theme.secondary("  @core/              ") + theme.dim("dump all files in a directory"))
        console.log(theme.secondary("  Ctrl+D       ") + theme.dim("cancel a running generation"))
        console.log(theme.secondary("  Ctrl+C       ") + theme.dim("quit Noble AI"))
        console.log(theme.secondary("  exit         ") + theme.dim("quit Noble AI"))
        console.log(theme.dim("\nAnything else is sent to the model with project + web context.\n"))
        return prompt()
      }

      if (input === "/undo") {
        const snap = undoLast()
        if (!snap) {
          console.log(theme.dim("\nNothing to undo.\n"))
        } else {
          console.log(theme.success(`\nReverted ${snap.files.length} file(s):`))
          for (const f of snap.files) {
            const tag = f.existed ? "restored" : "deleted"
            console.log(theme.secondary(`  • ${f.path} `) + theme.dim(`(${tag})`))
          }
          console.log("")
        }
        return prompt()
      }

      if (input === "/clear") {
        session = newSession()
        await renderHeader()
        return prompt()
      }

      if (input === "/keytest") {
        console.log(theme.primary("\nKey test mode — press keys to see what readline receives."))
        console.log(theme.dim("Press Enter on an empty line to exit.\n"))
        const origTtyWrite = rl._ttyWrite.bind(rl)
        rl._ttyWrite = function (s, key) {
          const info = {
            sequence: JSON.stringify(s),
            name: key?.name,
            ctrl: key?.ctrl,
            meta: key?.meta,
            shift: key?.shift
          }
          console.log(theme.dim("  → " + JSON.stringify(info)))
          if (key && key.name === "return") {
            rl._ttyWrite = origTtyWrite  // restore
            console.log(theme.primary("\nExited key test.\n"))
            return prompt()
          }
        }
        return
      }

      if (input === "/models") {
        console.log(theme.primary("\nAvailable models:"))
        const nameWidth = Math.max(...models.map(m => m.name.length))
        models.forEach((m, i) => {
          const active = m.name === state.model
          const marker = active ? theme.success(" ●") : "  "
          const num = theme.dim(`${i + 1}.`)
          const name = (active ? theme.success : theme.secondary)(m.name.padEnd(nameWidth))
          const tag = theme.dim(`  ${m.tagline}`)
          console.log(`  ${num} ${name}${tag}${marker}`)
        })
        console.log(theme.dim("\nSwitch with: /model <name>  or  /model <number>\n"))
        return prompt()
      }

      if (input === "/model") {
        const current = models.find(m => m.name === state.model)
        const tag = current ? theme.dim(` — ${current.tagline}`) : ""
        console.log(theme.primary(`\nCurrent model: ${state.model}`) + tag + "\n")
        return prompt()
      }

      if (input.startsWith("/model ")) {
        const arg = input.slice(7).trim()
        const byIndex = Number.isInteger(+arg) ? models[+arg - 1] : null
        const target = byIndex || models.find(m => m.name === arg)

        if (!target) {
          console.log(theme.error(`\nUnknown model: ${arg}`))
          console.log(theme.dim("Use /models to see available models.\n"))
          return prompt()
        }

        state.model = target.name
        console.log(theme.success(`\nSwitched to ${target.name}`) + theme.dim(` — ${target.tagline}\n`))
        return prompt()
      }

      const refs = extractReferences(input)
      if (refs.length > 0) {
        for (const ref of refs) {
          if (ref.error) {
            console.log(theme.dim(`  @${ref.token} `) + theme.error(`✗ ${ref.error}`))
            continue
          }
          if (ref.files.length === 1 && !ref.isDirectory && !ref.isGlob) {
            const f = ref.files[0]
            const range = f.range ? `:${f.range.start}-${f.range.end}` : ""
            console.log(theme.dim(`  📎 ${f.rel}${range}`))
          } else {
            const kind = ref.isDirectory ? "dir" : "glob"
            console.log(theme.dim(`  📎 @${ref.token} `) + theme.secondary(`(${kind}, ${ref.files.length} file${ref.files.length === 1 ? "" : "s"}${ref.truncated ? ", truncated" : ""})`))
            for (const f of ref.files.slice(0, 5)) {
              console.log(theme.dim(`     • ${f.rel}`))
            }
            if (ref.files.length > 5) {
              console.log(theme.dim(`     … and ${ref.files.length - 5} more`))
            }
          }
        }
      }

      let spinner = ora({
        text: "thinking... (Ctrl+D to cancel)",
        color: "cyan"
      }).start()

      let streaming = false

      const onStatus = (text) => {
        if (streaming) {
          process.stdout.write("\n")
          streaming = false
        }
        if (spinner.isSpinning) spinner.text = text
        else spinner = ora({ text, color: "cyan" }).start()
      }

      const onChunk = (text) => {
        if (!streaming) {
          if (spinner.isSpinning) spinner.stop()
          process.stdout.write("\n" + theme.primary("☻ "))
          streaming = true
        }
        process.stdout.write(text)
      }

      try {
        const response = await runWithCancel(async () => {
          let userContent = input
          const refContext = buildReferenceContext(refs, process.cwd())
          if (refContext) {
            userContent += `\n\n--- REFERENCED FILES ---\n${refContext}`
          }
          if (session.turnCount === 0) {
            const context = await getProjectContext(process.cwd(), input)
            const webContext = await webSearch(input)
            userContent += `\n\n--- PROJECT CONTEXT ---\n${context}\n\n--- WEB SEARCH ---\n${webContext}`
          }
          session.messages.push({ role: "user", content: userContent })
          session.turnCount++
          return askModel(session.messages, onStatus, onChunk)
        })

        if (streaming) {
          process.stdout.write("\n\n")
          streaming = false
        } else if (spinner.isSpinning) {
          spinner.stop()
        }

        const edits = parseEdits(response)
        if (edits.length > 0) {
          process.stdout.write(renderEditSummary(edits))
          return rl.question(theme.primary("\nApply these changes? [y/N] "), (answer) => {
            if (answer.trim().toLowerCase() === "y") {
              const snap = applyEdits(edits)
              console.log(theme.success(`\nApplied ${snap.files.length} file(s). Use /undo to revert.\n`))
            } else {
              console.log(theme.dim("\nSkipped.\n"))
            }
            prompt()
          })
        }
      } catch (err) {
        if (streaming) process.stdout.write("\n")
        if (spinner.isSpinning) spinner.stop()
        const aborted =
          err?.name === "AbortError" ||
          /abort|cancel/i.test(err?.message || "")
        if (aborted) {
          console.log(theme.dim("\n⏹  Cancelled.\n"))
          if (session.messages[session.messages.length - 1]?.role === "user") {
            session.messages.pop()
            session.turnCount = Math.max(0, session.turnCount - 1)
          }
        } else {
          console.log(theme.error("\nError:"), err.message)
          if (err.cause) console.log(theme.dim(`  cause: ${err.cause.code || err.cause.message || err.cause}`))
          if (/fetch failed/i.test(err.message)) {
            console.log(theme.dim("  → Is Ollama running? Try `ollama serve` in another terminal."))
            console.log(theme.dim("  → If model OOMs with num_ctx=8192, try: NOBLE_NUM_CTX=4096 noble-ai"))
          }
          // Drop the in-flight user message so we don't poison the session
          if (session.messages[session.messages.length - 1]?.role === "user") {
            session.messages.pop()
            session.turnCount = Math.max(0, session.turnCount - 1)
          }
        }
      }

      prompt()
    })
  }

  prompt()
}
