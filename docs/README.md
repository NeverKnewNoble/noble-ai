# Noble AI — Developer Documentation

Noble AI is a **local, terminal-based AI coding assistant**. It talks to a model
running in [Ollama](https://ollama.com) on your machine, gives that model tools
to read/search/run things in your project, streams the answer back into the
terminal, and — when the model proposes file changes — shows them in a review
card and writes them only after you approve.

There is no cloud backend. Everything runs in one Node.js process plus the local
Ollama server (and, optionally, MCP tool servers it spawns).

```
┌──────────┐     prompt      ┌───────────────┐   ollama.chat()   ┌──────────┐
│   You    │ ──────────────► │   Noble AI    │ ────────────────► │  Ollama  │
│ (terminal)│ ◄────────────── │ (this Node app)│ ◄──────────────── │  (model) │
└──────────┘   streamed reply └───────┬───────┘   tokens + tool   └──────────┘
                                       │             calls
                       reads/searches/ │
                       runs/ writes     ▼
                              ┌──────────────────┐
                              │  your project     │
                              │  files on disk    │
                              └──────────────────┘
```

## Start here

| If you want to… | Read |
| --- | --- |
| Understand how a single request flows through the system | [architecture.md](architecture.md) |
| Find which file does what | [structure.md](structure.md) |
| Read a per-module reference of everything in `core/` | [modules.md](modules.md) |
| **Add a tool, a model, a slash command, or an edit format** | [extending.md](extending.md) |
| Configure env vars, ignore files, project rules, MCP servers | [configuration.md](configuration.md) |

## 30-second tour

- **`bin/noble.js`** — the executable. Parses CLI flags, boots MCP servers, then
  either runs one prompt (`-p`) or starts the interactive REPL.
- **`core/chat.js`** — the orchestrator. Owns the REPL, slash commands, the
  turn lifecycle, edit/shell confirmation prompts, sessions, and history.
- **`core/llm.js`** — the model loop. Builds the system prompt and drives
  `ollama.chat`, including the tool-call iteration loop.
- **`core/tools.js`** — the tool registry. Built-in tools (`read_file`,
  `list_dir`, `grep`, `run`) plus dynamically-registered MCP tools.
- **`core/context.js` / `core/references.js`** — what the model gets to *see*:
  auto-selected project context on turn 1, and explicit `@file` references.
- **`core/apply.js` / `core/render.js`** — parsing the model's file blocks and
  rendering them as review cards / writing them to disk with undo support.

## Mental model for adding features

Most new capabilities fall into one of four buckets, each with a recipe in
[extending.md](extending.md):

1. **Give the model a new ability** → add a *tool* (`core/tools.js`).
2. **Support a new model** → add it to `core/models.js` (Ollama does the rest).
3. **Add a user command** → add a *slash command* (`core/chat.js`).
4. **Change what the model sees** → edit context/reference building
   (`core/context.js`, `core/references.js`) or the system prompt
   (`core/llm.js`).

## Requirements

- Node.js 18+ (uses native `fetch`, top-level `await`, ES modules).
- [Ollama](https://ollama.com) running locally (`ollama serve`) with at least one
  of the models in `core/models.js` pulled (`ollama pull qwen2.5-coder:7b`).
- Optional: a `TAVILY_API_KEY` for web search, and `~/.noble/mcp.json` for MCP
  tools.
</content>
</invoke>
