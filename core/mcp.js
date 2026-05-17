import { spawn } from "child_process"
import fs from "fs"

export class MCPClient {
  constructor(name, config) {
    this.name = name
    this.config = config
    this.proc = null
    this.buffer = ""
    this.nextId = 1
    this.pending = new Map()
    this.tools = []
  }

  async start() {
    this.proc = spawn(this.config.command, this.config.args || [], {
      env: { ...process.env, ...(this.config.env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    })
    this.proc.stdout.on("data", (c) => this._onData(c))
    this.proc.stderr.on("data", () => {})
    this.proc.on("exit", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP server "${this.name}" exited`))
      }
      this.pending.clear()
    })

    await this._request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "noble-ai", version: "1.0.0" }
    })
    this._notify("notifications/initialized", {})

    const { tools } = await this._request("tools/list", {})
    this.tools = tools || []
    return this.tools
  }

  async callTool(name, args) {
    const result = await this._request("tools/call", { name, arguments: args })
    return (result.content || [])
      .map(c => c.type === "text" ? c.text : JSON.stringify(c))
      .join("\n")
  }

  stop() {
    if (this.proc && !this.proc.killed) this.proc.kill()
  }

  _request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  _notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
  }

  _onData(chunk) {
    this.buffer += chunk.toString()
    let nl
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const pending = this.pending.get(msg.id)
      if (!pending) continue
      this.pending.delete(msg.id)
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result)
    }
  }
}

export async function loadMCPServers(configPath) {
  if (!fs.existsSync(configPath)) return []
  let config
  try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")) }
  catch (err) {
    console.error(`Failed to parse MCP config at ${configPath}: ${err.message}`)
    return []
  }

  const clients = []
  for (const [name, cfg] of Object.entries(config.mcpServers || {})) {
    const client = new MCPClient(name, cfg)
    try {
      await client.start()
      clients.push(client)
    } catch (err) {
      console.error(`MCP server "${name}" failed to start: ${err.message}`)
    }
  }
  return clients
}
