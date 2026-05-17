# ⚡ Noble AI

A local, Cursor-style AI coding assistant that runs in your terminal — powered by Ollama.

Noble AI lets you chat with local coding models (qwen2.5-coder, deepseek-coder, etc.) from inside any project directory. It reads your project, calls tools to explore the codebase, runs shell commands on demand (with confirmation), optionally pulls in live web results, and can write file edits back to disk with per-file approval and a one-keystroke undo.

It behaves similarly to:
- Cursor AI
- Claude CLI
- terminal coding copilots

but runs locally on your machine.

---

# 🚀 Features

- **Local AI coding assistant** — no cloud, no subscription
- **Streaming responses** that **re-render as markdown** when the model finishes (headings, lists, syntax-highlighted code)
- **Native tool calling** — the model can `read_file`, `list_dir`, `grep`, and `run` shell commands
- **`run` tool with allowlist + confirmation** — read-only commands (ls, cat, git status/log/diff, npm list, …) auto-run; anything else prompts for `y / n / always`
- **MCP server support** — plug in any Model Context Protocol server via `~/.noble/mcp.json`
- **`@file` references with TAB completion** — attach files, globs, directories, line ranges, or URLs to your prompt
- **Project-aware context scanning** — relevance-scored file selection on the first turn
- **Project rules** — `CLAUDE.md`, `NOBLE.md`, or `AGENTS.md` in the repo root is auto-loaded into the system prompt
- **`.nobleignore`** — exclude paths from context scans, tool walks, and reference expansion
- **Optional live web search** via Tavily for up-to-date answers
- **Per-file edit approval** — for multi-file changes, accept / reject / re-show diff for each file individually
- **Colored unified diffs** before any file is written
- **Forgiving edit parser** — accepts `<<<FILE>>>`, `### File:`, or `// File:` formats (indented or not). If the model emits code that doesn't match any format, you get a warning and the model is auto-corrected on the next turn
- **`/undo`** to revert the last applied edit set
- **Sessions** — `/save <name>`, `/load <name>`, `/sessions` to checkpoint and resume long debugging conversations
- **Persistent prompt history** — arrow-up survives across runs
- **Multi-model support** with live `/model` switching
- **One-shot mode** — `noble-ai -p "..."` or piped stdin for scripting
- **Slash-command + `@`-reference TAB completion**
- **`/retry`**, **`/copy`**, **`/tokens`**, **`/clear`** quality-of-life commands
- **Cancel a running generation** with `Ctrl+D`
- **Header panel** showing model, RAM, git branch, and project path
- **Configurable context window** via `NOBLE_NUM_CTX` for tight-memory machines

---

# 🧠 Tech Stack

| Tool | Purpose |
|------|----------|
| Ollama | Runs local LLMs |
| Qwen / DeepSeek | Coding models |
| Node.js (ESM) | CLI runtime |
| MCP (JSON-RPC over stdio) | External tool servers |
| diff | Unified-diff renderer |
| Chalk | Terminal colors |
| Ora | Loading spinners |
| Boxen | Header panel |
| marked + marked-terminal | Markdown rendering |
| cli-highlight | Code syntax highlighting |
| systeminformation | RAM stats in header |
| Tavily | Web search |

---

# 📦 Recommended Models

```bash
ollama pull qwen2.5-coder:7b
ollama pull deepseek-coder:6.7b
```

The models Noble AI offers in `/models` are defined in `core/models.js`.

---

# 🧱 Project Structure

```text
noble-ai/
 ├── bin/
 │    └── noble.js        # CLI entry point — argv parsing, MCP startup, one-shot mode
 │
 ├── core/
 │    ├── chat.js         # REPL loop, slash commands, edit/run confirm UI
 │    ├── llm.js          # Ollama client, system prompt, streaming + tool-call loop
 │    ├── tools.js        # Built-ins (read_file/list_dir/grep/run) + MCP routing
 │    ├── mcp.js          # MCP stdio client (loads servers from ~/.noble/mcp.json)
 │    ├── references.js   # @file / @glob / @dir / @file:lines / @https URLs
 │    ├── ignore.js       # .nobleignore loader (with sane defaults)
 │    ├── context.js      # Project scanner / relevance scorer (first-turn context)
 │    ├── search.js       # Tavily web search
 │    ├── apply.js        # Parse, apply, and undo file edits (with snapshots)
 │    ├── render.js       # Markdown rendering + colored unified diffs
 │    ├── header.js       # Boxed status header
 │    ├── models.js       # Available model list
 │    └── state.js        # Active model (mutable state)
 │
 ├── index.js
 ├── package.json
 └── README.md
```

---

# ⚙️ Installation

### 1. Clone

```bash
git clone YOUR_REPO
cd noble-ai
```

### 2. Install dependencies

```bash
npm install
```

