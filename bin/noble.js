#!/usr/bin/env node

import path from "path"
import os from "os"
import { loadMCPServers } from "../core/mcp.js"
import { registerMCPTools } from "../core/tools.js"
import { startCLI } from "../core/chat.js"

const configPath = path.join(os.homedir(), ".noble", "mcp.json")
const clients = await loadMCPServers(configPath)
registerMCPTools(clients)

process.on("exit", () => clients.forEach(c => c.stop()))
process.on("SIGINT", () => { clients.forEach(c => c.stop()); process.exit(0) })

startCLI()
