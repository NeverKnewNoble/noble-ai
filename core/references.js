import fs from "fs"
import path from "path"
import { shouldSkipName } from "./ignore.js"

const AT_REGEX = /(?<=^|\s)@([^\s@]+)/g

const MAX_REF_FILE_BYTES = 100_000
const MAX_DIR_FILES = 20
const MAX_DIR_BYTES = 80_000
const MAX_BASENAME_MATCHES = 5
const MAX_GLOB_MATCHES = 50
const MAX_URL_BYTES = 200_000
const URL_FETCH_TIMEOUT_MS = 8_000

function isUrl(s) { return /^https?:\/\//i.test(s) }

function hasGlob(s) { return /[*?]/.test(s) }

function parseLineRange(token) {
  const m = token.match(/^(.+):(\d+)(?:-(\d+))?$/)
  if (!m) return { pathPart: token, range: null }
  const start = parseInt(m[2], 10)
  const end = m[3] ? parseInt(m[3], 10) : start
  if (end < start) return { pathPart: token, range: null }
  return { pathPart: m[1], range: { start, end } }
}

function findByBasename(cwd, basename) {
  const matches = []
  function walk(dir) {
    if (matches.length > MAX_BASENAME_MATCHES) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== basename) continue
      if (shouldSkipName(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name === basename) matches.push(full)
    }
  }
  walk(cwd)
  return matches
}

function expandGlob(pattern, cwd) {
  const parts = pattern.split("/").filter(Boolean)
  const results = []

  function walk(currentAbs, currentRel, partsIdx) {
    if (results.length >= MAX_GLOB_MATCHES) return
    if (partsIdx === parts.length) {
      try {
        if (fs.statSync(currentAbs).isFile()) results.push(currentRel)
      } catch {}
      return
    }

    const segment = parts[partsIdx]

    if (segment === "**") {
      walk(currentAbs, currentRel, partsIdx + 1)
      let entries
      try { entries = fs.readdirSync(currentAbs, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith(".") || shouldSkipName(e.name)) continue
        if (!e.isDirectory()) continue
        const nextRel = currentRel ? `${currentRel}/${e.name}` : e.name
        walk(path.join(currentAbs, e.name), nextRel, partsIdx)
      }
      return
    }

    if (hasGlob(segment)) {
      const escaped = segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
      const regex = new RegExp(`^${escaped}$`)
      let entries
      try { entries = fs.readdirSync(currentAbs, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith(".") || shouldSkipName(e.name)) continue
        if (regex.test(e.name)) {
          const nextRel = currentRel ? `${currentRel}/${e.name}` : e.name
          walk(path.join(currentAbs, e.name), nextRel, partsIdx + 1)
        }
      }
      return
    }

    const nextAbs = path.join(currentAbs, segment)
    const nextRel = currentRel ? `${currentRel}/${segment}` : segment
    if (fs.existsSync(nextAbs)) walk(nextAbs, nextRel, partsIdx + 1)
  }

  walk(cwd, "", 0)
  return results.sort()
}

function listDirFiles(dirAbs, cwd) {
  const files = []
  function walk(d) {
    if (files.length >= MAX_DIR_FILES) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (files.length >= MAX_DIR_FILES) return
      if (e.name.startsWith(".") || shouldSkipName(e.name)) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) files.push(path.relative(cwd, full))
    }
  }
  walk(dirAbs)
  return files.sort()
}

// Returns: [{ token, files?: [{rel, range?}], error?, isDirectory?, truncated? }]
export function extractReferences(input, cwd = process.cwd()) {
  const refs = []
  const seen = new Set()
  let m
  AT_REGEX.lastIndex = 0

  while ((m = AT_REGEX.exec(input)) !== null) {
    const raw = m[1].replace(/[.,;!?)\]]+$/, "")
    if (!raw || seen.has(raw)) continue
    seen.add(raw)

    if (isUrl(raw)) {
      refs.push({ token: raw, isUrl: true, url: raw })
      continue
    }

    if (hasGlob(raw)) {
      const matches = expandGlob(raw, cwd)
      if (matches.length === 0) refs.push({ token: raw, error: "no glob matches" })
      else refs.push({
        token: raw,
        files: matches.map(rel => ({ rel })),
        isGlob: true,
        truncated: matches.length >= MAX_GLOB_MATCHES
      })
      continue
    }

    const { pathPart, range } = parseLineRange(raw)

    const exact = path.resolve(cwd, pathPart)
    if (fs.existsSync(exact)) {
      const stat = fs.statSync(exact)
      if (stat.isDirectory()) {
        if (range) {
          refs.push({ token: raw, error: "line ranges not supported on directories" })
          continue
        }
        const files = listDirFiles(exact, cwd)
        if (files.length === 0) {
          refs.push({ token: raw, error: "directory is empty (or only contains skipped files)" })
        } else {
          refs.push({
            token: raw,
            files: files.map(rel => ({ rel })),
            isDirectory: true,
            truncated: files.length >= MAX_DIR_FILES
          })
        }
      } else if (stat.isFile()) {
        refs.push({ token: raw, files: [{ rel: path.relative(cwd, exact), range }] })
      }
      continue
    }

    if (!pathPart.includes("/")) {
      const matches = findByBasename(cwd, pathPart)
      if (matches.length === 1) {
        refs.push({ token: raw, files: [{ rel: path.relative(cwd, matches[0]), range }] })
      } else if (matches.length > 1) {
        const sample = matches.slice(0, 3).map(p => path.relative(cwd, p)).join(", ")
        refs.push({ token: raw, error: `ambiguous (${matches.length} matches: ${sample}${matches.length > 3 ? "..." : ""})` })
      }
    }
  }
  return refs
}