### 3. Install Ollama

https://ollama.com

### 4. Pull a coding model

```bash
ollama pull qwen2.5-coder:7b
```

### 5. (Optional) Add a Tavily API key for web search

Create a `.env` in the project root:

```bash
TAVILY_API_KEY=your_key_here
```

Without it, Noble AI still works — web search just returns an empty result.

### 6. (Optional) Configure MCP servers

Create `~/.noble/mcp.json` to plug in external tool servers. Standard MCP format:

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/some/path"]
    }
  }
}
```

Their tools become available to the model as `mcp__<server>__<tool>`.

### 7. (Optional) Add a `.nobleignore`

Create `.nobleignore` in your project root (or `~/.nobleignore` for global). Same idea as `.gitignore`:

```text
# directories to skip
build/
dist/
my-private-notes/

# extensions to skip
*.log
*.sqlite
```

Honored by the project scanner, the `list_dir` / `grep` tools, and `@` references.

### 8. Make Noble AI global

```bash
npm link
```

Now `noble-ai` works from any directory.

---

# 🚀 Usage

```bash
cd my-project
noble-ai
```

Example prompts:

```text
fix this login bug
refactor this API route
explain @core/chat.js
run the tests and tell me what fails
add a /health endpoint to @server.js
look at @core/*.js and find dead code
summarize @docs/
review @https://example.com/spec
```

When the model proposes file changes, Noble AI shows colored diffs and walks you through each file one-by-one for approval.

### One-shot mode

```bash
noble-ai -p "list the files in core/"
noble-ai -p "review this for bugs" < server.js
cat error.log | noble-ai -p "what does this mean?"
noble-ai -p "add a CHANGELOG" --apply    # write changes without prompting
```

---

# 📎 File References (`@`)

Attach files directly to your prompt with `@`. Press `TAB` after typing `@` (or a partial path) to autocomplete.

| Syntax | What it does |
|--------|--------------|
| `@path/to/file.js` | Inject a specific file |
| `@file.js` | Bare filename — searches the project tree |
| `@core/*.js` | Glob — inject all matching files |
| `@**/chat.js` | Recursive glob |
| `@core/chat.js:50-100` | Inject only those lines |
| `@core/` | Dump all files in a directory |
| `@https://example.com/...` | Fetch the URL and inject its body |

Bulk references (globs / directories) are capped to keep the context window sane. URL fetches have an 8s timeout and a 200 KB body cap.

---

# 🛠 Tools the model can call

The assistant has native tool calling and pulls in code or runs commands on its own when needed:

| Tool | What it does | Confirmation |
|------|--------------|--------------|
| `read_file(path)` | Read a project file | none |
| `list_dir(path)` | List a directory | none |
| `grep(pattern, path?)` | Regex search the codebase | none |
| `run(command)` | Execute a shell command | allowlist → auto, otherwise prompt |

Plus any tools exposed by MCP servers configured in `~/.noble/mcp.json`.

### The `run` tool

The model can invoke `run("npm test")`, `run("ls src/")`, `run("git log -p HEAD~5..")`, etc. Noble AI shows the command and asks:

```
⚠ Shell command requested
  $ npm test
  [y]es  [n]o  [a]lways for `npm test`  >
```

- **y** — run this one command
- **n** — refuse; the model sees `(user denied execution)` and adapts
- **a** — add a prefix-match regex (first 2 tokens) to the session allowlist, then run

A built-in allowlist auto-runs safe read-only commands without prompting:

```
ls, pwd, echo, date, whoami, uname, cat, head, tail, wc, find,
which, type, file, stat,
git status / log / diff / branch / show / rev-parse / config --get / remote,
node -v, npm list, npm ls, npm view, npm search, npm outdated, …
```

Anything else (writes, package installs, network calls, etc.) requires explicit approval. Output is captured (16 KB stdout / 8 KB stderr cap, 60s timeout) and fed back to the model.

---

# 📝 Per-file edit approval

When the model proposes changes to multiple files, Noble AI walks through each one:

```
Proposed changes (3 files):
  • core/chat.js
  • core/render.js
  • README.md

  • core/chat.js (modified)
    @@ -12,4 +12,5 @@
      import readline from "readline"
    + import { spawn } from "child_process"
      …

[1/3] [y]es  [n]o  [d]iff again  [a]ll remaining  [s]kip all  >
```

- **y** — accept this file
- **n** — skip this file
- **d** — re-render the diff
- **a** — accept this and all remaining
- **s** — skip all remaining

Only the accepted files are written. `/undo` reverts the whole accepted batch as one snapshot.

---

# 💾 Sessions

Long conversations can be checkpointed and resumed:

```text
/save bug-hunt        # writes ~/.noble/sessions/bug-hunt.json
/sessions             # list saved conversations newest-first
/load bug-hunt        # restore messages, turn count, last response
```

