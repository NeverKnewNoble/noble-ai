import boxen from "boxen"
import chalk from "chalk"
import path from "path"
import { state } from "./state.js"
import si from "systeminformation"

export async function renderHeader() {
  console.clear()

  const project = path.basename(process.cwd())
  const home = process.env.HOME || ""
  const cwd = process.cwd().replace(home, "~")
  const parent = path.dirname(cwd)
  const cwdShort = cwd.length > 22 ? `${parent}/...` : cwd

  const mem = await si.mem()
  const ram = (mem.active / 1024 / 1024 / 1024).toFixed(1)

  let branch = "no-git"
  try {
    const { execSync } = await import("child_process")
    branch = execSync("git branch --show-current")
      .toString()
      .trim()
  } catch {}

  const content =
`● Model   ${state.model}
● RAM     ${ram} GB
● Branch  ${branch}
● Project ${project}
● Path    ${cwdShort}`

  console.log(
    boxen(content, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      borderColor: "cyan",
      borderStyle: "round",
      title: "⚡ Noble AI",
      titleAlignment: "left"
    })
  )

  console.log("")
  console.log(
    chalk.cyan("☻ Hey! What can I help you with?") +
    chalk.gray("  Type ? or /help for shortcuts")
  )
  console.log("")
}
