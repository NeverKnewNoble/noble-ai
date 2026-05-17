import readline from "readline"
import chalk from "chalk"
import ora from "ora"
import fs from "fs"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { getProjectContext } from "./context.js"
import { askModel, ollama, buildSystemPrompt } from "./llm.js"
import { webSearch } from "./search.js"
import { renderHeader } from "./header.js"
import { models } from "./models.js"
import { state } from "./state.js"
import { parseEdits, applyEdits, undoLast, looksLikeMissedEdit } from "./apply.js"
import { renderEditSummary, renderAssistant, renderFileDiff } from "./render.js"
import { extractReferences, buildReferenceContext, completeReference } from "./references.js"

const HISTORY_FILE = path.join(os.homedir(), ".noble", "history")
const SESSIONS_DIR = path.join(os.homedir(), ".noble", "sessions")
const HISTORY_MAX = 500

const SLASH_COMMANDS = [
  "/help", "/models", "/model", "/undo", "/clear",
  "/retry", "/copy", "/tokens", "/save", "/load", "/sessions",
  "/keytest"
]

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
  historySize: HISTORY_MAX
})

loadHistory()

let cancelGen = null
let atHintShown = false

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8")
    // readline expects most-recent-first
    const lines = raw.split("\n").filter(Boolean).reverse()
    rl.history.push(...lines)
  } catch {}
}

function saveHistoryEntry(entry) {
  if (!entry || !entry.trim()) return
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true })
    let existing = ""
    try { existing = fs.readFileSync(HISTORY_FILE, "utf-8") } catch {}
    const lines = existing.split("\n").filter(Boolean)
    lines.push(entry)
    const trimmed = lines.slice(-HISTORY_MAX)
    fs.writeFileSync(HISTORY_FILE, trimmed.join("\n") + "\n")
  } catch {}
}

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

// TAB on a slash command at line start: complete from SLASH_COMMANDS.
function handleSlashCompletion() {
  const line = rl.line
  const cursor = rl.cursor
  const before = line.slice(0, cursor)
  const after = line.slice(cursor)

  // Only complete the command token itself, not its args
  const m = before.match(/^(\/\S*)$/)
  if (!m) return false
  const stem = m[1]

  const matches = SLASH_COMMANDS.filter(c => c.startsWith(stem))
  if (matches.length === 0) {
    process.stdout.write("\n  (no slash commands match " + stem + ")\n")
    rl._refreshLine()
    return true
  }

  if (matches.length === 1) {
    const insertion = matches[0]
    rl.line = insertion + after
    rl.cursor = insertion.length
    rl._refreshLine()
    return true
  }

  const common = findCommonPrefix(matches)
  if (common.length > stem.length) {
    rl.line = common + after
    rl.cursor = common.length
    rl._refreshLine()
    return true
  }

  process.stdout.write("\n")
  for (const c of matches) process.stdout.write("  " + chalk.cyan(c) + "\n")
  process.stdout.write("\n")
  rl._refreshLine()
  return true
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
    if (/^\/\S*$/.test(before)) {
      if (handleSlashCompletion()) return
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
    turnCount: 0,
    lastResponse: "",
    lastUserInput: "",
    allowlist: []  // session-level regex allowlist for the `run` tool
  }
}

// Read a single key without going through readline's line buffer.
//
// rl.pause() alone is not enough — readline's keypress handler still fires
// and echoes/buffers the byte, which both double-echoes ("yy") AND leaks the
// key into the next rl.question(). We swap _ttyWrite for a no-op so readline
// ignores every key while we're reading raw bytes off stdin directly.
function readSingleKey() {
  return new Promise((resolve) => {
    const savedCancel = cancelGen
    const savedTtyWrite = rl._ttyWrite
    cancelGen = null
    rl._ttyWrite = () => {}
    const wasRaw = process.stdin.isRaw
    process.stdin.setRawMode(true)
    process.stdin.resume()

    const onData = (chunk) => {
      process.stdin.removeListener("data", onData)
      process.stdin.setRawMode(wasRaw)
      rl._ttyWrite = savedTtyWrite
      cancelGen = savedCancel
      resolve(chunk.toString())
    }
    process.stdin.on("data", onData)
  })
}

