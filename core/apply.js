import fs from "fs"
import path from "path"

const snapshots = []

const EDIT_REGEX = /<<<FILE:\s*([^\n>]+?)>>>\r?\n([\s\S]*?)\r?\n<<<END>>>/g

// Fallback: smaller models (qwen2.5-coder, deepseek-coder) ignore the
// <<<FILE>>> instruction and emit markdown-style blocks like:
//   ### File: `index.html`
//   ```html
//   ...
//   ```
// We recognize that format too so files still get written.
const MD_FILE_REGEX = /(?:#{1,6}\s+(?:\*\*)?File:(?:\*\*)?|\*\*File:)\s*`([^`\n]+)`(?:\*\*)?\s*\n+```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```/g

export function parseEdits(text) {
  const edits = []
  let m

  while ((m = EDIT_REGEX.exec(text)) !== null) {
    edits.push({ path: m[1].trim(), content: m[2] })
  }
  if (edits.length > 0) return edits

  while ((m = MD_FILE_REGEX.exec(text)) !== null) {
    edits.push({ path: m[1].trim(), content: m[2] })
  }
  return edits
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

