# Module reference

A per-file reference of `bin/` and `core/`. For the big-picture flow, read
[architecture.md](architecture.md) first.

---

## `bin/noble.js`

The executable mapped to the `noble-ai` command (see `package.json` → `bin`).

- `parseArgs(argv)` — supports `-h/--help`, `--apply`, `-p/--prompt <text>` and
  `--prompt=<text>`.
- Loads MCP servers from `~/.noble/mcp.json` (`loadMCPServers`) and registers
  their tools (`registerMCPTools`) **before** any model turn.
- Reads stdin if not a TTY, so `echo "..." | noble-ai` and
  `cat file | noble-ai -p "..."` work (stdin is appended to `-p`).
- If there's one-shot input → `runOneShot(input, { autoApply })`, else
  `startCLI()`.
- Cleans up MCP child processes on `exit` and `SIGINT`.

---

## `core/chat.js`

The orchestrator. This is the file you'll touch most often.

### Module-level setup
- `rl` — a single `readline` interface with custom `_ttyWrite` for TAB
  completion, Ctrl+D cancel, and the one-time `@` hint.
- `theme` — chalk color helpers (`primary`, `secondary`, `dim`, `success`,
  `error`).
- Input predicates: `isTrivialInput` (greetings), `userWantsFile` (build/edit
  intent — gates the auto-retry), `isProjectQuestion` (asking *about* the
  project — triggers the file-tree inject).
- `HISTORY_FILE`, `SESSIONS_DIR`, `SLASH_COMMANDS`.

### Turn lifecycle
- `runTurn(input, session)` — resolves refs, builds context, pushes the user
  message, calls `askModel` with live streaming, re-renders markdown, and returns
  `{ ok, response }`. On error it pops the half-finished turn and reports
  Ollama-specific hints (e.g. "is `ollama serve` running?"). If
  `session.formatReminder` is set, it appends a strong "actually write the file"
  instruction to this turn's message and clears the flag.
- **Context injection** (inside `runTurn`, flag-gated so a leading "hey" can't
  burn it):
  - `isTrivialInput(input)` (greetings/pleasantries) → inject nothing.
  - `isProjectQuestion(input)` ("what is this repo?", not a build) → inject just
    the file tree (`getProjectTree`) once, guarded by `session.treeInjected`.
  - otherwise the first substantive request → full `getProjectContext` + web
    search once, guarded by `session.contextInjected`.
- **Streaming internals** (closures inside `runTurn`): `emit(out)` writes
  sanitized text and tracks rows/cols for the re-render; the text first passes
  through `createStreamSanitizer()` so edit blocks never appear in the prose. Once
  `sanitizer.inEditBlock()` is true, `runTurn` flips into `editMode`: it wipes any
  short intro (`eraseStream()`) and keeps the spinner animating until generation
  finishes, then prints the prose + review card. Normal chat answers stream live
  as before.
- `resolveAndPrintRefs(input)` — extracts `@`-refs and prints a one-line summary
  of each.
- `popLastTurn(session)` / `stripAppendedContext(content)` — support `/retry` and
  error recovery.

### Prompts & confirmations
- `prompt()` / `askLine()` — the REPL loop. `prompt()` draws the top frame rule
  (`hr()`, full-width blue) then calls `askLine()`, which reads input via
  `rl.question` (a blue `❯❯` caret). On submit it draws the bottom rule, so each
  input is framed; empty Enter re-asks within the same frame. `askLine()` is also
  the slash-command dispatcher.
- `hr()` — a full-width blue `─` rule used to frame the input.
- `farewell()` — the centered "Goodbye 👋" banner (blue rules) printed on `exit`
  and on `rl` close; it doubles as the closing frame so there's no extra spacing.
- `promptForEdits(edits, next)` — renders each edit as a card and asks
  Yes / Yes-all / No.
- `selectFromMenu(question, options)` — arrow-key (↑/↓ or `j`/`k`, or number)
  select menu used by the edit prompt.
- `readSingleKey()` — reads one raw keypress without readline echoing it (used by
  menus and shell confirmation).
- `confirmShellCommand(command, session)` — the `[y]es / [n]o / [a]lways` prompt
  for `run`; `[a]lways` appends a regex to `session.allowlist`.

