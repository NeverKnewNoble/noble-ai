import { marked } from "marked"
import { markedTerminal } from "marked-terminal"
import chalk from "chalk"
import { highlight } from "cli-highlight"
import { structuredPatch } from "diff"
import fs from "fs"
import path from "path"

const primary = chalk.hex("#4FC3F7")
const secondary = chalk.hex("#81D4FA")
const dim = chalk.gray

function highlightCode(code, lang) {
  try {
    return highlight(code, { language: lang || "plaintext", ignoreIllegals: true })
  } catch {
    return code
  }
}

marked.use(
  markedTerminal({
    reflowText: false,
    tab: 2,
    code: (code, lang) => highlightCode(code, lang),
    blockquote: dim.italic,
    heading: primary.bold,
    firstHeading: primary.bold,
    hr: dim,
    listitem: chalk.white,
    list: (body) => body,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.cyan,
    del: chalk.strikethrough,
    link: secondary.underline,
    href: secondary.underline,
    paragraph: (text) => text + "\n"
  })
)

// Every file-edit format parseEdits() understands, so we can strip them out of
// the assistant's prose — the contents are shown in the review card instead, and
// we never want them dumped twice. Mirrors the regexes in core/apply.js.
const PREFERRED_BLOCK = /^[ \t]*<<<FILE:[^>\n]+>>>[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*<<<END>>>/gm
const MD_BLOCK = /(?:#{1,6}\s+(?:\*\*)?File:(?:\*\*)?|\*\*File:)\s*`[^`\n]+`(?:\*\*)?\s*\n+```[a-zA-Z0-9_+-]*\n[\s\S]*?\n```/g
const INLINE_BLOCK = /```[a-zA-Z0-9_+-]*\r?\n[ \t]*(?:\/\/|#|--)[ \t]*File:[ \t]*[^\n]+?[ \t]*\r?\n[\s\S]*?\r?\n```/g

// A plain-text tool call the model leaked into prose, e.g.
//   {"name": "list_dir", "arguments": {"path": "."}}
// These are executed by the model loop, not meant for the user to read.
const TOOL_CALL_JSON = /^\s*\{.*"name"\s*:\s*"[^"]+".*"arguments"\s*:.*\}\s*$/

function stripEditBlocks(raw) {
  return raw
    .replace(PREFERRED_BLOCK, "")
    .replace(MD_BLOCK, "")
    .replace(INLINE_BLOCK, "")
    .split("\n")
    .filter(line => !TOOL_CALL_JSON.test(line))
    .join("\n")
}

function indent(text, prefix, contLeader) {
  const lines = text.split("\n")
  return lines
    .map((line, i) => {
      if (i === 0) return prefix + line
      if (line.trim() === "") return ""
      return contLeader + line
    })
    .join("\n")
}

function tighten(text) {
  return text
    .split("\n")
    .map(line => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function renderAssistant(raw) {
  const stripped = stripEditBlocks(raw).trim()
  if (!stripped) return ""

  const rendered = tighten(marked.parse(stripped))
  const body = indent(rendered, primary("✦ "), "  ")
  return "\n" + body + "\n\n"
}

// Live-stream sanitizer. The model streams its reply token-by-token, and that
// stream can contain whole file-edit blocks (the user sees the file contents
// scroll by, then the review card shows them AGAIN). This strips edit blocks out
// of the stream as it arrives so the prose stays clean — the contents only ever
// appear in the card.
//
// It works line-by-line: a partial line is held until its newline arrives,
// because we can't tell whether `### File: ...` is starting until the line is
// complete. Code fences are held one line so we can peek the first line and
// decide whether it's a real snippet (keep) or an inline `// File:` edit (drop).
//
// Usage: const s = createStreamSanitizer(); process.stdout.write(s.push(chunk));
//        ... at end: process.stdout.write(s.flush())
const FENCE = /^[ \t]*```/
const MARK_PREFERRED = /^[ \t]*<<<FILE:/
const MARK_PREFERRED_END = /^[ \t]*<<<END>>>/
const MARK_MD_HEADING = /^[ \t]*(?:#{1,6}\s+(?:\*\*)?File:|\*\*File:)\s*`/
const MARK_INLINE_FILE = /^[ \t]*(?:\/\/|#|--)[ \t]*File:[ \t]*\S/

export function createStreamSanitizer() {
  let pending = ""        // partial line not yet terminated by "\n"
  let held = ""           // a code-fence opener we're deciding about
  let mode = "normal"     // normal | preferred | expectFence | drop | fenceOpen | keepFence

  // Classify one complete line; return the text to display (without newline) or
  // null to suppress it.
  function step(line) {
    switch (mode) {
      case "normal":
        if (MARK_PREFERRED.test(line)) { mode = "preferred"; return null }
        if (MARK_MD_HEADING.test(line)) { mode = "expectFence"; return null }
        if (TOOL_CALL_JSON.test(line)) return null  // leaked text tool call — hide it
        if (FENCE.test(line)) { mode = "fenceOpen"; held = line; return null }
        return line
      case "preferred":
        if (MARK_PREFERRED_END.test(line)) mode = "normal"
        return null
      case "expectFence":                       // after "### File:" — fence is next
        if (FENCE.test(line)) { mode = "drop"; return null }
        if (line.trim() === "") return null      // blank line(s) before the fence
        mode = "normal"; return line             // no fence followed — not an edit
      case "drop":                              // inside a suppressed file block
        if (FENCE.test(line)) mode = "normal"
        return null
      case "fenceOpen": {                        // decide: inline edit or real snippet?
        if (MARK_INLINE_FILE.test(line)) { mode = "drop"; held = ""; return null }
        const out = held + "\n" + line
        held = ""
        mode = FENCE.test(line) ? "normal" : "keepFence"
        return out
      }
      case "keepFence":                          // a normal code block — show it
        if (FENCE.test(line)) mode = "normal"
        return line
    }
  }

  return {
    push(chunk) {
      pending += chunk
      let out = ""
      let nl
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        const shown = step(line)
        if (shown !== null) out += shown + "\n"
      }
      return out
    },
    flush() {
      let out = ""
      if (mode === "fenceOpen") out = held + (pending ? "\n" + pending : "")
      else if (mode === "keepFence") out = pending
      else if (mode === "normal" && !TOOL_CALL_JSON.test(pending)) out = pending
      // preferred / expectFence / drop: an unterminated edit block — suppress.
      pending = ""; held = ""
      return out
    },
    // True once we're committed to a file-edit block (so the caller can show a
    // spinner instead of an awkward silent gap while the code streams in).
    inEditBlock() {
      return mode === "preferred" || mode === "expectFence" || mode === "drop"
    }
  }
}

const MAX_DIFF_LINES_PER_FILE = 120

function renderUnifiedDiff(relPath, original, updated) {
  const patch = structuredPatch(relPath, relPath, original, updated, "", "", { context: 2 })
  if (patch.hunks.length === 0) return dim("    (no textual changes)")

  const lines = []
  let totalLines = 0
  let truncated = false

  for (const hunk of patch.hunks) {
    if (totalLines >= MAX_DIFF_LINES_PER_FILE) { truncated = true; break }
    lines.push(chalk.cyan(`    @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`))
    for (const line of hunk.lines) {
      if (totalLines >= MAX_DIFF_LINES_PER_FILE) { truncated = true; break }
      const first = line[0]
      const body = line.slice(1)
      if (first === "+") lines.push(chalk.green("    + " + body))
      else if (first === "-") lines.push(chalk.red("    - " + body))
      else lines.push(dim("      " + body))
      totalLines++
    }
  }

  if (truncated) lines.push(dim(`    … diff truncated at ${MAX_DIFF_LINES_PER_FILE} lines`))
  return lines.join("\n")
}

export function renderFileDiff(edit, cwd = process.cwd()) {
  const full = path.resolve(cwd, edit.path)
  const existed = fs.existsSync(full)
  let original = ""
  try { if (existed) original = fs.readFileSync(full, "utf-8") } catch {}
  const tag = existed ? dim(" (modified)") : chalk.green(" (new)")
  return secondary(`  • ${edit.path}`) + tag + "\n" + renderUnifiedDiff(edit.path, original, edit.content) + "\n"
}

export function renderEditSummary(edits, cwd = process.cwd()) {
  return edits.map(e => renderFileCard(e, cwd)).join("\n")
}

// ─── Claude-Code-style file card ──────────────────────────────────────────────
//
//   ⏺ Write(src/utils/image.ts)
//
//   ────────────────────────────────────────────────────────
//    Create file
//    src/utils/image.ts
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//      1 /**
//      2  * ...
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//
// New files show the full listing; edits show a numbered +/- diff.

const LANG_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", go: "go",
  rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", cc: "cpp",
  cs: "csharp", php: "php", swift: "swift", sh: "bash", bash: "bash", zsh: "bash",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", html: "html",
  xml: "xml", css: "css", scss: "scss", less: "less", md: "markdown", sql: "sql"
}

function langFromPath(p) {
  return LANG_BY_EXT[path.extname(p).slice(1).toLowerCase()] || "plaintext"
}

function cardWidth() {
  return Math.min(process.stdout.columns || 100, 130)
}

function numberedListing(content, lang) {
  const lines = highlightCode(content, lang).split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  const gutter = String(lines.length).length
  return lines
    .map((line, i) => dim(" " + String(i + 1).padStart(gutter) + " ") + line)
    .join("\n")
}

function numberedDiff(relPath, original, updated) {
  const patch = structuredPatch(relPath, relPath, original, updated, "", "", { context: 3 })
  if (patch.hunks.length === 0) return dim("    (no textual changes)")

  let maxNum = 0
  for (const h of patch.hunks) {
    maxNum = Math.max(maxNum, h.oldStart + h.oldLines, h.newStart + h.newLines)
  }
  const gutter = String(maxNum).length
  const num = (n) => dim(" " + String(n).padStart(gutter) + " ")

  const out = []
  let total = 0
  let truncated = false

  for (let hi = 0; hi < patch.hunks.length; hi++) {
    if (total >= MAX_DIFF_LINES_PER_FILE) { truncated = true; break }
    const hunk = patch.hunks[hi]
    if (hi > 0) out.push(dim(" ".repeat(gutter + 2) + "..."))
    let oldLn = hunk.oldStart
    let newLn = hunk.newStart
    for (const line of hunk.lines) {
      if (total >= MAX_DIFF_LINES_PER_FILE) { truncated = true; break }
      const sign = line[0]
      const body = line.slice(1)
      if (sign === "+") { out.push(num(newLn++) + chalk.green("+ " + body)) }
      else if (sign === "-") { out.push(num(oldLn++) + chalk.red("- " + body)) }
      else { out.push(num(newLn++) + "  " + body); oldLn++ }
      total++
    }
  }
  if (truncated) out.push(dim(`    … diff truncated at ${MAX_DIFF_LINES_PER_FILE} lines`))
  return out.join("\n")
}

export function renderFileCard(edit, cwd = process.cwd()) {
  const full = path.resolve(cwd, edit.path)
  const existed = fs.existsSync(full)
  let original = ""
  try { if (existed) original = fs.readFileSync(full, "utf-8") } catch {}

  const w = cardWidth()
  const solid = dim("─".repeat(w))
  const dashed = dim("╌".repeat(w))
  const verb = existed ? "Update" : "Write"
  const action = existed ? "Update file" : "Create file"

  const out = []
  out.push(primary("⏺ ") + chalk.bold(`${verb}(${edit.path})`))
  out.push("")
  out.push(solid)
  out.push(" " + action)
  out.push(" " + secondary(edit.path))
  out.push(dashed)
  out.push(existed
    ? numberedDiff(edit.path, original, edit.content)
    : numberedListing(edit.content, langFromPath(edit.path)))
  out.push(dashed)
  return out.join("\n") + "\n"
}
