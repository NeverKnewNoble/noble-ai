# Configuration

Everything Noble AI reads at runtime — env vars, config files, and project
conventions. None of these are required to start (defaults work), but each
unlocks behavior.

## Environment variables

| Variable | Default | Effect | Read in |
| --- | --- | --- | --- |
| `NOBLE_NUM_CTX` | `8192` | Ollama context window in tokens. Lower it (e.g. `4096`) if a small model OOMs. | `core/llm.js`, shown by `/tokens` |
| `TAVILY_API_KEY` | *(none)* | Enables web search on the first turn. Without it, `webSearch` returns nothing. | `core/search.js` (via `.env`) |

`.env` in the project root is loaded by `dotenv` (imported in `core/search.js`).
Example:

```
TAVILY_API_KEY=tvly-xxxxxxxx
```

Set `NOBLE_NUM_CTX` inline per run:

```bash
NOBLE_NUM_CTX=4096 noble-ai
```

## Files Noble AI reads

### Project rules — `CLAUDE.md` / `NOBLE.md` / `AGENTS.md`
The first of these found in the project root is appended to the system prompt as
"PROJECT RULES" (`buildSystemPrompt` in `core/llm.js`). Use it to give the model
project-specific conventions, do/don't lists, or architecture notes. **This is
the no-code way to steer the model per project.**

### Ignore files — `~/.nobleignore` and `./.nobleignore`
Patterns here are skipped by context selection, references, and tools
(`core/ignore.js`). On top of these, a built-in `DEFAULT_SKIP` list always
ignores `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `coverage`,
`.next`, `.nuxt`, `.cache`, `.turbo`, `.parcel-cache`, `__pycache__`, `.venv`,
`venv`, `.pytest_cache`.

Supported pattern forms:
- `name` — a directory or file name anywhere (e.g. `tmp`)
- `*.ext` — extension match (e.g. `*.log`)
- `path/with/slash` — a relative path prefix (e.g. `build/generated`)
- lines starting with `#` are comments

### MCP servers — `~/.noble/mcp.json`
Defines external tool servers, started at launch. Shape:

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server", "--flag"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

Each server's tools become callable as `mcp__<server-name>__<tool-name>`.
Startup failures are logged but don't stop Noble AI. See
[extending.md](extending.md#6-add-tools-via-mcp-no-code).

## Files Noble AI writes

| Path | What | Written by |
| --- | --- | --- |
| `~/.noble/history` | Prompt history, newest appended, capped at 500 lines | every non-empty REPL line |
| `~/.noble/sessions/<name>.json` | A saved conversation (`messages`, `model`, counts) | `/save <name>` |

`/load <name>` restores a session; `/sessions` lists them. Session names are
sanitized to `[a-z0-9._-]` and truncated to 64 chars.

## Shell command safety (`run` tool)

The `run` tool (`core/tools.js`) only auto-executes commands matching
`DEFAULT_ALLOWLIST` — read-only things like `ls`, `cat`, `git status/log/diff`,
`npm list`, `node -v`, etc. Anything else prompts you with `[y]es / [n]o /
[a]lways`. Choosing `[a]lways` adds a session-scoped regex (first 1–2 tokens of
the command) to `session.allowlist`, so re-runs with different flags don't
re-prompt. The allowlist is per-session and is **not** persisted.

## CLI flags (`bin/noble.js`)

| Flag | Effect |
| --- | --- |
| *(none)* | Start the interactive REPL |
| `-p`, `--prompt "<text>"` | Run a single prompt and exit (one-shot mode) |
| `--prompt=<text>` | Same, `=` form |
| `--apply` | In one-shot mode, write proposed edits without prompting |
| `-h`, `--help` | Print usage |
| *(piped stdin)* | Read prompt from stdin; appended to `-p` if both given |

## Runtime dependencies

- **Ollama** must be running (`ollama serve`) with the active model pulled. If
  not, turns fail with a "fetch failed" hint pointing you to start it.
- **Clipboard** (`/copy`) needs `pbcopy` (macOS), `clip` (Windows), or `xclip`
  (Linux) on `PATH`.
- **Git** is optional — the header shows `no-git` outside a repo.
</content>
