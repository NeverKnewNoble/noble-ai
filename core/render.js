import { marked } from "marked"
import { markedTerminal } from "marked-terminal"
import chalk from "chalk"
import { highlight } from "cli-highlight"

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

const FILE_BLOCK = /<<<FILE:[^>\n]+>>>\r?\n[\s\S]*?\r?\n<<<END>>>/g

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

export function renderEditSummary(edits) {
  let out = primary(`Proposed changes (${edits.length} file${edits.length === 1 ? "" : "s"}):`) + "\n"
  for (const e of edits) {
    out += secondary(`  • ${e.path}`) + "\n"
  }
  return out
}
