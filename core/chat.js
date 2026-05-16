import readline from "readline"
import chalk from "chalk"
import ora from "ora"
import { getProjectContext } from "./context.js"
import { askModel, ollama } from "./llm.js"
import { webSearch } from "./search.js"
import { renderHeader } from "./header.js"
import { models } from "./models.js"
import { state } from "./state.js"
import { parseEdits, applyEdits, undoLast } from "./apply.js"
import { renderAssistant, renderEditSummary } from "./render.js"

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

// While a generation is running, `cancelGen` holds a function that aborts it.
// We swallow all input during that time and listen for Ctrl+D specifically.
let cancelGen = null

const _origTtyWrite = rl._ttyWrite.bind(rl)
rl._ttyWrite = function (s, key) {
  if (cancelGen) {
    if (key && key.ctrl && key.name === "d") cancelGen()
    return
  }
  return _origTtyWrite(s, key)
}

// Run `workFn()` but reject immediately if cancelGen() fires.
// We don't trust `ollama.abort()` to reject the underlying promise reliably,
// so we settle our own wrapper promise and let the in-flight request finish
// in the background (best-effort `ollama.abort()` as a hint).
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

// 🎨 Theme (light blue focus)
const theme = {
  primary: chalk.hex("#4FC3F7"),   // light blue
  secondary: chalk.hex("#81D4FA"),
  dim: chalk.gray,
  success: chalk.hex("#4FC3F7"),
  error: chalk.red
}


export async function startCLI() {
  await renderHeader()

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

      // ❓ Help / shortcuts
      if (input === "?" || input === "/help") {
        console.log(theme.primary("\nShortcuts & commands:"))
        console.log(theme.secondary("  /models      ") + theme.dim("list available models"))
        console.log(theme.secondary("  /model       ") + theme.dim("show the active model"))
        console.log(theme.secondary("  /model <x>   ") + theme.dim("switch model by name or number"))
        console.log(theme.secondary("  /undo        ") + theme.dim("revert the last applied file changes"))
        console.log(theme.secondary("  /clear       ") + theme.dim("clear the screen and redraw header"))
        console.log(theme.secondary("  Ctrl+D       ") + theme.dim("cancel a running generation"))
        console.log(theme.secondary("  Ctrl+C       ") + theme.dim("quit Noble AI"))
        console.log(theme.secondary("  exit         ") + theme.dim("quit Noble AI"))
        console.log(theme.dim("\nAnything else is sent to the model with project + web context.\n"))
        return prompt()
      }

      // ↩️  Undo last applied edits
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

      // 🧹 Clear screen
      if (input === "/clear") {
        await renderHeader()
        return prompt()
      }

      // 🧠 Model switch commands
      if (input === "/models") {
        console.log(theme.primary("\nAvailable models:"))
        models.forEach((m, i) => {
          const marker = m === state.model ? theme.success(" (active)") : ""
          console.log(theme.secondary(`  ${i + 1}. ${m}`) + marker)
        })
        console.log(theme.dim("\nSwitch with: /model <name>  or  /model <number>\n"))
        return prompt()
      }

      if (input === "/model") {
        console.log(theme.primary(`\nCurrent model: ${state.model}\n`))
        return prompt()
      }

      if (input.startsWith("/model ")) {
        const arg = input.slice(7).trim()
        const byIndex = Number.isInteger(+arg) ? models[+arg - 1] : null
        const target = byIndex || models.find(m => m === arg)

        if (!target) {
          console.log(theme.error(`\nUnknown model: ${arg}`))
          console.log(theme.dim("Use /models to see available models.\n"))
          return prompt()
        }

        state.model = target
        console.log(theme.success(`\nSwitched to ${target}\n`))
        return prompt()
      }

      // ⚡ Animated loader
      const spinner = ora({
        text: "thinking... (Ctrl+D to cancel)",
        color: "cyan"
      }).start()

      try {
        const response = await runWithCancel(async () => {
          const context = await getProjectContext(process.cwd(), input)
          const webContext = await webSearch(input)
          return askModel(
            input,
            `
          PROJECT CONTEXT:
          ${context}

          WEB SEARCH:
          ${webContext}
          `
          )
        })

        spinner.stop()

        const pretty = renderAssistant(response)
        if (pretty) process.stdout.write(pretty)

        const edits = parseEdits(response)
        if (edits.length > 0) {
          process.stdout.write("\n" + renderEditSummary(edits))
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
        spinner.stop()
        const aborted =
          err?.name === "AbortError" ||
          /abort|cancel/i.test(err?.message || "")
        if (aborted) {
          console.log(theme.dim("\n⏹  Cancelled.\n"))
        } else {
          console.log(theme.error("\nError:"), err.message)
        }
      }

      prompt()
    })
  }

  prompt()
}