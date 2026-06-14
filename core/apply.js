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

// Models sometimes wrap the file body in a single markdown ``` fence *inside*
// the <<<FILE>>> markers. Those backticks are not part of the file — strip them
// when the WHOLE body is one fenced block, so we don't write ``` into the file.
function unwrapFence(text) {
  const m = text.match(/^[ \t]*```[a-zA-Z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/)
  return m ? m[1] : text
}

export function parseEdits(text) {
  const edits = []
  let m

  while ((m = EDIT_REGEX.exec(text)) !== null) {
    edits.push({ path: m[2].trim(), content: unwrapFence(stripIndent(m[3], m[1])) })
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
//
// Be conservative — false positives fire on explanatory answers that quote a
// path or tell the user "create a .env file in the root of your project", and
// scare them into thinking the agent failed when it never tried to write.
export function looksLikeMissedEdit(text) {
  if (!text) return false

  // The model named a specific file it would create/edit (e.g. "I'll create
  // greeting.js") but emitted no parseable block — it described the file in
  // prose (often as an indented code block with no markers) instead of writing
  // it. This only runs when parseEdits already found nothing, so the
  // false-positive cost is low.
  const namedFileIntent =
    /\bI(?:'ll| will|'m going to| am going to|'ve decided to| can)\s+(?:create|make|write|add|build|generate|scaffold|set up)\b[^\n]*?\b[\w/-]+\.[a-z0-9]{1,8}\b/i.test(text)
  const looksLikeCode =
    /\b(?:function|const|let|var|class|import|export|def|return|public|private)\b/.test(text) ||
    /=>/.test(text) ||
    /^[ \t]{2,}\S[^\n]*[;{}()]\s*$/m.test(text)  // an indented code-ish line
  if (namedFileIntent && looksLikeCode) return true

  const hasFence = /```[\s\S]+?```/.test(text)
  if (!hasFence) return false

  // Strongest signal: the model used a "File: path" marker we should have
  // recognized but didn't (wrong comment style, malformed heading, etc.).
  // parseEdits already handles the well-formed cases; if we're here, the
  // marker is present but in a shape the parser rejected.
  const hasFileMarker =
    /(?:\/\/|#|--)\s*File:\s*\S/i.test(text) ||
    /^[#*]+\s*File:\s*\S/im.test(text)
  if (hasFileMarker) return true

  // First-person claim of having authored a file. Imperative instructions
  // to the user ("Create a `.env` file in the root of your project") MUST
  // NOT match — those are tutorials, not claims of authorship.
  const firstPersonClaim =
    /\bI(?:'ve| have)?\s+(?:created|wrote|written|saved|added|generated)\b[^\n]{0,40}\bfile\b/i.test(text)
  return firstPersonClaim
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