### Slash commands (handled in `prompt()`)
| Command | Effect |
| --- | --- |
| `?` / `/help` | Print the full help screen |
| `/retry` | Pop and re-run the last turn |
| `/copy` | Copy last response to clipboard (`pbcopy`/`clip`/`xclip`) |
| `/tokens` | Rough context-window usage bar (`estimateTokens`) |
| `/clear` | Reset the session and redraw the header |
| `/save <name>` / `/load <name>` / `/sessions` | Session persistence in `~/.noble/sessions/` |
| `/models` / `/model` / `/model <name\|number>` | List / show / switch the active model |
| `/undo` | Revert the last applied file changes (`undoLast`) |
| `/keytest` | Debug: print what readline receives for each key |

### Sessions & history
- `saveSession` / `loadSession` / `listSessions` / `sanitizeSessionName` —
  JSON files in `~/.noble/sessions/`.
- `loadHistory` / `saveHistoryEntry` — `~/.noble/history`, capped at
  `HISTORY_MAX` (500).

### Misc helpers
- `newSession()` — fresh `{ messages:[system], turnCount, lastResponse,
  lastUserInput, allowlist, formatReminder, contextInjected, treeInjected }`.
  `loadSession` sets `contextInjected`/`treeInjected` to `true` (a resumed
  conversation already carries its context).
- `estimateTokens`, `renderBar`, `formatAge`, `copyToClipboard`,
  `makeAllowPattern`.
- `warnIfMissedEdit(response, session)` — when the model produced no parseable
  edit but clearly meant to (`looksLikeMissedEdit`), prints a heads-up.
- **Missed-edit auto-retry**: in the `askLine()` handler, if a turn produced no
  edits, **the user actually asked for a file** (`userWantsFile(input)`), and
  `looksLikeMissedEdit` is true, it rolls back the bad turn (`popLastTurn`), sets
  `session.formatReminder`, and re-runs `runTurn` **once** with the format
  reminder. The `userWantsFile` gate prevents force-writing a file for a greeting
  the model spontaneously "described". `/retry` sets the same flag under the same
  conditions.

### Exports
`startCLI()` (interactive) and `runOneShot(input, { autoApply })` (one prompt).

---

## `core/llm.js`

The model loop and system prompt.

