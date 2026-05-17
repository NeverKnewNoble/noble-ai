import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import { getIgnore } from "./ignore.js"

const ROOT = process.cwd()

const MAX_FILE_BYTES = 200_000
const MAX_GREP_MATCHES = 80
const MAX_DIR_ENTRIES = 200
const MAX_SHELL_STDOUT = 16_000
const MAX_SHELL_STDERR = 8_000
const DEFAULT_SHELL_TIMEOUT_MS = 60_000

// Commands that are safe to run without prompting. The match is against the
// raw command string after collapsing whitespace. Add to this conservatively —
// anything destructive must require a confirm.
const DEFAULT_ALLOWLIST = [
  /^ls(\s|$)/, /^pwd$/, /^echo\s/, /^date$/, /^whoami$/, /^uname(\s|$)/,
  /^cat\s/, /^head\s/, /^tail\s/, /^wc\s/, /^find\s/,
  /^which\s/, /^type\s/, /^file\s/, /^stat\s/,
  /^git\s+(status|log|diff|branch|show|rev-parse|config\s+--get|remote(\s+-v)?)\b/,
  /^node\s+(-v|--version)$/,
  /^npm\s+(-v|--version|list|ls|view|search|outdated|--help)\b/,
  /^npx\s+(--version|-v|-h|--help)\b/
]

function resolveSafe(rel) {
  const full = path.resolve(ROOT, rel || ".")
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep
  if (full !== ROOT && !full.startsWith(rootWithSep)) {
    throw new Error(`Path outside project: ${rel}`)
  }
  return full
}

function safeJson(s) {
  try { return JSON.parse(s) } catch { return {} }
}

// ─── built-in tool handlers ─────────────────────────────────────────────

function readFile(rel) {
  if (!rel) return "Error: missing path"
  const full = resolveSafe(rel)
  if (!fs.existsSync(full)) return `File not found: ${rel}`
  const stat = fs.statSync(full)
  if (!stat.isFile()) return `Not a file: ${rel}`
  if (stat.size > MAX_FILE_BYTES) {
    return `File too large to read (${stat.size} bytes, limit ${MAX_FILE_BYTES}): ${rel}`
  }
  return fs.readFileSync(full, "utf-8")
}

function listDir(rel) {
  const full = resolveSafe(rel)
  if (!fs.existsSync(full)) return `Directory not found: ${rel}`
  const stat = fs.statSync(full)
  if (!stat.isDirectory()) return `Not a directory: ${rel}`

  const ignore = getIgnore(ROOT)
  const entries = fs.readdirSync(full, { withFileTypes: true })
    .filter(e => !e.name.startsWith(".") && !ignore.skipName(e.name))
    .slice(0, MAX_DIR_ENTRIES)
    .map(e => (e.isDirectory() ? `${e.name}/` : e.name))

  return entries.length ? entries.join("\n") : "(empty)"
}

function grep(pattern, rel) {
  if (!pattern) return "Error: missing pattern"
  let regex
  try { regex = new RegExp(pattern, "i") }
  catch (err) { return `Invalid regex: ${err.message}` }

  const full = resolveSafe(rel || ".")
  const results = []
  walkSearch(full, regex, results)

  if (results.length === 0) return `No matches for ${pattern}`
  return results.join("\n")
}

function walkSearch(dir, regex, results, ignore = getIgnore(ROOT)) {
  if (results.length >= MAX_GREP_MATCHES) return

  let stat
  try { stat = fs.statSync(dir) } catch { return }
  if (stat.isFile()) return searchFile(dir, regex, results)

  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

  for (const entry of entries) {
    if (results.length >= MAX_GREP_MATCHES) return
    if (entry.name.startsWith(".") || ignore.skipName(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkSearch(full, regex, results, ignore)
    else if (entry.isFile()) searchFile(full, regex, results)
  }
}

function isAllowlisted(command, extraAllowlist = []) {
  const norm = command.trim().replace(/\s+/g, " ")
  for (const re of DEFAULT_ALLOWLIST) if (re.test(norm)) return true
  for (const re of extraAllowlist) if (re.test(norm)) return true
  return false
}

function runShell(command, { timeout = DEFAULT_SHELL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, [], { shell: true, cwd: ROOT })
    let stdout = ""
    let stderr = ""
    let killed = false
    const timer = setTimeout(() => { killed = true; proc.kill("SIGTERM") }, timeout)

    proc.stdout.on("data", c => { if (stdout.length < MAX_SHELL_STDOUT) stdout += c.toString() })
    proc.stderr.on("data", c => { if (stderr.length < MAX_SHELL_STDERR) stderr += c.toString() })
    proc.on("error", err => { clearTimeout(timer); resolve(`error: ${err.message}`) })
    proc.on("exit", (code, signal) => {
      clearTimeout(timer)
      const parts = [`$ ${command}`, `exit: ${code ?? signal ?? "?"}`]
      if (killed) parts.push(`(killed after ${timeout}ms)`)
      if (stdout.length) parts.push(`--- stdout ---\n${stdout.slice(0, MAX_SHELL_STDOUT)}${stdout.length >= MAX_SHELL_STDOUT ? "\n…(truncated)" : ""}`)
      if (stderr.length) parts.push(`--- stderr ---\n${stderr.slice(0, MAX_SHELL_STDERR)}${stderr.length >= MAX_SHELL_STDERR ? "\n…(truncated)" : ""}`)
      resolve(parts.join("\n"))
    })
  })
}

