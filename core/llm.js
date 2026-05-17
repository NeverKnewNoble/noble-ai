import ollama from "ollama"
import fs from "fs"
import path from "path"
import { state } from "./state.js"
import { getToolDefs, executeTool } from "./tools.js"

export { ollama }

const MAX_TOOL_ITERATIONS = 8
const PROJECT_RULES_FILES = ["CLAUDE.md", "NOBLE.md", "AGENTS.md"]

const BASE_SYSTEM_PROMPT = `
You are Noble AI, a senior software engineer running in a terminal.

═══ TOOLS ═══
Call these via the model's native tool-calling. NEVER write a tool call as
plain text, as JSON in a code block, or as prose like "let me list_dir(.)"
— just invoke it. The system runs the call and returns the result.

  read_file(path)        — read a file's full contents
  list_dir(path)         — list a directory (use "." for project root)
  grep(pattern, path?)   — regex-search the codebase

Additional MCP tools may be available, prefixed with mcp__<server>__<name>.

═══ CREATING & EDITING FILES ═══
When the user asks you to CREATE, BUILD, MAKE, WRITE, ADD, IMPLEMENT, EDIT,
SCAFFOLD, GENERATE, or SET UP a file, app, page, component, function, or
feature, your reply MUST contain one of these formats for each file. NOTHING
ELSE WILL CAUSE A FILE TO BE WRITTEN.

═══ PREFERRED FORMAT (always works) ═══

<<<FILE: relative/path/to/file.ext>>>
<full new file contents here>
<<<END>>>

The markers are LITERAL TEXT — do NOT wrap them in backticks or code fences.

═══ FALLBACK FORMAT (also works) ═══

### File: \`relative/path/to/file.ext\`
\`\`\`<lang>
<full new file contents here>
\`\`\`

The path MUST be in backticks. The fenced code block MUST immediately follow.

═══ DO NOT ═══
- Do NOT show the same file in BOTH formats — pick one.
- Do NOT write code in a fenced block without a "### File: \`path\`" heading
  directly above it — bare code blocks are NOT saved to disk.
- Do NOT say "save this to X" or "create a file named X" — that does nothing.
  Use one of the formats above.
- Do NOT include diffs, snippets, or partial files. Always include the COMPLETE
  new file contents.

═══ EXAMPLE — user: "make a hello.js that prints hi" ═══
Correct reply:

  I'll create hello.js.

  <<<FILE: hello.js>>>
  console.log("hi")
  <<<END>>>

After your reply, the user will be asked to approve before anything is written.

═══ CONTEXT ═══
On the FIRST user turn, "PROJECT CONTEXT" includes a file tree and the
contents of likely-relevant files. On follow-up turns it will not be re-sent
— use the tools to fetch anything else you need.

═══ NEVER ═══
- Never claim "I cannot read files" or "I don't have access".
- Never describe a tool call in prose instead of invoking it.
- Never give tutorial-style "step 1: create this file, step 2: create that
  file" instructions when the user asked you to BUILD the thing — emit the
  file blocks and build it.

For pure questions, explanations, or conversation, just answer normally
without any file blocks.
`.trim()

export function buildSystemPrompt(cwd = process.cwd()) {
  let prompt = BASE_SYSTEM_PROMPT
  for (const name of PROJECT_RULES_FILES) {
    const full = path.join(cwd, name)
    if (fs.existsSync(full)) {
      try {
        const body = fs.readFileSync(full, "utf-8").trim()
        if (body) prompt += `\n\n═══ PROJECT RULES (from ${name}) ═══\n${body}`
        break
      } catch {}
    }
  }
  return prompt
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return ""
  if (args.path && args.pattern) return `${args.pattern} in ${args.path}`
  return args.path || args.pattern || ""
}

function safeJson(s) {
  try { return JSON.parse(s) } catch { return null }
}

function extractTextToolCalls(content) {
  if (!content) return []
  const calls = []

  const whole = safeJson(content.trim())
  if (whole && typeof whole.name === "string" && whole.arguments !== undefined) {
    calls.push({ function: { name: whole.name, arguments: whole.arguments } })
    return calls
  }

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "{") continue
    let depth = 0
    let inString = false
    let escape = false
    for (let j = i; j < content.length; j++) {
      const c = content[j]
      if (escape) { escape = false; continue }
      if (c === "\\") { escape = true; continue }
      if (c === '"') { inString = !inString; continue }
      if (inString) continue
      if (c === "{") depth++
      else if (c === "}") {
        depth--
        if (depth === 0) {
          const obj = safeJson(content.slice(i, j + 1))
          if (obj && typeof obj.name === "string" && obj.arguments !== undefined) {
            calls.push({ function: { name: obj.name, arguments: obj.arguments } })
          }
          i = j
          break
        }
      }
    }
  }

  return calls
}

function contentIsOnlyToolCall(content, calls) {
  if (calls.length === 0) return false
  const stripped = content.replace(/```[\s\S]*?```/g, "").trim()
  return stripped.length === 0 || /^\{[\s\S]*\}$/.test(stripped)
}

export async function askModel(messages, onStatus = () => {}, onChunk = () => {}) {
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (i > 0) onStatus("thinking...")

    let content = ""
    let toolCalls = []

    const stream = await ollama.chat({
      model: state.model,
      messages,
      tools: getToolDefs(),
      stream: true,
      options: {
        num_ctx: Number(process.env.NOBLE_NUM_CTX) || 8192,
        temperature: 0.3
      }
    })

    for await (const chunk of stream) {
      const msgChunk = chunk.message
      if (!msgChunk) continue
      if (msgChunk.content) {
        content += msgChunk.content
        onChunk(msgChunk.content)
      }
      if (msgChunk.tool_calls && msgChunk.tool_calls.length) {
        toolCalls = msgChunk.tool_calls
      }
    }

    const textCalls = toolCalls.length === 0 ? extractTextToolCalls(content) : []
    const allCalls = toolCalls.length > 0 ? toolCalls : textCalls

    const assistantMsg = { role: "assistant", content }
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls
    messages.push(assistantMsg)

    if (allCalls.length === 0) return content

    if (textCalls.length > 0 && !contentIsOnlyToolCall(content, textCalls)) {
      return content
    }

    for (const call of allCalls) {
      const name = call.function?.name
      const args = call.function?.arguments
      const parsed = typeof args === "string" ? (safeJson(args) || {}) : (args || {})

      onStatus(`${name}(${summarizeArgs(parsed)})...`)

      const result = await executeTool(name, parsed)
      messages.push({
        role: "tool",
        tool_name: name,
        content: typeof result === "string" ? result : JSON.stringify(result)
      })
    }
  }

  return "(Reached the tool-call limit without a final answer. Try rephrasing.)"
}