- `BASE_SYSTEM_PROMPT` — the long instruction string that tells the model how to
  call tools and, crucially, **the exact file-edit formats** that `apply.js` can
  parse. It also constrains behavior: keep prose to one short sentence, never
  reproduce the file's contents as prose (the user sees it in the card), don't
  wrap the body in ` ``` ` fences inside the markers, and never show code as plain
  or indented text. If you change the edit formats in `apply.js`, change them here
  too.
- `buildSystemPrompt(cwd)` — base prompt plus the first of
  `CLAUDE.md` / `NOBLE.md` / `AGENTS.md` found in the project, appended as
  "PROJECT RULES".
- `askModel(messages, onStatus, onChunk, toolCtx)` — the streaming loop:
  - up to `MAX_TOOL_ITERATIONS` (8) rounds of `ollama.chat`,
  - streams content via `onChunk`, status via `onStatus`,
  - collects native `tool_calls`, or falls back to `extractTextToolCalls`,
  - executes tools via `executeTool` and feeds results back as `role:"tool"`
    messages,
  - returns the final assistant text.
- `extractTextToolCalls` — the fallback that lets weaker models "call" tools by
  emitting `{ "name": ..., "arguments": ... }` JSON in the body. These are now
  **executed even when wrapped in narration**, but only if the JSON names a tool
  that actually exists (`getToolDefs()` names) — so stray illustrative JSON isn't
  mistaken for a call. The leaked JSON line itself is hidden by `render.js`'s
  sanitizer, so the user never sees raw tool-call JSON.
- Re-exports `ollama` so `chat.js` can call `ollama.abort()` for cancellation.

Tuning knobs: `MAX_TOOL_ITERATIONS`, `temperature` (0.3), `num_ctx`
(`NOBLE_NUM_CTX` or 8192).

---

## `core/tools.js`

The tool registry and sandbox.

- **Built-ins** (`builtins` Map): `read_file`, `list_dir`, `grep`, and `run`
  (the only one with `needsConfirm: true`). Each entry is
  `{ def, handler, needsConfirm? }` where `def` is the JSON-schema tool
  definition sent to Ollama.
- **MCP routes** (`mcpRoutes` Map): `registerMCPTools(clients)` adds
  `mcp__<server>__<tool>` entries that proxy to an `MCPClient`.
- `getToolDefs()` — the combined array of tool definitions handed to the model.
- `executeTool(name, args, ctx)` — dispatch + error wrapping.
- `toolNeedsConfirm(name)` — whether a tool requires user approval.

Safety:
- `resolveSafe(rel)` throws if a path escapes the project root.
- `DEFAULT_ALLOWLIST` — regexes for read-only shell commands that auto-run;
  everything else needs `ctx.confirm`. `ctx.extraAllowlist` adds session-approved
  patterns.
- Caps: `MAX_FILE_BYTES`, `MAX_GREP_MATCHES`, `MAX_DIR_ENTRIES`,
  `MAX_SHELL_STDOUT/STDERR`, `DEFAULT_SHELL_TIMEOUT_MS`.

---

## `core/mcp.js`

A minimal [Model Context Protocol](https://modelcontextprotocol.io) client.

- `MCPClient` — spawns the server process, speaks JSON-RPC 2.0 over newline-
  delimited stdio, performs the `initialize` handshake, lists tools
  (`tools/list`), and calls them (`tools/call`). `stop()` kills the process.
- `loadMCPServers(configPath)` — reads `{ mcpServers: { name: { command, args,
  env } } }` from `~/.noble/mcp.json`, starts each, and returns the live clients.
  Failures are logged but don't crash startup.

---

## `core/context.js`

Automatic context selection.

- `getProjectContext(cwd, query)` — the full, ranked context for a substantive
  request:
  1. `walk` the repo for known source `EXTENSIONS`, skipping ignored dirs.
  2. Build a truncated file **tree** (up to `TREE_LIMIT` = 120).
  3. Tokenize the prompt into keywords (minus `STOPWORDS`).
  4. `scoreFile` each file: keyword hits in path/content, a large boost for
     `PRIORITY_FILES` (README, package manifests, configs), a small depth
     penalty.
  5. Pack the top-ranked files into a block until `MAX_CONTEXT_CHARS` (24k).
- `getProjectTree(cwd)` — a **lightweight** snapshot: just the file tree, no file
  contents. Injected for project questions so the model can describe the project
  without us dumping whole files it might echo back verbatim.

Tuning knobs: `EXTENSIONS`, `PRIORITY_FILES`, `STOPWORDS`, `MAX_CONTEXT_CHARS`,
`TREE_LIMIT`, `MAX_FILE_BYTES`.

---

## `core/references.js`

Explicit `@`-references and their TAB completion.

- `extractReferences(input, cwd)` — finds `@tokens` and resolves each to:
  exact path, bare filename (tree search, ambiguity-aware), glob (`*`, `?`,
  `**`), `path:start-end` line range, directory (dumps contained files), or URL.
- `buildReferenceContext(refs, cwd)` — reads/fetches the resolved targets into
  labeled blocks, honoring per-file and bulk byte caps and a URL fetch timeout.
- `completeReference(line, cwd)` — powers TAB completion in the REPL (returns
  `{ completions, prefix }`).

Tuning knobs: `MAX_REF_FILE_BYTES`, `MAX_DIR_FILES`, `MAX_DIR_BYTES`,
`MAX_GLOB_MATCHES`, `MAX_URL_BYTES`, `URL_FETCH_TIMEOUT_MS`.

---

## `core/apply.js`

Parsing and writing file edits.

- `parseEdits(text)` — tries three formats, in order:
  1. **Preferred**: `<<<FILE: path>>> … <<<END>>>` markers (indent-tolerant).
  2. **Fallback**: a `### File: \`path\`` heading immediately above a fenced
     code block.
  3. **Inline fallback**: a `// File: path` (or `#`, `--`) comment as the first
     line *inside* a fenced block (common with `qwen2.5-coder`).
