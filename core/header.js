import boxen from "boxen"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"
import { state } from "./state.js"
import { c } from "./ui.js"
import si from "systeminformation"

// "NOBLE AI" in an ANSI-shadow block font, rendered in a single solid blue.
const LOGO = [
  "███╗   ██╗ ██████╗ ██████╗ ██╗     ███████╗   █████╗ ██╗",
  "████╗  ██║██╔═══██╗██╔══██╗██║     ██╔════╝  ██╔══██╗██║",
  "██╔██╗ ██║██║   ██║██████╔╝██║     █████╗    ███████║██║",
  "██║╚██╗██║██║   ██║██╔══██╗██║     ██╔══╝    ██╔══██║██║",
  "██║ ╚████║╚██████╔╝██████╔╝███████╗███████╗  ██║  ██║██║",
  "╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝  ╚═╝  ╚═╝╚═╝"
]
const LOGO_WIDTH = Math.max(...LOGO.map(l => [...l].length))

function version() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf-8"))
    return pkg.version || "1.0.0"
  } catch {
    return "1.0.0"
  }
}

// Truncate a path from the left, keeping the meaningful tail.
function shortPath(p, max = 46) {
  if (p.length <= max) return p
  return "…" + p.slice(p.length - (max - 1))
}

function renderLogo(cols) {
  if (cols < LOGO_WIDTH + 4) {
    // Compact wordmark for narrow terminals.
    return "  " + c.primary("✦  N O B L E   A I  ✦")
  }
  return LOGO.map(line => "  " + c.primary(line)).join("\n")
}

export async function renderHeader() {
  console.clear()

  const cols = process.stdout.columns || 80

  const project = path.basename(process.cwd())
  const home = process.env.HOME || ""
  const cwd = process.cwd().replace(home, "~")

  const mem = await si.mem()
  const ram = (mem.active / 1024 / 1024 / 1024).toFixed(1)

  let branch = "no-git"
  try {
    const { execSync } = await import("child_process")
    branch = execSync("git branch --show-current", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim() || "detached"
  } catch {}

  // ── Logo + tagline ──────────────────────────────────────────────────────────
  console.log("")
  console.log(renderLogo(cols))
  console.log("")
  console.log(
    "  " + c.label("Local AI coding assistant") +
    c.faint("  ·  ") + c.dim("v" + version())
  )
  console.log("")

  // ── Status panel ──────────────────────────────────────────────────────────────
  const rows = [
    ["model", state.model],
    ["ram", `${ram} GB`],
    ["branch", branch],
    ["project", project],
    ["path", shortPath(cwd)]
  ]
  const labelW = Math.max(...rows.map(r => r[0].length))
  const content = rows
    .map(([k, v]) => `${c.primary("◆")}  ${c.label(k.padEnd(labelW))}   ${c.value(v)}`)
    .join("\n")

  console.log(
    boxen(content, {
      padding: { top: 0, bottom: 0, left: 2, right: 3 },
      margin: { left: 1, right: 0, top: 0, bottom: 0 },
      borderColor: "#4FC3F7",
      borderStyle: "round",
      title: c.primary("⚡ session"),
      titleAlignment: "left"
    })
  )

  // ── Greeting + key hints ────────────────────────────────────────────────────
  console.log("")
  console.log("  " + c.primary("✦") + "  " + c.value("Hey! What can I help you with?"))
  console.log(
    "     " +
    c.primary("?") + c.dim(" help") +
    c.faint("   ·   ") +
    c.primary("@path ") + c.accent("⇥") + c.dim(" attach files") +
    c.faint("   ·   ") +
    c.primary("Ctrl+D") + c.dim(" cancel")
  )
  console.log("")
}