Sessions are JSON with the full message history. Names are sanitized to `[a-z0-9._-]` and capped at 64 chars. The per-session shell allowlist is *not* persisted — re-approve "always" commands after `/load`.

---

# ⌨️ Commands & Shortcuts

| Command | Description |
|---------|-------------|
| `?` or `/help` | Show the full shortcut reference |
| `/retry` | Regenerate the last response |
| `/copy` | Copy the last response to the clipboard |
| `/tokens` | Estimated context-window usage with a bar |
| `/clear` | Clear the screen and reset the conversation |
| `/save <name>` | Save the current conversation |
| `/load <name>` | Resume a saved conversation |
| `/sessions` | List saved conversations |
| `/models` | List available models |
| `/model` | Show the active model |
| `/model <name\|number>` | Switch model |
| `/undo` | Revert the last applied file changes |
| `/keytest` | Debug: print raw key info as you type |
| `TAB` | Complete `@`-references or slash commands |
| `↑` / `↓` | Walk through prompt history (persists across runs) |
| `Ctrl+D` | Cancel a running generation |
| `Ctrl+C` / `exit` | Quit Noble AI |

---

# 🧠 How It Works

```text
your prompt (+ optional @file/@url refs)
     ↓
@-references resolved → injected as REFERENCED FILES
     ↓
first turn only: context scanner picks relevant project files
     ↓
first turn only: web search (optional, via Tavily)
     ↓
Ollama (local model, streaming)
     ↓
model may call tools: read_file / list_dir / grep / run / MCP
     ↓ — for `run`: allowlist check → auto-run, OR prompt user
     ↓ — loop until done (max 8 iterations)
streamed raw text → re-rendered as markdown on the final segment
     ↓
file edits emitted as <<<FILE>>>, "### File:", or "// File:" inline blocks
     ↓
per-file y / n / d / a / s approval → apply.js writes accepted files
     ↓
undo snapshot stored for /undo
```

The model emits full-file rewrites inside `<<<FILE: path>>> ... <<<END>>>` markers. Smaller models (qwen2.5-coder, deepseek-coder) often go off-script, so the parser has three layers of fallback:

1. **Preferred:** `<<<FILE: path>>> ... <<<END>>>` (with or without 4-space indent — the parser strips it)
2. **Fallback:** `### File: \`path\`` heading immediately above a fenced code block
3. **Last resort:** `// File: path` (or `# File:` / `-- File:`) as the first comment line *inside* a fenced code block

`core/apply.js` parses any of these, snapshots the originals, writes the new versions, and stores the snapshot so `/undo` can roll back.

If the model emits code that *looks* like a file edit but doesn't match any format (e.g. a bare fenced block with no path marker), Noble AI prints a `⚠ Heads up` warning and injects a one-shot reminder into the conversation so the next `/retry` self-corrects.

---

# 🔧 Environment Variables

| Variable | Purpose |
|----------|---------|
| `TAVILY_API_KEY` | Enables web search on the first turn |
| `NOBLE_NUM_CTX` | Ollama context window in tokens (default `8192`) — lower it if a model OOMs |

---

# 📂 Config & Data Files

| Path | Purpose |
|------|---------|
| `~/.noble/mcp.json` | MCP server config (loaded at startup) |
| `~/.noble/sessions/` | Saved conversations (`/save`, `/load`) |
| `~/.noble/history` | Cross-session prompt history (last 500 entries) |
| `~/.nobleignore` | Global ignore patterns |
| `<project>/.nobleignore` | Project-level ignore patterns |
| `<project>/CLAUDE.md` `NOBLE.md` `AGENTS.md` | Project rules appended to the system prompt |

---

# 🛑 Notes

- Noble AI does **not** send your code to cloud APIs (the optional Tavily call only sends your prompt as a search query).
- Requires Ollama to be running locally.
- Uses your machine's CPU/GPU and RAM.
- The `run` tool executes commands as the current user with full filesystem access — review prompts carefully. The allowlist is conservative on purpose.

---

# 💡 Recommended Specs

- Apple Silicon Mac (or comparable)
- 16 GB RAM minimum
- 7B–8B models work best; avoid 32B+ on consumer hardware

---

# 🧹 Useful Ollama Commands

```bash
ollama list                       # installed models
ollama run qwen2.5-coder:7b       # run a model
ollama stop qwen2.5-coder:7b      # stop a model
ollama rm MODEL_NAME              # remove a model
```

---

# 🔥 Planned

- Embeddings + semantic file retrieval
- Diff-based edits (instead of full-file rewrites) for cheaper context
- Repo map (function/class signatures) in place of full-file dumps
- VS Code extension
- Richer agent loops with more built-in tools

---

# 👨‍💻 Author

Larry-Noble Odai — Noble AI
