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

const FILE_BLOCK = /^[ \t]*<<<FILE:[^>\n]+>>>[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*<<<END>>>/gm

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
  const stripped = raw.replace(FILE_BLOCK, "").trim()
  if (!stripped) return ""

  const rendered = tighten(marked.parse(stripped))
  const body = indent(rendered, primary("☻ "), "  ")
  return "\n" + body + "\n\n"
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
  let out = primary(`Proposed changes (${edits.length} file${edits.length === 1 ? "" : "s"}):`) + "\n"
  for (const e of edits) out += renderFileDiff(e, cwd)
  return out
}
