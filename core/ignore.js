import fs from "fs"
import path from "path"
import os from "os"

const DEFAULT_SKIP = [
  "node_modules", "dist", "build", "out", "target", "coverage",
  ".git", ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache",
  "__pycache__", ".venv", "venv", ".pytest_cache"
]

let cachedCwd = null
let cachedMatcher = null

function readPatterns(file) {
  try {
    return fs.readFileSync(file, "utf-8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"))
  } catch {
    return []
  }
}

function buildMatcher(cwd) {
  const names = new Set(DEFAULT_SKIP)
  const extPatterns = []  // e.g. *.log
  const pathPatterns = [] // anything with a slash, e.g. tmp/foo

  const patterns = [
    ...readPatterns(path.join(os.homedir(), ".nobleignore")),
    ...readPatterns(path.join(cwd, ".nobleignore"))
  ]

  for (let p of patterns) {
    if (p.endsWith("/")) p = p.slice(0, -1)
    if (p.startsWith("*.")) extPatterns.push(p.slice(1))      // ".log"
    else if (p.includes("/")) pathPatterns.push(p)
    else names.add(p)
  }

  return {
    skipName(name) {
      if (names.has(name)) return true
      for (const ext of extPatterns) if (name.endsWith(ext)) return true
      return false
    },
    skipRelPath(rel) {
      if (!rel) return false
      const norm = rel.split(path.sep).join("/")
      for (const p of pathPatterns) {
        if (norm === p || norm.startsWith(p + "/")) return true
      }
      return false
    }
  }
}

export function getIgnore(cwd = process.cwd()) {
  if (cachedCwd === cwd && cachedMatcher) return cachedMatcher
  cachedCwd = cwd
  cachedMatcher = buildMatcher(cwd)
  return cachedMatcher
}

// Convenience: most callers only need the name check, since they're already
// walking directory-by-directory.
export function shouldSkipName(name, cwd = process.cwd()) {
  return getIgnore(cwd).skipName(name)
}