function searchFile(full, regex, results) {
  let stat
  try { stat = fs.statSync(full) } catch { return }
  if (stat.size > MAX_FILE_BYTES) return

  let content
  try { content = fs.readFileSync(full, "utf-8") } catch { return }

  const rel = path.relative(ROOT, full)
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
      if (results.length >= MAX_GREP_MATCHES) return
    }
  }
}

// ─── registry ───────────────────────────────────────────────────────────

const builtins = new Map()
const mcpRoutes = new Map()  // prefixedName -> { client, originalName, schema }

builtins.set("read_file", {
  def: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a project file. Use this whenever you need to see code that is not already in PROJECT CONTEXT.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path, e.g. 'core/chat.js'." }
        },
        required: ["path"]
      }
    }
  },
  handler: (args) => readFile(args.path)
})

builtins.set("list_dir", {
  def: {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries in a project directory. Use '.' for the project root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative directory path. Use '.' for the project root." }
        },
        required: ["path"]
      }
    }
  },
  handler: (args) => listDir(args.path || ".")
})

builtins.set("grep", {
  def: {
    type: "function",
    function: {
      name: "grep",
      description: "Search the project for a regular expression. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern (JavaScript syntax, case-insensitive)." },
          path: { type: "string", description: "Optional sub-path to restrict the search. Defaults to project root." }
        },
        required: ["pattern"]
      }
    }
  },
  handler: (args) => grep(args.pattern, args.path)
})

builtins.set("run", {
  needsConfirm: true,
  def: {
    type: "function",
    function: {
      name: "run",
      description: "Execute a shell command in the project root. Use this to run tests, linters, build scripts, package managers, or inspect the environment. Destructive commands (rm, git push, npm publish, etc.) will be blocked unless the user approves. Output is captured and returned.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run, e.g. 'npm test' or 'git status'." }
        },
        required: ["command"]
      }
    }
  },
  handler: async (args, ctx = {}) => {
    const command = (args.command || "").trim()
    if (!command) return "Error: missing command"

    const allowed = isAllowlisted(command, ctx.extraAllowlist || [])
    if (!allowed && ctx.confirm) {
      const decision = await ctx.confirm(command)
      if (decision === "deny") return "(user denied execution)"
      // decision is "allow" | "always" — either way, run it
    } else if (!allowed && !ctx.confirm) {
      return "(blocked: command not allowlisted and no confirm handler available)"
    }
    return runShell(command)
  }
})

export function registerMCPTools(clients) {
  for (const client of clients) {
    for (const tool of client.tools) {
      const prefixed = `mcp__${client.name}__${tool.name}`
      mcpRoutes.set(prefixed, { client, originalName: tool.name, schema: tool })
    }
  }
}

export function getToolDefs() {
  const defs = [...builtins.values()].map(t => t.def)
  for (const [name, { schema }] of mcpRoutes) {
    defs.push({
      type: "function",
      function: {
        name,
        description: schema.description || "",
        parameters: schema.inputSchema || { type: "object", properties: {} }
      }
    })
  }
  return defs
}

export async function executeTool(name, rawArgs, ctx = {}) {
  const args = typeof rawArgs === "string" ? safeJson(rawArgs) : (rawArgs || {})
  try {
    if (builtins.has(name)) return await builtins.get(name).handler(args, ctx)
    if (mcpRoutes.has(name)) {
      const { client, originalName } = mcpRoutes.get(name)
      return await client.callTool(originalName, args)
    }
    return `Unknown tool: ${name}`
  } catch (err) {
    return `Error (${name}): ${err.message}`
  }
}

export function toolNeedsConfirm(name) {
  return !!builtins.get(name)?.needsConfirm
}