function readFileSliced(rel, range, cwd = process.cwd()) {
  const full = path.resolve(cwd, rel)
  let content
  try {
    const stat = fs.statSync(full)
    if (stat.size > MAX_REF_FILE_BYTES) {
      return `(file too large: ${stat.size} bytes, limit ${MAX_REF_FILE_BYTES})`
    }
    content = fs.readFileSync(full, "utf-8")
  } catch (err) {
    return `(read error: ${err.message})`
  }
  if (!range) return content
  const lines = content.split("\n")
  const start = Math.max(1, range.start)
  const end = Math.min(lines.length, range.end)
  return lines.slice(start - 1, end).join("\n")
}

async function fetchUrl(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), URL_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" })
    if (!res.ok) return `(HTTP ${res.status} fetching ${url})`
    const text = await res.text()
    if (text.length > MAX_URL_BYTES) {
      return text.slice(0, MAX_URL_BYTES) + `\n\n(truncated at ${MAX_URL_BYTES} bytes)`
    }
    return text
  } catch (err) {
    return `(fetch error: ${err.message})`
  } finally {
    clearTimeout(timer)
  }
}

export async function buildReferenceContext(refs, cwd = process.cwd()) {
  if (refs.length === 0) return ""
  const blocks = []
  let totalBytes = 0

  for (const ref of refs) {
    if (ref.error) {
      blocks.push(`@${ref.token}: ${ref.error}`)
      continue
    }
    if (ref.isUrl) {
      const body = await fetchUrl(ref.url)
      totalBytes += body.length
      blocks.push(`--- @${ref.url} ---\n${body}`)
      continue
    }
    const isBulk = ref.isDirectory || ref.isGlob
    let bulkBytes = 0

    for (const f of ref.files) {
      if (isBulk && bulkBytes >= MAX_DIR_BYTES) {
        blocks.push(`(omitted remaining files in @${ref.token}: would exceed ${MAX_DIR_BYTES} bytes)`)
        break
      }
      const content = readFileSliced(f.rel, f.range, cwd)
      totalBytes += content.length
      bulkBytes += content.length
      const label = f.range ? `@${f.rel}:${f.range.start}-${f.range.end}` : `@${f.rel}`
      blocks.push(`--- ${label} ---\n${content}`)
    }

    if (ref.truncated) {
      const kind = ref.isDirectory ? "directory" : "glob"
      const cap = ref.isDirectory ? MAX_DIR_FILES : MAX_GLOB_MATCHES
      blocks.push(`(${kind} @${ref.token} hit the ${cap}-file cap; only the first ${cap} are shown)`)
    }
  }
  return blocks.join("\n\n")
}

// Used by readline's completer. Returns null if the cursor is not on an @-ref.
export function completeReference(line, cwd = process.cwd()) {
  const m = line.match(/@([^\s@]*)$/)
  if (!m) return null

  const partial = m[1]
  // Don't try to complete inside a line range like @core/chat.js:50
  const colonIdx = partial.lastIndexOf(":")
  if (colonIdx >= 0 && /^\d+(-\d*)?$/.test(partial.slice(colonIdx + 1))) return null

  // Strip a glob segment off the end for completion purposes — let the user
  // tab-complete the directory before the glob, then they can finish the *
  if (hasGlob(partial)) return null

  const lastSlash = partial.lastIndexOf("/")
  const dirPart = lastSlash >= 0 ? partial.slice(0, lastSlash + 1) : ""
  const stem = lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial

  const searchDir = path.resolve(cwd, dirPart || ".")
  let entries
  try { entries = fs.readdirSync(searchDir, { withFileTypes: true }) }
  catch { return { completions: [], prefix: "@" + partial } }

  const matches = []
  for (const e of entries) {
    if (shouldSkipName(e.name)) continue
    if (e.name.startsWith(".") && !stem.startsWith(".")) continue
    if (!e.name.startsWith(stem)) continue
    const suffix = e.isDirectory() ? "/" : ""
    matches.push("@" + dirPart + e.name + suffix)
  }
  matches.sort()
  return { completions: matches, prefix: "@" + partial }
}