- `unwrapFence(text)` — when the model wraps the file body in a single ` ``` `
  fence *inside* the `<<<FILE>>>` markers, those backticks aren't part of the
  file; `parseEdits` strips them so they don't get written to disk.
- `applyEdits(edits, cwd)` — writes each file (creating dirs), recording a
  snapshot `{ path, original, existed }` per file onto the `snapshots` stack.
- `undoLast()` — pops the last snapshot, restoring originals and deleting
  files that didn't exist before.
- `looksLikeMissedEdit(text)` — heuristic: did the model clearly *intend* an edit
  but produce no parseable block? Catches two shapes: (a) it named a file it would
  create/edit (e.g. "I'll create greeting.js") and then showed code with no
  markers (often an indented block), or (b) a `File:` marker / first-person
  "I created the file" claim alongside a fenced block. Drives `warnIfMissedEdit`
  and the one-shot auto-retry in `prompt()`.

> If you add or change an edit format here, update `BASE_SYSTEM_PROMPT` in
> `core/llm.js`, the `stripEditBlocks` regexes in `core/render.js`, and the live
> `createStreamSanitizer` so the new block is hidden from the prose too.

---

## `core/render.js`

Terminal rendering.

- `renderAssistant(raw)` — strips **all** file-edit blocks (`<<<FILE>>>`,
  `### File:`, and inline `// File:` formats) **and** leaked plain-text tool-call
  JSON (`TOOL_CALL_JSON`), renders the rest as markdown via `marked` +
  `marked-terminal`, with `cli-highlight` for code, and indents it under a `✦ `
  prefix. The edit contents only ever appear in the review card.
- `createStreamSanitizer()` — a stateful, line-buffered filter that removes those
  same edit blocks **and** tool-call JSON lines from the **live token stream** as
  it arrives, so neither file contents nor raw tool-call JSON scroll by in the
  prose. Returns `{ push(chunk), flush(), inEditBlock() }`; `inEditBlock()`
  reports when a file block has started so `runTurn` can keep the spinner up
  instead of streaming the (hidden) code. Used by `runTurn` in `core/chat.js`.
- `renderFileCard(edit, cwd)` — the **edit review card**: `⏺ Write(path)` header,
  a solid rule, `Create file` / path, a dashed rule, then a syntax-highlighted
  **line-numbered listing** (new files) or a **numbered `+/-` diff** (edits).
- `renderEditSummary(edits, cwd)` — cards for all edits (used by one-shot mode).
- `renderFileDiff` / `renderUnifiedDiff` — the older unified-diff renderer, kept
  for reference; `renderFileCard` is the current UI.
- Helpers: `langFromPath`, `numberedListing`, `numberedDiff`, `cardWidth`,
  `highlightCode`.

---

## `core/models.js`

`models` — an array of `{ name, tagline }`. `name` must be a tag Ollama can run
(`ollama pull <name>`). Shown by `/models`, selected by `/model`.

---

## `core/state.js`

`state` — the single shared mutable object, currently `{ model }`. The default
active model is set here. `core/llm.js` reads `state.model`; `/model` writes it.

---

## `core/ignore.js`

- `getIgnore(cwd)` — cached matcher combining `DEFAULT_SKIP` dirs with patterns
  from `~/.nobleignore` and `./.nobleignore`. Supports name, `*.ext`, and
  `path/with/slash` patterns.
- `shouldSkipName(name, cwd)` — convenience name check used by directory walks.

---

## `core/search.js`

`webSearch(query)` — POSTs to the Tavily API with `TAVILY_API_KEY` (loaded via
`dotenv`), returns the top results formatted as text, or a failure string. Called
once, alongside the full project context, on the first substantive request.

---

## `core/header.js`

`renderHeader()` — clears the screen and prints the startup banner:
- a solid-blue ANSI-shadow **"NOBLE AI" logo** (`LOGO`), with a compact
  `✦ N O B L E  A I ✦` fallback when the terminal is too narrow (`renderLogo`);
- a tagline + version (read live from `package.json` via `version()`);
- a rounded status panel (via `boxen`): active model, RAM (`systeminformation`),
  git branch, project, and a left-truncated path (`shortPath`);
- the `✦` greeting and the key-hint line.

---

## `core/ui.js`

The brand layer — the single place to reskin the UI.

- `BRAND` — the palette stops (currently a blue family). `c` — named chalk
  helpers (`primary`, `accent`, `label`, `value`, `dim`, `faint`).
- `gradient(text, stops?, width?)` / `sampleGradient(stops, t)` — left-to-right
  gradient colorizers. Available for reuse, though the current UI is solid blue.

`core/chat.js`'s `theme` and `core/header.js` both draw from this blue palette,
so changing `BRAND` / `c` reskins the header, the input frame, the `❯❯` caret,
the `✦` assistant prefix, and the goodbye banner together.
