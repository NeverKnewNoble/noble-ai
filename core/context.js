import fs from "fs"
import path from "path"

const EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".scala",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift",
  ".php", ".lua", ".sh", ".bash", ".zsh",
  ".html", ".css", ".scss", ".sass", ".less",
  ".vue", ".svelte", ".astro",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".md", ".mdx",
  ".sql", ".graphql", ".prisma"
])

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", "coverage",
  ".git", ".next", ".nuxt", ".cache", ".turbo", ".parcel-cache",
  "__pycache__", ".venv", "venv", ".pytest_cache"
])

const STOPWORDS = new Set([
  "the","a","an","is","to","of","in","on","for","and","or","but","with",
  "this","that","what","how","why","please","can","you","do","i","it",
  "my","me","we","us","fix","add","make","change","update","help","build",
  "create","remove","delete","show","tell","explain","why","when","where",
  "want","read","whole","codebase","code","project","understand","analyze",
  "look","check","review","know","about","like","just","really"
])

const PRIORITY_FILES = new Set([
  "readme.md", "readme", "readme.txt",
  "package.json", "tsconfig.json", "jsconfig.json",
  "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg",
  "cargo.toml", "go.mod", "gemfile", "composer.json",
  "next.config.js", "next.config.mjs", "next.config.ts",
  "vite.config.js", "vite.config.ts",
  "webpack.config.js", "rollup.config.js",
  "tailwind.config.js", "tailwind.config.ts",
  ".env.example"
])

const MAX_FILE_BYTES = 200_000
const MAX_CONTEXT_CHARS = 24_000
const TREE_LIMIT = 120

function walk(dir, files = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
  catch { return files }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, files)
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full)
    }
  }
  return files
}

function scoreFile(content, pathLower, queryWords) {
  const contentLower = content.toLowerCase()
  let score = 0
  for (const word of queryWords) {
    if (pathLower.includes(word)) score += 3
    let idx = 0, hits = 0
    while ((idx = contentLower.indexOf(word, idx)) !== -1 && hits < 5) {
      hits++
      idx += word.length
    }
    score += hits
  }
  return score
}

export async function getProjectContext(cwd, query) {
  const files = walk(cwd)
  const rels = files.map(f => path.relative(cwd, f))

  const queryWords = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))

  const treeRels = rels.slice(0, TREE_LIMIT)
  const tree = treeRels.map(r => `- ${r}`).join("\n")
  const treeHeader = `PROJECT FILE TREE (${rels.length} files, showing ${treeRels.length}):\n${tree}`

  const ranked = []
  for (let i = 0; i < files.length; i++) {
    const full = files[i]
    let stat
    try { stat = fs.statSync(full) } catch { continue }
    if (stat.size > MAX_FILE_BYTES) continue
    let content
    try { content = fs.readFileSync(full, "utf-8") } catch { continue }

    const rel = rels[i]
    const base = path.basename(rel).toLowerCase()
    const priorityBoost = PRIORITY_FILES.has(base) ? 1_000_000 : 0
    const depthPenalty = (rel.match(/[\/\\]/g) || []).length
    const keywordScore = queryWords.length > 0
      ? scoreFile(content, rel.toLowerCase(), queryWords)
      : 0

    ranked.push({
      rel,
      content,
      score: priorityBoost + keywordScore * 10 - depthPenalty
    })
  }

  ranked.sort((a, b) => b.score - a.score)

  let context = treeHeader + "\n\nPROJECT FILES:\n"
  for (const { rel, content } of ranked) {
    const block = `\n--- ${rel} ---\n${content}\n`
    if (context.length + block.length > MAX_CONTEXT_CHARS) break
    context += block
  }

  return context
}
