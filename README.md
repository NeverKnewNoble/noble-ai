# ⚡ Noble AI

A local, Cursor-style AI coding assistant that runs in your terminal — powered by Ollama.

Noble AI lets you chat with local coding models (qwen2.5-coder, deepseek-coder, etc.) from inside any project directory. It reads your project, calls tools to explore the codebase on demand, optionally pulls in live web results, and can write file edits back to disk with a one-keystroke undo.

It behaves similarly to:
- Cursor AI
- Claude CLI
- terminal coding copilots

but runs locally on your machine.

---

# 🚀 Features

- **Local AI coding assistant** — no cloud, no subscription
- **Streaming responses** with a Claude-style terminal UI (markdown + syntax highlighting)
- **Native tool calling** — the model can `read_file`, `list_dir`, and `grep` your project on demand
- **MCP server support** — plug in any Model Context Protocol server via `~/.noble/mcp.json` and its tools show up as `mcp__<server>__<name>`
- **`@file` references with TAB completion** — attach files, globs, directories, or line ranges directly to your prompt
- **Project-aware context scanning** — relevance-scored file selection on the first turn
- **Project rules** — `CLAUDE.md`, `NOBLE.md`, or `AGENTS.md` in the repo root are auto-loaded into the system prompt
- **Optional live web search** via Tavily for up-to-date answers
- **Inline file edits** — assistant emits `<<<FILE>>>` blocks (or markdown `### File:` blocks as fallback), you approve, Noble writes them
- **`/undo`** to revert the last applied edit set
- **Multi-model support** with live `/model` switching
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
 │    └── noble.js        # CLI entry point — loads MCP servers, then starts the REPL
 │
 ├── core/
 │    ├── chat.js         # REPL loop, slash commands, @-ref TAB completion, edit prompts
 │    ├── llm.js          # Ollama client, system prompt, streaming + tool-call loop
 │    ├── tools.js        # Built-in tools (read_file/list_dir/grep) + MCP tool registry
 │    ├── mcp.js          # MCP stdio client (loads servers from ~/.noble/mcp.json)
 │    ├── references.js   # @file / @glob / @dir / @file:start-end parsing + completion
 │    ├── context.js      # Project scanner / relevance scorer (first-turn context)
 │    ├── search.js       # Tavily web search
 │    ├── apply.js        # Parse, apply, and undo file edits
 │    ├── render.js       # Markdown + code rendering for assistant output
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

### 7. Make Noble AI global

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
add a /health endpoint to @server.js
look at @core/*.js and tell me what's wrong
summarize @docs/
```

When the model proposes file changes, Noble AI prints a summary and asks before writing anything to disk.

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

Bulk references (globs / directories) are capped to keep the context window sane.

---

# 🛠 Tools the model can call

The assistant has native tool calling and will pull in code on its own when needed:

- `read_file(path)` — read a project file
- `list_dir(path)` — list a directory
- `grep(pattern, path?)` — regex search the codebase

Plus any tools exposed by MCP servers configured in `~/.noble/mcp.json`.

---

# ⌨️ Commands & Shortcuts

| Command | Description |
|---------|-------------|
| `?` or `/help` | Show shortcuts |
| `/models` | List available models |
| `/model` | Show the active model |
| `/model <name\|number>` | Switch model |
| `/undo` | Revert the last applied file changes |
| `/clear` | Clear the screen and reset the conversation |
| `/keytest` | Debug: print raw key info as you type |
| `Ctrl+D` | Cancel a running generation |
| `Ctrl+C` / `exit` | Quit Noble AI |

---

# 🧠 How It Works

```text
your prompt (+ optional @file refs)
     ↓
@-references resolved → injected as REFERENCED FILES
     ↓
first turn only: context scanner picks relevant project files
     ↓
first turn only: web search (optional, via Tavily)
     ↓
Ollama (local model, streaming)
     ↓
model may call tools (read_file / list_dir / grep / MCP)
     ↓ loop until done (max 8 iterations)
rendered response + optional <<<FILE>>> or "### File:" edit blocks
     ↓
you approve → apply.js writes to disk (with undo snapshot)
```

The model is instructed to emit full-file rewrites inside `<<<FILE: path>>> ... <<<END>>>` markers. As a fallback for smaller models that ignore that format, Noble AI also recognizes markdown-style `### File: \`path\`` blocks followed by a fenced code block. `core/apply.js` parses these, snapshots the originals, writes the new versions, and stores the snapshot so `/undo` can roll back.

---

# 🔧 Environment Variables

| Variable | Purpose |
|----------|---------|
| `TAVILY_API_KEY` | Enables web search on the first turn |
| `NOBLE_NUM_CTX` | Ollama context window in tokens (default `8192`) — lower it if a model OOMs |

---

# 📜 Project Rules

If a `CLAUDE.md`, `NOBLE.md`, or `AGENTS.md` file exists at the repo root, its contents are automatically appended to the system prompt so the model picks up your conventions, style guides, or task-specific instructions.

---

# 🛑 Notes

- Noble AI does **not** send your code to cloud APIs (the optional Tavily call only sends your prompt as a search query).
- Requires Ollama to be running locally.
- Uses your machine's CPU/GPU and RAM.

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
- Diff-based edits (instead of full-file rewrites)
- VS Code extension
- Richer agent loops with more built-in tools

---

# 👨‍💻 Author

Larry-Noble Odai — Noble AI
