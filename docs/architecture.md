# Architecture — how a turn flows

This document follows a single user message from keypress to written file. If you
understand this lifecycle, you understand the system.

## High-level pieces

| Layer | File(s) | Responsibility |
| --- | --- | --- |
| Entry / CLI | `bin/noble.js` | Parse flags, boot MCP, choose REPL vs one-shot |
| Orchestrator | `core/chat.js` | REPL loop, commands, turn lifecycle, confirmations, sessions |
| Model loop | `core/llm.js` | System prompt + `ollama.chat` streaming + tool-call iterations |
| Tools | `core/tools.js`, `core/mcp.js` | Built-in + MCP tools the model can call |
| Context in | `core/context.js`, `core/references.js`, `core/search.js` | What the model gets to see |
| Edits out | `core/apply.js`, `core/render.js` | Parse file blocks, render cards, write + undo |
| Support | `core/state.js`, `core/models.js`, `core/ignore.js`, `core/header.js` | Active model, model list, ignore rules, banner |

## The lifecycle (interactive mode)

```
startCLI()                         core/chat.js
  └─ renderHeader()                core/header.js   (banner: model, RAM, branch…)
  └─ prompt()  ◄────────────────────────────────────────┐ loop
       hr() + rl.question("❯❯ ") + hr()  (framed input)  │
         │ user types a line                             │
         ▼                                               │
   ┌───────────────────────────────────────────┐        │
   │ is it a slash command? (/help, /model, …)  │── yes ─┤ handle inline, re-prompt
   └───────────────────────────────────────────┘        │
         │ no — it's a prompt for the model              │
         ▼                                               │
   runTurn(input, session)                               │
         │                                               │
         ├─ resolveAndPrintRefs(input)   references.js    (extract @file refs, print summary)
         ├─ buildReferenceContext(refs)  references.js    (read those files/URLs)
         ├─ context inject (once, flag-gated):
         │     trivial ("hey")        → nothing
         │     project question       → getProjectTree()  context.js (tree only)
         │     first real request     → getProjectContext() + webSearch()
         ├─ push { role:"user", content: input + appended context }
         │
         ├─ askModel(messages, onStatus, onChunk, toolCtx)   llm.js
         │     loop up to MAX_TOOL_ITERATIONS (8):
         │       ollama.chat({ model: state.model, tools: getToolDefs(), stream })
         │         onChunk(text) ──► sanitize (hide edit blocks + tool JSON) ──►
         │                          ✦ prose, or keep spinner while code generates
         │         collect tool_calls (native, or text JSON naming a real tool)
         │       if tool calls: executeTool(name, args)  tools.js
         │                       push { role:"tool", ... }, loop again
         │       else: return final text
         │
         ├─ re-render final text as markdown      render.js (renderAssistant)
         │
         └─ parseEdits(response)                  apply.js
               if edits:
                 promptForEdits(edits)            chat.js
                   renderFileCard(edit)           render.js  (the review card)
                   selectFromMenu(...)            chat.js    (Yes / Yes-all / No)
                   applyEdits(accepted)           apply.js   (write + snapshot for /undo)
         └──────────────────────────────────────────────► back to prompt()
```

## Step-by-step detail

### 1. Input arrives — `prompt()` in `core/chat.js`

`startCLI()` calls `prompt()`, which draws a full-width blue frame rule (`hr()`)
then `askLine()` reads input via `readline`'s `rl.question` with a blue `❯❯`
caret; the matching bottom rule is drawn on submit, so each input is framed. The
readline interface is customized (`rl._ttyWrite` is overridden) to support:

- **TAB completion** for `@file` references (`handleTabCompletion`) and slash
  commands (`handleSlashCompletion`).
- **Ctrl+D** to cancel an in-flight generation (via the `cancelGen` hook).
- A one-time hint the first time you type `@`.

Every non-empty line is saved to `~/.noble/history` (`saveHistoryEntry`). Typing
`exit` (or Ctrl+D/Ctrl+C) prints the `farewell()` "Goodbye 👋" banner and quits.

### 2. Slash commands short-circuit

