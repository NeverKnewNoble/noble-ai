import fs from "fs"
import path from "path"

const ROOT = process.cwd()

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage",
  ".git", ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache",
  "__pycache__", ".venv", "venv", ".pytest_cache"
])

const MAX_FILE_BYTES = 200_000
const MAX_GREP_MATCHES = 80
const MAX_DIR_ENTRIES = 200

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

  const entries = fs.readdirSync(full, { withFileTypes: true })
    .filter(e => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
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

function walkSearch(dir, regex, results) {
  if (results.length >= MAX_GREP_MATCHES) return

  let stat
  try { stat = fs.statSync(dir) } catch { return }
  if (stat.isFile()) return searchFile(dir, regex, results)

  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

  for (const entry of entries) {
    if (results.length >= MAX_GREP_MATCHES) return
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkSearch(full, regex, results)
    else if (entry.isFile()) searchFile(full, regex, results)
  }
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

export async function executeTool(name, rawArgs) {
  const args = typeof rawArgs === "string" ? safeJson(rawArgs) : (rawArgs || {})
  try {
    if (builtins.has(name)) return await builtins.get(name).handler(args)
    if (mcpRoutes.has(name)) {
      const { client, originalName } = mcpRoutes.get(name)
      return await client.callTool(originalName, args)
    }
    return `Unknown tool: ${name}`
  } catch (err) {
    return `Error (${name}): ${err.message}`
  }
}