// Build an allowlist regex from a user-approved command. Match the first 1-2
// tokens so re-runs with varied flags don't re-prompt. Conservative on purpose.
function makeAllowPattern(command) {
  const parts = command.trim().split(/\s+/).slice(0, 2)
  const prefix = parts.join(" ")
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped}(\\s|$)`)
}

async function confirmShellCommand(command, session) {
  // Make sure any active spinner doesn't keep redrawing over our prompt
  process.stdout.write(
    "\n" + chalk.yellow("⚠ Shell command requested") + "\n" +
    "  " + chalk.bold("$ " + command) + "\n" +
    "  " + theme.dim("[y]es  [n]o  [a]lways for `") + theme.secondary(command.split(/\s+/).slice(0, 2).join(" ")) + theme.dim("`  > ")
  )
  const key = (await readSingleKey()).toLowerCase()
  process.stdout.write(key + "\n")

  if (key === "a") {
    session.allowlist.push(makeAllowPattern(command))
    console.log(theme.dim("  (added to session allowlist)\n"))
    return "always"
  }
  if (key === "y" || key === "\r" || key === "\n") return "allow"
  return "deny"
}

function sanitizeSessionName(name) {
  return name.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 64)
}

function saveSession(session, name) {
  const safe = sanitizeSessionName(name)
  if (!safe) throw new Error("invalid session name")
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  const file = path.join(SESSIONS_DIR, `${safe}.json`)
  const payload = {
    name: safe,
    savedAt: new Date().toISOString(),
    model: state.model,
    turnCount: session.turnCount,
    messages: session.messages,
    lastResponse: session.lastResponse,
    lastUserInput: session.lastUserInput
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  return file
}

function loadSession(name) {
  const safe = sanitizeSessionName(name)
  const file = path.join(SESSIONS_DIR, `${safe}.json`)
  if (!fs.existsSync(file)) throw new Error(`session "${safe}" not found`)
  const data = JSON.parse(fs.readFileSync(file, "utf-8"))
  return {
    messages: data.messages || [{ role: "system", content: buildSystemPrompt() }],
    turnCount: data.turnCount || 0,
    lastResponse: data.lastResponse || "",
    lastUserInput: data.lastUserInput || "",
    allowlist: []
  }
}

function listSessions() {
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const full = path.join(SESSIONS_DIR, f)
        const stat = fs.statSync(full)
        return { name: f.replace(/\.json$/, ""), mtime: stat.mtime, size: stat.size }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch { return [] }
}

function countVisualLines(text, cols) {
  cols = cols || 80
  let total = 0
  for (const line of text.split("\n")) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, "")
    total += Math.max(1, Math.ceil(visible.length / cols))
  }
  return total
}

// Rough token estimate. Real tokenization would need a tokenizer; chars/4 is
// the standard back-of-envelope for English+code and is good enough to warn
// the user before they OOM.
function estimateTokens(messages) {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length
  }
  return Math.round(chars / 4)
}

function copyToClipboard(text) {
  const platform = process.platform
  let cmd, args
  if (platform === "darwin") { cmd = "pbcopy"; args = [] }
  else if (platform === "win32") { cmd = "clip"; args = [] }
  else { cmd = "xclip"; args = ["-selection", "clipboard"] }

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })
    proc.on("error", reject)
    proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)))
    proc.stdin.end(text)
  })
}

// Drop the last user turn (and any assistant/tool messages after it) so /retry
// can resend the same input — and so on transient errors we don't leave the
// session in a half-broken state.
function popLastTurn(session) {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === "user") {
      const userMsg = session.messages[i]
      session.messages.splice(i)
      session.turnCount = Math.max(0, session.turnCount - 1)
      return userMsg
    }
  }
  return null
}

// Strip the appended PROJECT CONTEXT / WEB SEARCH / REFERENCED FILES blocks
// from a stored user message so /retry re-resolves them fresh against current
// state (and doesn't blow up the context window with a duplicate copy).
function stripAppendedContext(content) {
  return content
    .replace(/\n\n--- REFERENCED FILES ---[\s\S]*$/, "")
    .replace(/\n\n--- PROJECT CONTEXT ---[\s\S]*$/, "")
    .replace(/\n\n--- WEB SEARCH ---[\s\S]*$/, "")
    .trim()
}

// Resolve @-refs against the input and print a one-line summary per ref to
// the console so the user sees what we attached.
function resolveAndPrintRefs(input) {
  const refs = extractReferences(input)
  for (const ref of refs) {
    if (ref.error) {
      console.log(theme.dim(`  @${ref.token} `) + theme.error(`✗ ${ref.error}`))
      continue
    }
    if (ref.isUrl) {
      console.log(theme.dim(`  🌐 ${ref.token}`))
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
  return refs
}

// The core "send a turn" path, factored out so /retry and (future) --prompt
// mode can both drive it without going through the readline prompt.
async function runTurn(input, session) {
  const refs = resolveAndPrintRefs(input)

  let spinner = ora({ text: "thinking... (Ctrl+D to cancel)", color: "cyan" }).start()
  let streaming = false
  let lastSegmentText = ""  // raw text from the final stream segment, for markdown re-render

  const onStatus = (text) => {
    if (streaming) { process.stdout.write("\n"); streaming = false }
    lastSegmentText = ""  // a tool call ended the previous segment; new one starts fresh
    if (spinner.isSpinning) spinner.text = text
    else spinner = ora({ text, color: "cyan" }).start()
  }
  const onChunk = (text) => {
    if (!streaming) {
      if (spinner.isSpinning) spinner.stop()
      process.stdout.write("\n" + theme.primary("☻ "))
      streaming = true
    }
    lastSegmentText += text
    process.stdout.write(text)
  }
  const onConfirm = async (command) => {
    if (spinner.isSpinning) spinner.stop()
    if (streaming) { process.stdout.write("\n"); streaming = false }
    const decision = await confirmShellCommand(command, session)
    spinner = ora({ text: `run(${command.split(" ")[0]})...`, color: "cyan" }).start()
    return decision
  }

  try {
    const response = await runWithCancel(async () => {
      let userContent = input
      const refContext = await buildReferenceContext(refs, process.cwd())
      if (refContext) userContent += `\n\n--- REFERENCED FILES ---\n${refContext}`
      if (session.turnCount === 0) {
        const context = await getProjectContext(process.cwd(), input)
        const webContext = await webSearch(input)
        userContent += `\n\n--- PROJECT CONTEXT ---\n${context}\n\n--- WEB SEARCH ---\n${webContext}`
      }
      session.messages.push({ role: "user", content: userContent })
      session.turnCount++
      session.lastUserInput = input
      return askModel(session.messages, onStatus, onChunk, {
        confirm: onConfirm,
        extraAllowlist: session.allowlist
      })
    })

    if (streaming) {
      // Re-render the final segment as markdown by clearing the raw stream
      // and printing the prettified version in its place.
      const cols = process.stdout.columns || 80
      const lines = countVisualLines("☻ " + lastSegmentText, cols)
      readline.cursorTo(process.stdout, 0)
      readline.moveCursor(process.stdout, 0, -(lines - 1))
      readline.clearScreenDown(process.stdout)
      const pretty = renderAssistant(lastSegmentText)
      process.stdout.write(pretty.startsWith("\n") ? pretty.slice(1) : pretty)
      streaming = false
    } else if (spinner.isSpinning) {
      spinner.stop()
    }

    session.lastResponse = response
    return { ok: true, response }
  } catch (err) {
    if (streaming) process.stdout.write("\n")
    if (spinner.isSpinning) spinner.stop()
    const aborted = err?.name === "AbortError" || /abort|cancel/i.test(err?.message || "")
    if (aborted) {
      console.log(theme.dim("\n⏹  Cancelled.\n"))
    } else {
      console.log(theme.error("\nError:"), err.message)
      if (err.cause) console.log(theme.dim(`  cause: ${err.cause.code || err.cause.message || err.cause}`))
      if (/fetch failed/i.test(err.message)) {
        console.log(theme.dim("  → Is Ollama running? Try `ollama serve` in another terminal."))
        console.log(theme.dim("  → If model OOMs with num_ctx=8192, try: NOBLE_NUM_CTX=4096 noble-ai"))
      }
    }
    popLastTurn(session)
    return { ok: false, aborted }
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
      saveHistoryEntry(input)

      if (input === "exit") {
        console.log(theme.dim("\nGoodbye 👋"))
        process.exit(0)
      }

      if (input === "?" || input === "/help") {
        console.log(theme.primary("\nConversation commands:"))
        console.log(theme.secondary("  /retry       ") + theme.dim("regenerate the last response"))
        console.log(theme.secondary("  /copy        ") + theme.dim("copy the last response to clipboard"))
        console.log(theme.secondary("  /tokens      ") + theme.dim("estimate context-window usage"))
        console.log(theme.secondary("  /clear       ") + theme.dim("clear screen + reset conversation"))
        console.log(theme.primary("\nSession persistence:"))
        console.log(theme.secondary("  /save <name> ") + theme.dim("save the current conversation to ~/.noble/sessions/"))
        console.log(theme.secondary("  /load <name> ") + theme.dim("resume a saved conversation"))
        console.log(theme.secondary("  /sessions    ") + theme.dim("list saved conversations"))
        console.log(theme.primary("\nModels & edits:"))
        console.log(theme.secondary("  /models      ") + theme.dim("list available models"))
        console.log(theme.secondary("  /model       ") + theme.dim("show the active model"))
        console.log(theme.secondary("  /model <x>   ") + theme.dim("switch model by name or number"))
        console.log(theme.secondary("  /undo        ") + theme.dim("revert the last applied file changes"))
        console.log(theme.primary("\nFile references (TAB to complete):"))
        console.log(theme.secondary("  @path/to/file       ") + theme.dim("inject a file"))
        console.log(theme.secondary("  @file.js            ") + theme.dim("bare filename — searches the tree"))
        console.log(theme.secondary("  @core/*.js          ") + theme.dim("glob — inject all matches"))
        console.log(theme.secondary("  @**/chat.js         ") + theme.dim("recursive glob"))
        console.log(theme.secondary("  @core/chat.js:50-100") + theme.dim(" only those lines"))
        console.log(theme.secondary("  @core/              ") + theme.dim("dump all files in a directory"))
        console.log(theme.secondary("  @https://...        ") + theme.dim("fetch URL contents"))
        console.log(theme.primary("\nWhen the model proposes edits:"))
        console.log(theme.secondary("  y/n          ") + theme.dim("accept / reject this file"))
        console.log(theme.secondary("  d            ") + theme.dim("re-show the diff for this file"))
        console.log(theme.secondary("  a            ") + theme.dim("accept all remaining files"))
        console.log(theme.secondary("  s            ") + theme.dim("skip all remaining files"))
        console.log(theme.primary("\nWhen the model wants to run a shell command:"))
        console.log(theme.secondary("  y/n          ") + theme.dim("allow / deny this one command"))
        console.log(theme.secondary("  a            ") + theme.dim("always allow this command (session-scoped)"))
        console.log(theme.dim("  Read-only commands (ls, cat, git status/log/diff, npm list, …) auto-run."))
        console.log(theme.primary("\nKeys:"))
        console.log(theme.secondary("  TAB          ") + theme.dim("autocomplete @-references or slash commands"))
        console.log(theme.secondary("  ↑/↓          ") + theme.dim("scroll through prompt history (persists across runs)"))
        console.log(theme.secondary("  Ctrl+D       ") + theme.dim("cancel a running generation"))
        console.log(theme.secondary("  Ctrl+C       ") + theme.dim("quit Noble AI"))
        console.log(theme.secondary("  exit         ") + theme.dim("quit Noble AI"))
        console.log(theme.dim("\nAnything else is sent to the model with project + web + ref context.\n"))
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

      if (input === "/retry") {
        const popped = popLastTurn(session)
        if (!popped) {
          console.log(theme.dim("\nNothing to retry.\n"))
          return prompt()
        }
        const replayInput = session.lastUserInput || stripAppendedContext(popped.content)
        console.log(theme.dim(`\n↻ retrying: `) + theme.secondary(replayInput.split("\n")[0].slice(0, 80)))
        const result = await runTurn(replayInput, session)
        if (result.ok) {
          const edits = parseEdits(result.response)
          if (edits.length > 0) return promptForEdits(edits, prompt)
          warnIfMissedEdit(result.response, session)
        }
        return prompt()
      }

      if (input === "/copy") {
        if (!session.lastResponse) {
          console.log(theme.dim("\nNothing to copy yet.\n"))
          return prompt()
        }
        try {
          await copyToClipboard(session.lastResponse)
          console.log(theme.success(`\nCopied ${session.lastResponse.length} chars to clipboard.\n`))
        } catch (err) {
          console.log(theme.error("\nClipboard copy failed: ") + theme.dim(err.message))
          console.log(theme.dim("  (need pbcopy / xclip / clip on PATH)\n"))
        }
        return prompt()
      }

      if (input === "/tokens") {
        const used = estimateTokens(session.messages)
        const limit = Number(process.env.NOBLE_NUM_CTX) || 8192
        const pct = Math.round((used / limit) * 100)
        const bar = renderBar(pct)
        const color = pct >= 90 ? theme.error : pct >= 70 ? chalk.yellow : theme.success
        console.log(theme.primary("\nContext usage (rough estimate):"))
        console.log(`  ${bar} ${color(`${used} / ${limit} tok (${pct}%)`)}`)
        console.log(theme.dim(`  ${session.messages.length} messages · turn ${session.turnCount}`))
        console.log(theme.dim(`  Override with NOBLE_NUM_CTX=<n>\n`))
        return prompt()
      }

      if (input.startsWith("/save")) {
        const name = input.slice(5).trim()
        if (!name) {
          console.log(theme.error("\nUsage: /save <name>\n"))
          return prompt()
        }
        try {
          const file = saveSession(session, name)
          console.log(theme.success(`\nSaved session → `) + theme.secondary(file) + "\n")
        } catch (err) {
          console.log(theme.error("\nSave failed: ") + err.message + "\n")
        }
        return prompt()
      }

      if (input.startsWith("/load")) {
        const name = input.slice(5).trim()
        if (!name) {
          console.log(theme.error("\nUsage: /load <name>\n"))
          return prompt()
        }
        try {
          session = loadSession(name)
          console.log(theme.success(`\nLoaded session "${name}"`) + theme.dim(` — ${session.messages.length} messages, turn ${session.turnCount}\n`))
        } catch (err) {
          console.log(theme.error("\nLoad failed: ") + err.message + "\n")
        }
        return prompt()
      }

      if (input === "/sessions") {
        const list = listSessions()
        if (list.length === 0) {
          console.log(theme.dim("\nNo saved sessions yet. Save one with /save <name>.\n"))
        } else {
          console.log(theme.primary("\nSaved sessions:"))
          const nameWidth = Math.max(...list.map(s => s.name.length))
          for (const s of list) {
            const age = formatAge(s.mtime)
            console.log(`  ${theme.secondary(s.name.padEnd(nameWidth))}  ${theme.dim(age)}  ${theme.dim((s.size / 1024).toFixed(1) + " KB")}`)
          }
          console.log(theme.dim("\nResume with: /load <name>\n"))
        }
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

      const result = await runTurn(input, session)
      if (result.ok) {
        const edits = parseEdits(result.response)
        if (edits.length > 0) return promptForEdits(edits, prompt)
        warnIfMissedEdit(result.response, session)
      }
      prompt()
    })
  }

  async function promptForEdits(edits, next) {
    console.log(theme.primary(`\nProposed changes (${edits.length} file${edits.length === 1 ? "" : "s"}):`))
    for (const e of edits) console.log(theme.secondary(`  • ${e.path}`))
    console.log("")

    const accepted = []
    let acceptAll = false

    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]
      if (acceptAll) { accepted.push(e); continue }

      process.stdout.write(renderFileDiff(e))

      let decision = null
      while (decision === null) {
        process.stdout.write(theme.primary(`[${i + 1}/${edits.length}] `) + theme.dim("[y]es  [n]o  [d]iff again  [a]ll remaining  [s]kip all  > "))
        const key = (await readSingleKey()).toLowerCase()
        process.stdout.write(key + "\n")
        if (key === "y" || key === "\r" || key === "\n") { accepted.push(e); decision = "y" }
        else if (key === "n") { decision = "n" }
        else if (key === "a") { accepted.push(e); acceptAll = true; decision = "a" }
        else if (key === "s") { decision = "s"; i = edits.length }  // break the outer loop
        else if (key === "d") { process.stdout.write(renderFileDiff(e)) }
        else if (key === "\x03") { decision = "s"; i = edits.length }  // Ctrl+C → skip
      }
    }

    if (accepted.length === 0) {
      console.log(theme.dim("\nNo changes applied.\n"))
    } else {
      const snap = applyEdits(accepted)
      const skipped = edits.length - accepted.length
      const skippedNote = skipped > 0 ? theme.dim(` (${skipped} skipped)`) : ""
      console.log(theme.success(`\nApplied ${snap.files.length} file(s).`) + skippedNote + theme.dim(" Use /undo to revert.\n"))
    }
    next()
  }

  prompt()
}

// If the model emitted code that looks like a file edit but the parser found
// nothing, tell the user AND inject a correction into the message history so
// the next turn can self-correct instead of repeating the same mistake.
function warnIfMissedEdit(response, session) {
  if (!looksLikeMissedEdit(response)) return false
  console.log(theme.error("\n⚠ Heads up: ") + theme.dim("the model emitted code that looks like a file edit,"))
  console.log(theme.dim("   but didn't use a format Noble AI can parse. Nothing was written."))
  console.log(theme.dim("   Try /retry — the model has been reminded of the correct format.\n"))
  session.messages.push({
    role: "system",
    content:
      "REMINDER: Your previous reply included code that looked like it was meant to create a file, " +
      "but you used the wrong format (likely a `// File: path` comment inside the code block, " +
      "or a code block with no file marker at all). NO FILE WAS WRITTEN. " +
      "Do not claim the file was created — it was not. " +
      "To save a file, you MUST use one of:\n" +
      "  <<<FILE: relative/path>>>\\n<full contents>\\n<<<END>>>\n" +
      "or\n" +
      "  ### File: `relative/path`\\n```lang\\n<full contents>\\n```\n" +
      "Do NOT put the path inside the code block as a comment."
  })
  return true
}

function formatAge(date) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function renderBar(pct, width = 24) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  const empty = width - filled
  return chalk.cyan("█".repeat(filled)) + chalk.gray("░".repeat(empty))
}

// One-shot mode: run a single prompt, print the response, optionally apply
// edits, and exit. Used by --prompt / piped stdin in bin/noble.js.
export async function runOneShot(input, { autoApply = false } = {}) {
  const session = newSession()
  const result = await runTurn(input, session)
  if (!result.ok) process.exit(1)

  const edits = parseEdits(result.response)
  if (edits.length === 0) {
    warnIfMissedEdit(result.response, session)
    return
  }

  process.stdout.write(renderEditSummary(edits))
  if (autoApply) {
    const snap = applyEdits(edits)
    console.log(theme.success(`\nApplied ${snap.files.length} file(s).\n`))
  } else {
    console.log(theme.dim("\n(re-run with --apply to write these to disk)\n"))
  }
}