Before anything is sent to the model, `prompt()` checks for built-in commands
(`/help`, `/model`, `/undo`, `/retry`, `/save`, `/tokens`, …). These are handled
inline and the loop returns to `prompt()`. See [modules.md](modules.md#chatjs)
for the full list. Anything that is **not** a command becomes a model turn.

### 3. `runTurn(input, session)` builds the message

`runTurn` is the heart of a turn and is shared by the REPL, `/retry`, and
one-shot mode. It:

1. **Resolves `@references`** (`resolveAndPrintRefs` → `extractReferences`) and
   prints a one-line summary of each attached file/glob/URL so you can see what
   was injected.
2. **Appends reference content** (`buildReferenceContext`) under a
   `--- REFERENCED FILES ---` block.
3. **Injects context once**, gated by flags (not turn number, so a leading "hey"
   can't waste it) and by what the input looks like:
   - **Trivial** input (`isTrivialInput` — greetings/pleasantries) → nothing.
   - **Project question** (`isProjectQuestion` — "what is this repo?", and *not* a
     build request) → just the file tree (`getProjectTree`) under
     `--- PROJECT FILE TREE ---`, once (`session.treeInjected`). Lightweight on
     purpose: enough to describe the project, without dumping files the model
     might echo verbatim.
   - **First substantive request** otherwise → the full ranked
     `--- PROJECT CONTEXT ---` (`getProjectContext`) + `--- WEB SEARCH ---`
     (`webSearch`, empty without an API key), once (`session.contextInjected`).
   Context is *not* re-sent every turn — follow-ups rely on `read_file` / `grep` /
   `list_dir`.
4. If `session.formatReminder` is set (from a prior missed edit), appends a strong
   "actually write the file" instruction, then clears the flag.
5. Pushes the assembled `{ role: "user", content }` onto `session.messages` and
   increments `session.turnCount`.

> **Why inject once, not every turn?** It seeds the model cheaply without
> re-paying the token cost. Gating on flags (rather than `turnCount === 0`) means
> the seed lands on the first turn that actually needs it, even after a greeting.

### 4. `askModel(...)` runs the model loop — `core/llm.js`

`askModel` loops up to `MAX_TOOL_ITERATIONS` (8). Each iteration:

- Calls `ollama.chat` with `model: state.model`, `tools: getToolDefs()`,
  `stream: true`, and `options: { num_ctx, temperature: 0.3 }`.
  `num_ctx` is `NOBLE_NUM_CTX` or `8192`.
- Streams content chunks out via `onChunk` (rendered live with a `✦ ` prefix)
  and collects any `tool_calls`.
- **Text-tool-call fallback**: smaller models sometimes emit a tool call as JSON
  in the message body instead of using native tool-calling. `extractTextToolCalls`
  scans the content for balanced JSON objects shaped like `{ name, arguments }`;
  they're executed even when wrapped in narration, but only if the name matches a
  **real registered tool** (so stray illustrative JSON isn't run). The raw JSON
  line is hidden from the user by the stream sanitizer.
- If there are tool calls, it runs each via `executeTool` and pushes a
  `{ role: "tool", tool_name, content }` message, then loops again.
- If there are no tool calls, it returns the final text.

If the loop hits the iteration cap, it returns a "reached the tool-call limit"
message instead of hanging.

### 5. Tools execute — `core/tools.js`

`executeTool(name, args, ctx)` dispatches to:

- a **built-in** (`read_file`, `list_dir`, `grep`, `run`), or
- an **MCP route** (`mcp__<server>__<name>`) registered from `~/.noble/mcp.json`.

Safety rails:

- `resolveSafe` confines every path to the project root — the model cannot read
  outside the working directory.
- `run` (shell) is gated: read-only commands match a `DEFAULT_ALLOWLIST` and run
  silently; anything else triggers `ctx.confirm` (the interactive `[y]es / [n]o /
  [a]lways` prompt in `confirmShellCommand`). `[a]lways` adds a session-scoped
  regex to `session.allowlist`.
- Output sizes are capped (file bytes, grep matches, shell stdout/stderr).

### 6. The response is rendered

As tokens arrive, `onChunk` passes them through a **stream sanitizer**
(`createStreamSanitizer`) that strips file-edit blocks out of the live stream, so
the file's contents never scroll by in the prose — they only appear in the review
card. The moment the sanitizer reports `inEditBlock()`, `runTurn` switches to
`editMode`: it wipes any short intro and keeps the **thinking spinner animating**
through the (hidden) code generation, right up until the card appears. Plain chat
answers (no edit blocks) keep streaming live.

When streaming ends and the output still fits the viewport, `runTurn` walks the
cursor back and re-renders the final segment as prettified markdown
(`renderAssistant` in `core/render.js`, using `marked` + `marked-terminal` +
syntax highlighting). If output already scrolled off-screen, it leaves the raw
stream in place to avoid duplicated text.

### 7. File edits are proposed and applied — `core/apply.js` + `core/render.js`

`parseEdits(response)` extracts file blocks in one of three formats (see
[modules.md](modules.md#applyjs)); `unwrapFence` removes any stray ` ``` ` the
model wrapped the body in so backticks never end up in the file. For each edit,
`promptForEdits`:

1. Prints a **review card** (`renderFileCard`) — boxed header `⏺ Write(path)`,
   the full new contents (line-numbered) for new files, or a numbered `+/-` diff
   for edits.
2. Asks via an arrow-select menu (`selectFromMenu`): **Yes / Yes, allow all edits
   this session / No**.
3. `applyEdits(accepted)` writes the files and records a snapshot so `/undo`
   (`undoLast`) can restore or delete them.

If the model produced **no** parseable edit but clearly meant to create a file
(`looksLikeMissedEdit` — e.g. "I'll create greeting.js" followed by code with no
markers), `prompt()` rolls back the turn, sets `session.formatReminder`, and
**auto-retries once** with a strong "actually write the file" instruction. If the
retry still fails, `warnIfMissedEdit` surfaces a heads-up.

## One-shot mode

`bin/noble.js` calls `runOneShot` (in `core/chat.js`) when given `-p/--prompt` or
piped stdin. It runs a single `runTurn`, prints proposed edits with
`renderEditSummary`, and writes them only if `--apply` was passed. No REPL, no
confirmation prompts.

## Key cross-cutting concepts

- **`session`** (`newSession()`): `{ messages, turnCount, lastResponse,
  lastUserInput, allowlist, formatReminder, contextInjected, treeInjected }`. The
  `messages` array is the full chat history sent to Ollama every turn.
  `formatReminder` is a one-shot flag that makes the next turn nag the model to use
  a writable file format; `contextInjected` / `treeInjected` ensure the full
  context and the file tree are each injected at most once. Saved/loaded as JSON
  via `/save` / `/load`.
- **`state`** (`core/state.js`): just `{ model }` — the globally active model.
  `/model` mutates it; `core/llm.js` reads it.
- **Cancellation**: `runWithCancel` registers a `cancelGen` that Ctrl+D triggers,
  which calls `ollama.abort()` and rejects with an `AbortError`.
- **Context budget**: `getProjectContext` caps at ~24k chars; `num_ctx` defaults
  to 8192 tokens. `/tokens` shows a rough estimate (chars/4).
