# Project structure — where everything lives

```
noble-ai/
├── bin/
│   └── noble.js          Executable entry point (the `noble-ai` command)
├── core/                 All application logic lives here
│   ├── chat.js           Orchestrator: REPL, commands, turn lifecycle, confirmations
│   ├── llm.js            System prompt + Ollama model loop + tool iteration
│   ├── tools.js          Tool registry: read_file, list_dir, grep, run + MCP routing
│   ├── mcp.js            MCP client (JSON-RPC over stdio) + server loader
│   ├── context.js        First-turn auto-context: rank & slice relevant project files
│   ├── references.js     @file / @glob / @dir / @url references + TAB completion
│   ├── apply.js          Parse model file-blocks, write to disk, snapshot/undo
│   ├── render.js         Markdown rendering + the edit review "card" + diffs
│   ├── models.js         The list of selectable models (name + tagline)
│   ├── state.js          Mutable global state (currently just the active model)
│   ├── ignore.js         .nobleignore + default skip dirs (node_modules, .git, …)
│   ├── search.js         Tavily web search (optional, first turn)
│   └── header.js         The boxed startup banner
├── docs/                 ← you are here
├── index.js              Empty placeholder (not used; entry is bin/noble.js)
├── package.json          Deps, `type: module`, bin mapping → bin/noble.js
└── README.md             Product-level readme
```

## Responsibility map

### Entry

| File | Purpose | Key exports |
| --- | --- | --- |
| `bin/noble.js` | Parse CLI args (`-p`, `--apply`, `--help`), load MCP servers, register their tools, then dispatch to one-shot or REPL. Also wires `SIGINT`/`exit` to stop MCP processes. | *(executable)* |

### Orchestration

| File | Purpose | Key exports |
| --- | --- | --- |
| `core/chat.js` | The largest file. Owns the `readline` REPL, all slash commands, `runTurn` (the turn lifecycle), the edit-approval and shell-approval prompts, prompt history, sessions, and one-shot mode. | `startCLI`, `runOneShot` |
| `core/state.js` | Tiny shared mutable state. Today: the active model name. | `state` |

### Model & tools

| File | Purpose | Key exports |
| --- | --- | --- |
| `core/llm.js` | Builds the system prompt (and appends project rules from `CLAUDE.md`/`NOBLE.md`/`AGENTS.md`). Runs the streaming `ollama.chat` loop with tool iterations and the text-tool-call fallback. | `askModel`, `buildSystemPrompt`, `ollama` |
| `core/tools.js` | Registry of built-in tools and a router for MCP tools. Enforces path/sandbox limits, the shell allowlist, and output caps. | `getToolDefs`, `executeTool`, `registerMCPTools`, `toolNeedsConfirm` |
| `core/mcp.js` | A minimal MCP client speaking JSON-RPC 2.0 over a child process's stdio; plus a loader that reads `~/.noble/mcp.json`. | `MCPClient`, `loadMCPServers` |
| `core/models.js` | The static list of models shown by `/models` and selectable with `/model`. | `models` |

### What the model sees (context in)

| File | Purpose | Key exports |
| --- | --- | --- |
| `core/context.js` | On the first turn, walks the repo, scores files against the prompt's keywords (with priority boosts for README/package manifests), and packs the highest-scoring files into a char-budgeted context block. | `getProjectContext` |
| `core/references.js` | Parses `@`-references in user input: exact paths, bare filenames (tree search), globs (`*`, `**`), line ranges (`file:10-20`), directories, and URLs. Also powers TAB completion. | `extractReferences`, `buildReferenceContext`, `completeReference` |
| `core/search.js` | Optional Tavily web search, appended to the first turn. No-op without `TAVILY_API_KEY`. | `webSearch` |

### Edits & output (results out)

| File | Purpose | Key exports |
| --- | --- | --- |
| `core/apply.js` | Parses the model's file blocks (three formats), writes accepted edits to disk, and keeps in-memory snapshots so `/undo` can revert. Also detects "looks like an edit but wasn't parseable". | `parseEdits`, `applyEdits`, `undoLast`, `looksLikeMissedEdit` |
| `core/render.js` | Renders assistant markdown for the terminal, hides file-edit blocks from the prose (final render + live stream), and renders the edit review **card** (`renderFileCard`) — header, line-numbered listing for new files, numbered `+/-` diff for edits. | `renderAssistant`, `createStreamSanitizer`, `renderFileCard`, `renderEditSummary`, `renderFileDiff` |
| `core/header.js` | Clears the screen and prints the boxed banner (model, RAM, git branch, project, path). | `renderHeader` |

### Cross-cutting

| File | Purpose | Key exports |
| --- | --- | --- |
| `core/ignore.js` | Default skip list (`node_modules`, `.git`, `dist`, …) plus user `.nobleignore` (global + project). Used by context, references, tools. | `getIgnore`, `shouldSkipName` |

## Data that lives outside the repo

| Path | What | Created by |
| --- | --- | --- |
| `~/.noble/mcp.json` | MCP server definitions | you (manually) |
| `~/.noble/sessions/*.json` | Saved conversations | `/save` |
| `~/.noble/history` | Cross-session prompt history | automatic |
| `~/.nobleignore` | Global ignore patterns | you (manually) |
| `./.nobleignore` | Per-project ignore patterns | you (manually) |
| `./CLAUDE.md` \| `./NOBLE.md` \| `./AGENTS.md` | Project rules appended to the system prompt | you (manually) |
| `.env` | `TAVILY_API_KEY`, etc. (loaded by `dotenv`) | you (manually) |

See [configuration.md](configuration.md) for details on each.
</content>
