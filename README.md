# ⚡ Noble AI

A local, Cursor-style AI coding assistant that runs in your terminal — powered by Ollama.

Noble AI lets you chat with local coding models (qwen2.5-coder, deepseek-coder, etc.) from inside any project directory. It reads your project, optionally pulls in live web results, and can write file edits back to disk with a one-keystroke undo.

It behaves similarly to:
- Cursor AI
- Claude CLI
- terminal coding copilots

but runs locally on your machine.

---

# 🚀 Features

- Local AI coding assistant — no cloud, no subscription
- Claude-style terminal UI with markdown + syntax highlighting
- Project-aware context scanning (relevance-scored file selection)
- Optional live web search via Tavily for up-to-date answers
- Inline file edits — assistant emits `<<<FILE>>>` blocks, you approve, Noble writes them
- `/undo` to revert the last applied edit set
- Multi-model support with live `/model` switching
- Cancel a running generation with `Ctrl+D`
- Header panel showing model, RAM, git branch, and project path

---

# 🧠 Tech Stack

| Tool | Purpose |
|------|----------|
| Ollama | Runs local LLMs |
| Qwen / DeepSeek | Coding models |
| Node.js (ESM) | CLI runtime |
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
 │    └── noble.js        # CLI entry point
 │
 ├── core/
 │    ├── chat.js         # REPL loop, slash commands, edit prompts
 │    ├── llm.js          # Ollama client + system prompt
 │    ├── context.js      # Project scanner / relevance scorer
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

### 6. Make Noble AI global

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
explain this project
add a /health endpoint to the express server
```

When the model proposes file changes, Noble AI prints a summary and asks before writing anything to disk.

---

# ⌨️ Commands & Shortcuts

| Command | Description |
|---------|-------------|
| `?` or `/help` | Show shortcuts |
| `/models` | List available models |
| `/model` | Show the active model |
| `/model <name\|number>` | Switch model |
| `/undo` | Revert the last applied file changes |
| `/clear` | Clear the screen and redraw the header |
| `Ctrl+D` | Cancel a running generation |
| `Ctrl+C` / `exit` | Quit Noble AI |

---

# 🧠 How It Works

```text
your prompt
     ↓
context scanner  ──►  scores & picks relevant project files
     ↓
web search (optional, via Tavily)
     ↓
Ollama (local model)
     ↓
rendered response + optional <<<FILE>>> edit blocks
     ↓
you approve → apply.js writes to disk (with undo snapshot)
```

The model is instructed to emit full-file rewrites inside `<<<FILE: path>>> ... <<<END>>>` markers. `core/apply.js` parses these, snapshots the originals, writes the new versions, and stores the snapshot so `/undo` can roll back.

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

- Streaming responses
- Embeddings + semantic file retrieval
- Diff-based edits (instead of full-file rewrites)
- VS Code extension
- Agent loops with tool use

---

# 👨‍💻 Author

Larry-Noble Odai — Noble AI
