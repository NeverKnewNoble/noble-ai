#!/usr/bin/env node

import path from "path"
import os from "os"
import { loadMCPServers } from "../core/mcp.js"
import { registerMCPTools } from "../core/tools.js"
import { startCLI, runOneShot } from "../core/chat.js"

function parseArgs(argv) {
  const args = { prompt: null, apply: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") args.help = true
    else if (a === "--apply") args.apply = true
    else if (a === "-p" || a === "--prompt") args.prompt = argv[++i] ?? ""
    else if (a.startsWith("--prompt=")) args.prompt = a.slice("--prompt=".length)
  }
  return args
}

function printHelp() {
  console.log(`Noble AI — local AI coding assistant

Usage:
  noble-ai                       Start the interactive REPL
  noble-ai -p "<prompt>"         Run a single prompt and exit
  noble-ai --prompt "<prompt>"   Same as -p
  echo "<prompt>" | noble-ai     Read prompt from stdin
  cat file | noble-ai -p "..."   Stdin is appended to the prompt

Flags:
  --apply        In one-shot mode, automatically write proposed file changes
  -h, --help     Show this help

Env:
  NOBLE_NUM_CTX  Override Ollama context window in tokens (default 8192)
  TAVILY_API_KEY Enable Tavily web search on the first turn

Config files (optional):
  ~/.noble/mcp.json        MCP server config (loaded at startup)
  ~/.noble/sessions/       Saved conversations (/save and /load)
  ~/.noble/history         Cross-session prompt history
  ~/.nobleignore           Global ignore patterns
  ./.nobleignore           Project-level ignore patterns
  ./CLAUDE.md | NOBLE.md   Project rules appended to the system prompt
  ./AGENTS.md

In the REPL, type "?" or "/help" for the full command list.
`)
}

async function readStdin() {
  if (process.stdin.isTTY) return ""
  let data = ""
  for await (const chunk of process.stdin) data += chunk
  return data
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  printHelp()
  process.exit(0)
}

const configPath = path.join(os.homedir(), ".noble", "mcp.json")
const clients = await loadMCPServers(configPath)
registerMCPTools(clients)

process.on("exit", () => clients.forEach(c => c.stop()))
process.on("SIGINT", () => { clients.forEach(c => c.stop()); process.exit(0) })

const stdinText = await readStdin()
const oneShotInput = [args.prompt, stdinText].filter(Boolean).join("\n\n").trim()

if (oneShotInput) {
  await runOneShot(oneShotInput, { autoApply: args.apply })
  clients.forEach(c => c.stop())
  process.exit(0)
}

startCLI()
