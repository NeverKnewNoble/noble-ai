import readline from "readline"
import chalk from "chalk"
import ora from "ora"
import fs from "fs"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { getProjectContext, getProjectTree } from "./context.js"
import { askModel, ollama, buildSystemPrompt } from "./llm.js"
import { webSearch } from "./search.js"
import { renderHeader } from "./header.js"
import { models } from "./models.js"
import { state } from "./state.js"
import { parseEdits, applyEdits, undoLast, looksLikeMissedEdit } from "./apply.js"
import { renderEditSummary, renderAssistant, renderFileCard, createStreamSanitizer } from "./render.js"
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
    allowlist: [],  // session-level regex allowlist for the `run` tool
    formatReminder: false,  // set when the model described a file instead of writing it
    contextInjected: false, // full project context has been injected once
    treeInjected: false     // the lightweight file tree has been injected once
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

// Arrow-select menu (Claude-Code style). Renders a question and a list of
// options, lets the user move with ↑/↓ (or type the option number) and confirm
// with Enter. Returns the selected option's index, or -1 on Ctrl+C / Esc.
async function selectFromMenu(question, options) {
  let cur = 0

  const draw = (first) => {
    if (!first) {
      // Move back up over the option rows to repaint them in place.
      readline.moveCursor(process.stdout, 0, -options.length)
    }
    for (let i = 0; i < options.length; i++) {
      readline.clearLine(process.stdout, 0)
      const marker = i === cur ? theme.primary("❯") : " "
      const label = i === cur ? theme.primary(`${i + 1}. ${options[i]}`) : `${i + 1}. ${options[i]}`
      process.stdout.write(` ${marker} ${label}\n`)
    }
  }

  process.stdout.write("\n " + theme.primary(question) + "\n")
  draw(true)

  // Erase the whole menu (blank line + question + option rows) so the prompt
  // doesn't linger on screen after the user has already chosen.
  const erase = () => {
    readline.moveCursor(process.stdout, 0, -(options.length + 2))
    readline.clearScreenDown(process.stdout)
  }

  while (true) {
    const key = await readSingleKey()
    if (key === "\x1b[A" || key === "k") { cur = (cur - 1 + options.length) % options.length; draw(false) }
    else if (key === "\x1b[B" || key === "j") { cur = (cur + 1) % options.length; draw(false) }
    else if (key >= "1" && key <= String(options.length)) { cur = Number(key) - 1; erase(); return cur }
    else if (key === "\r" || key === "\n") { erase(); return cur }
    else if (key === "\x03" || key === "\x1b") { erase(); return -1 }
  }
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
    allowlist: [],
    formatReminder: false,
    // A resumed conversation already carries its context in the message history;
    // don't re-inject on the next turn.
    contextInjected: true,
    treeInjected: true
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
  // Track rows/columns live during streaming so we know exactly how far back
  // to walk the cursor when we overwrite with the prettified version. Counting
  // after the fact (split-on-newline + ceil(len/cols)) underestimated wraps
  // and left the top of the stream uncleared.
  let rowsEmitted = 0
  let cursorCol = 0
  const streamCols = process.stdout.columns || 80
  // Strips file-edit blocks out of the live stream so their contents don't
  // scroll by in the prose (the review card shows them instead).
  let sanitizer = createStreamSanitizer()
  // Once the model starts emitting a file-edit block we stop streaming prose and
  // keep the spinner running until the whole response is done — so the "thinking"
  // animation stays up right until the review card appears, instead of leaving a
  // silent gap while the (now-hidden) code is generated.
  let editMode = false
  let editEraseClean = true  // could we fully wipe the streamed prose on entering editMode?
  const SPIN = "thinking... (Ctrl+D to cancel)"

  // Write already-sanitized text to the terminal, starting the "✦ " segment on
  // first output and keeping the row/col counters in sync for the re-render.
  const emit = (out) => {
    if (!out) return
    if (!streaming) {
      if (spinner.isSpinning) spinner.stop()
      process.stdout.write("\n" + theme.primary("✦ "))
      streaming = true
      rowsEmitted = 0
      cursorCol = 2  // "✦ " occupies 2 columns
    }
    for (const ch of out) {
      if (ch === "\n") { rowsEmitted++; cursorCol = 0 }
      else if (ch === "\r") { cursorCol = 0 }
      else {
        cursorCol++
        if (cursorCol >= streamCols) { rowsEmitted++; cursorCol = 0 }
      }
    }
    process.stdout.write(out)
  }

  // Wipe whatever we've streamed for the current segment so it can be re-shown
  // (prettified) later. Used when an edit block starts mid-prose.
  const eraseStream = () => {
    if (!streaming) return
    readline.cursorTo(process.stdout, 0)
    if (rowsEmitted > 0) readline.moveCursor(process.stdout, 0, -rowsEmitted)
    readline.clearScreenDown(process.stdout)
    streaming = false
    rowsEmitted = 0
    cursorCol = 0
  }

  const onStatus = (text) => {
    emit(sanitizer.flush())              // flush any held prose from the segment
    sanitizer = createStreamSanitizer()  // a tool call ends this segment
    editMode = false
    if (streaming) { process.stdout.write("\n"); streaming = false }
    lastSegmentText = ""
    rowsEmitted = 0
    cursorCol = 0
    if (spinner.isSpinning) spinner.text = text
    else spinner = ora({ text, color: "cyan" }).start()
  }
  const onChunk = (text) => {
    lastSegmentText += text
    if (editMode) return  // spinner stays up; the prose is rendered at the end
    emit(sanitizer.push(text))
    if (sanitizer.inEditBlock()) {
      // Code is now streaming in (and being hidden). Drop any short intro prose
      // we showed and keep the spinner animating until the response completes.
      editMode = true
      // If the intro is taller than the viewport we can't fully wipe it (cursor
      // moves clamp at the top), so don't re-render prose at the end or it'll
      // duplicate. With a well-behaved model the intro is one short line.
      editEraseClean = rowsEmitted < (process.stdout.rows || 24) - 1
      eraseStream()
      if (spinner.isSpinning) spinner.text = SPIN
      else spinner = ora({ text: SPIN, color: "cyan" }).start()
    }
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
      // Context injection (each is a one-shot per session, gated by flags rather
      // than turn number so a leading "hey" doesn't burn it):
      //  • a project question ("what is this repo?") → just the file tree, so the
      //    model can describe the project without us dumping whole files it might
      //    echo back verbatim.
      //  • otherwise the first substantive request → the full ranked context +
      //    web search, to seed real work.
      if (!isTrivialInput(input)) {
        if (isProjectQuestion(input) && !session.treeInjected) {
          userContent += `\n\n--- PROJECT FILE TREE ---\n${getProjectTree(process.cwd())}`
          session.treeInjected = true
        } else if (!session.contextInjected && !isProjectQuestion(input)) {
          const context = await getProjectContext(process.cwd(), input)
          const webContext = await webSearch(input)
          userContent += `\n\n--- PROJECT CONTEXT ---\n${context}\n\n--- WEB SEARCH ---\n${webContext}`
          session.contextInjected = true
        }
      }
      if (session.formatReminder) {
        userContent +=
          "\n\n--- IMPORTANT: ACTUALLY WRITE THE FILE ---\n" +
          "A previous attempt showed the code but did NOT write the file. You MUST output it as:\n" +
          "<<<FILE: relative/path>>>\n<the raw file contents>\n<<<END>>>\n" +
          "Put the RAW contents between the markers — do NOT wrap them in ``` fences, and do NOT " +
          "show the code as indented or plain text. Keep any prose to one short sentence."
        session.formatReminder = false
      }
      session.messages.push({ role: "user", content: userContent })
      session.turnCount++
      session.lastUserInput = input
      return askModel(session.messages, onStatus, onChunk, {
        confirm: onConfirm,
        extraAllowlist: session.allowlist
      })
    })

    if (editMode) {
      // The spinner ran through the whole code generation. Stop it now and print
      // the prettified prose; the review card follows right after this returns.
      if (spinner.isSpinning) spinner.stop()
      if (editEraseClean) {
        const pretty = renderAssistant(lastSegmentText)
        if (pretty) process.stdout.write(pretty.startsWith("\n") ? pretty.slice(1) : pretty)
      } else {
        process.stdout.write("\n")  // couldn't wipe the streamed intro — don't duplicate it
      }
      streaming = false
    } else {
      emit(sanitizer.flush())  // emit any prose held back waiting for a newline

      if (streaming) {
        // Re-render the final segment as prettified markdown — but ONLY when
        // the raw stream still fits in the viewport. If output has scrolled
        // past the top, the start of the stream lives in scrollback and
        // moveCursor will clamp at row 0, leaving the scrolled-off portion
        // visible above the rerender (which manifests as duplicated output).
        const viewportRows = process.stdout.rows || 24
        const canOverwrite = rowsEmitted < viewportRows - 1
        if (canOverwrite) {
          readline.cursorTo(process.stdout, 0)
          if (rowsEmitted > 0) readline.moveCursor(process.stdout, 0, -rowsEmitted)
          readline.clearScreenDown(process.stdout)
          const pretty = renderAssistant(lastSegmentText)
          process.stdout.write(pretty.startsWith("\n") ? pretty.slice(1) : pretty)
        } else {
          process.stdout.write("\n\n")
        }
        streaming = false
      } else if (spinner.isSpinning) {
        spinner.stop()
      }
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

// A straight full-width rule, used to frame the input line above and below.
function hr() {
  return theme.primary("─".repeat(process.stdout.columns || 80))
}

// Greetings / pleasantries that should get a plain conversational reply — no
// project-context dump, no file creation.
const TRIVIAL_INPUT =
  /^\s*(hi+|hey+|hello+|yo|sup|hiya|howdy|good\s+(morning|afternoon|evening|night)|thanks?|thank\s+you|ty|ok(ay)?|cool|nice|great|lol|gg|ping|test|who\s+are\s+you|what\s+can\s+you\s+do)\b[\s.!?]*$/i
function isTrivialInput(s) {
  return TRIVIAL_INPUT.test((s || "").trim())
}

// Did the user actually ask for a file to be created/changed? Gates the
// missed-edit auto-retry so we never force-write a file the user didn't request.
function userWantsFile(s) {
  return /\b(creat|mak(e|ing)|build|writ(e|ing)|add|implement|generat|scaffold|set\s?up|edit|updat|modif|fix|refactor|renam|delet|remov|append|insert|replac)/i.test(s || "")
}

// Is the user asking ABOUT the project (what it is / how it's structured), as
// opposed to asking to build something? Triggers a lightweight file-tree inject.
const PROJECT_QUESTION =
  /\b(project|repo|repository|codebase|code\s?base|directory\s+structure|file\s+tree|folder\s+structure)\b|\b(what(?:'s| is| does| are)|tell me about|explain|describe|overview of|walk me through|summari[sz]e)\b[^]*\b(this|it|here|repo|project|app|code)\b/i
function isProjectQuestion(s) {
  return PROJECT_QUESTION.test(s || "") && !userWantsFile(s)
}

// A centered "Goodbye" banner framed by rules spanning the terminal width.
function farewell() {
  const cols = Math.min(process.stdout.columns || 60, 80)
  const label = " Goodbye 👋 "
  const labelW = 12  // visible width (👋 counts as 2 columns)
  const left = Math.max(0, Math.floor((cols - labelW) / 2))
  const right = Math.max(0, cols - labelW - left)
  return theme.primary("─".repeat(left)) + theme.primary.bold(label) + theme.primary("─".repeat(right))
}

export async function startCLI() {
  await renderHeader()
  let session = newSession()

  rl.on("close", () => {
    console.log(farewell())
    process.exit(0)
  })

  function prompt() {
    console.log(hr())   // top of the input frame
    askLine()
  }

  function askLine() {
    rl.question(theme.primary("❯❯") + " ", async (input) => {
      if (!input.trim()) return askLine()  // reuse the same frame, no new rule
      if (input.trim() === "exit") {        // the goodbye banner is the closing rule
        console.log(farewell())
        process.exit(0)
      }
      console.log(hr())                    // close the frame under what was typed
      saveHistoryEntry(input)

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
        // If the user wanted a file and the last reply only described it, remind
        // the model to use a writable format on the retry.
        if (userWantsFile(session.lastUserInput) && looksLikeMissedEdit(session.lastResponse)) {
          session.formatReminder = true
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
        // Only auto-retry when the user actually asked for a file — otherwise a
        // model that spontaneously "describes a file" (e.g. for a greeting) would
        // get nagged into writing something nobody requested.
        if (userWantsFile(input) && looksLikeMissedEdit(result.response)) {
          // The model described the file instead of emitting a writable block.
          // Roll back the bad turn and retry ONCE with a strong format reminder.
          console.log(theme.dim("\n  (the model described the file instead of writing it — retrying once…)\n"))
          popLastTurn(session)
          session.formatReminder = true
          const retry = await runTurn(session.lastUserInput || input, session)
          if (retry.ok) {
            const redits = parseEdits(retry.response)
            if (redits.length > 0) return promptForEdits(redits, prompt)
            warnIfMissedEdit(retry.response, session)  // give up gracefully
          }
        }
      }
      prompt()
    })
  }

  async function promptForEdits(edits, next) {
    const accepted = []
    let acceptAll = false

    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]
      if (acceptAll) { accepted.push(e); continue }

      const full = path.resolve(process.cwd(), e.path)
      const existed = fs.existsSync(full)
      const base = path.basename(e.path)

      process.stdout.write("\n" + renderFileCard(e))

      const choice = await selectFromMenu(
        `Do you want to ${existed ? "make this edit to" : "create"} ${base}?`,
        ["Yes", "Yes, allow all edits during this session", "No"]
      )

      if (choice === 0) { accepted.push(e) }
      else if (choice === 1) { accepted.push(e); acceptAll = true }
      else { /* No / cancel — skip this file */ }
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
