import fs from "fs"
import path from "path"

const snapshots = []

// Allow leading whitespace on both marker lines — the model often indents the
// entire <<<FILE>>>...<<<END>>> block by 4 spaces (markdown "indented code
// block" style). We capture that indent and strip it from the content.
const EDIT_REGEX = /^([ \t]*)<<<FILE:\s*([^\n>]+?)>>>[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<<<END>>>/gm

// Fallback: smaller models (qwen2.5-coder, deepseek-coder) ignore the
// <<<FILE>>> instruction and emit markdown-style blocks like:
//   ### File: `index.html`
//   ```html
//   ...
//   ```
// We recognize that format too so files still get written.
const MD_FILE_REGEX = /(?:#{1,6}\s+(?:\*\*)?File:(?:\*\*)?|\*\*File:)\s*`([^`\n]+)`(?:\*\*)?\s*\n+```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```/g

// Second fallback: when the model puts the file marker INSIDE the fenced code
// block as a comment on the first line — qwen2.5-coder does this constantly:
//   ```javascript
//   // File: noble/ArraySort.js
//   function ArraySort(...) { ... }
//   ```
// Handles //, #, and -- comment styles.
const INLINE_FILE_REGEX = /```([a-zA-Z0-9_+-]*)\r?\n[ \t]*(?:\/\/|#|--)[ \t]*File:[ \t]*([^\n]+?)[ \t]*\r?\n([\s\S]*?)\r?\n```/g

// Strip `indent` from the start of each line. Lines that don't start with the
// indent are left as-is (the model's indentation is often inconsistent — keep
// the relative shape rather than mangling it).
function stripIndent(text, indent) {
  if (!indent) return text
  return text.split("\n").map(line =>
    line.startsWith(indent) ? line.slice(indent.length) : line
  ).join("\n")
}

export function parseEdits(text) {
  const edits = []
  let m

  while ((m = EDIT_REGEX.exec(text)) !== null) {
    edits.push({ path: m[2].trim(), content: stripIndent(m[3], m[1]) })
  }
  if (edits.length > 0) return edits

  while ((m = MD_FILE_REGEX.exec(text)) !== null) {
    edits.push({ path: m[1].trim(), content: m[2] })
  }
  if (edits.length > 0) return edits

  while ((m = INLINE_FILE_REGEX.exec(text)) !== null) {
    edits.push({ path: m[2].trim(), content: m[3] })
  }
  return edits
}

// Heuristic: did the response contain code that LOOKS like it was meant to be
// a file edit, even though parseEdits couldn't extract one? Used by chat.js
// to warn the user instead of letting the model silently lie about writing.
export function looksLikeMissedEdit(text) {
  if (!text) return false
  const hasFence = /```[\s\S]+?```/.test(text)
  const claimsCreation = /\b(creat(?:e|ed|ing)|wrote|writing|saved|sav(?:e|ed|ing)|add(?:ed|ing)?|made)\b[\s\S]{0,60}\bfile\b/i.test(text)
  const hasFileMarker = /(?:\/\/|#|--)\s*File:\s*\S/i.test(text) || /\bFile:\s*[`'"]?[\w./\\-]+/.test(text)
  return hasFence && (claimsCreation || hasFileMarker)
}

export function applyEdits(edits, cwd = process.cwd()) {
  const snapshot = { id: Date.now(), files: [] }

  for (const edit of edits) {
    const full = path.resolve(cwd, edit.path)
    const existed = fs.existsSync(full)
    const original = existed ? fs.readFileSync(full, "utf-8") : null

    snapshot.files.push({ path: full, original, existed })

    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, edit.content, "utf-8")
  }

  snapshots.push(snapshot)
  return snapshot
}

export function undoLast() {
  const snapshot = snapshots.pop()
  if (!snapshot) return null

  for (const { path: p, original, existed } of snapshot.files) {
    if (!existed) {
      try { fs.unlinkSync(p) } catch {}
    } else {
      fs.writeFileSync(p, original, "utf-8")
    }
  }
  return snapshot
}

