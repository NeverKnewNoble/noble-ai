import { marked } from "marked"
import { markedTerminal } from "marked-terminal"
import chalk from "chalk"
import { highlight } from "cli-highlight"

const primary = chalk.hex("#4FC3F7")
const secondary = chalk.hex("#81D4FA")
const dim = chalk.gray

marked.use(
  markedTerminal({
    reflowText: false,
    tab: 2,
    code: chalk.cyan,
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

function highlightFences(md) {
  return md.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    try {
      const out = highlight(code, { language: lang || "plaintext", ignoreIllegals: true })
      return "```\n" + out + "```"
    } catch {
      return "```\n" + code + "```"
    }
  })
}

function indent(text, prefix, contLeader) {
  const lines = text.split("\n")
  return lines
    .map((line, i) => (i === 0 ? prefix + line : contLeader + line))
    .join("\n")
}

export function renderAssistant(raw) {
  const stripped = raw.replace(FILE_BLOCK, "").trim()
  if (!stripped) return ""

  const highlighted = highlightFences(stripped)
  const rendered = marked.parse(highlighted).trimEnd()

  const body = indent(rendered, primary("☻ "), "  ")
  return "\n" + body + "\n"
}

export function renderEditSummary(edits) {
  let out = primary(`Proposed changes (${edits.length} file${edits.length === 1 ? "" : "s"}):`) + "\n"
  for (const e of edits) {
    out += secondary(`  • ${e.path}`) + "\n"
  }
  return out
}
