# Extending Noble AI

Recipes for the four most common kinds of feature work. Each one names the file
to edit, shows a minimal change, and lists what else to keep in sync.

- [Add a tool the model can call](#1-add-a-tool)
- [Add / swap a model](#2-add-or-swap-a-model)
- [Add a slash command](#3-add-a-slash-command)
- [Change what the model sees (context / references / system prompt)](#4-change-what-the-model-sees)
- [Add a new file-edit format](#5-add-a-new-file-edit-format)
- [Add tools from an MCP server (no code)](#6-add-tools-via-mcp-no-code)

A short checklist for any change is at the [bottom](#testing-your-change).

---

## 1. Add a tool

Tools are how the model *does* things (read, search, run, and anything you add).
They live in `core/tools.js` in the `builtins` Map. Each entry is:

```js
builtins.set("tool_name", {
  needsConfirm: false,          // true = user must approve each call (like `run`)
  def: {                        // the schema sent to the model
    type: "function",
    function: {
      name: "tool_name",
      description: "One clear sentence telling the model when to use this.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "..." }
        },
        required: ["path"]
      }
    }
  },
  handler: async (args, ctx) => {
    // return a STRING (or anything; non-strings get JSON.stringify'd upstream)
    return "result text the model will read"
  }
})
```

### Worked example — a `write_note` tool

```js
import fs from "fs"          // already imported at the top of tools.js

builtins.set("write_note", {
  def: {
    type: "function",
    function: {
      name: "write_note",
      description: "Append a line to NOTES.md in the project root. Use when the user asks you to jot something down.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The note to append." }
        },
        required: ["text"]
      }
    }
  },
  handler: (args) => {
    const note = (args.text || "").trim()
    if (!note) return "Error: missing text"
    const full = resolveSafe("NOTES.md")          // keeps it inside the project
    fs.appendFileSync(full, note + "\n")
    return `Appended note to NOTES.md`
  }
})
```

That's it — `getToolDefs()` and `executeTool()` pick it up automatically; the
model can call it on the next turn.

### Rules of thumb
- **Always go through `resolveSafe(rel)`** for any path argument so the tool
  can't touch files outside the project.
- **Cap output.** Models pay tokens for tool results — follow the existing
  `MAX_*` constants (truncate large output and say you truncated).
- **Return strings.** The result is fed back to the model as a `tool` message.
- **Use `needsConfirm: true`** for anything destructive or side-effectful, and
  read `ctx.confirm` in your handler (see how `run` does it). `ctx` carries
  `{ confirm, extraAllowlist }`.
- **Describe it well.** The `description` is the only thing the model uses to
  decide *when* to call your tool. Be specific and imperative.

---

## 2. Add or swap a model

Models are just Ollama tags. To make one selectable, add it to `core/models.js`:

```js
export const models = [
  { name: "qwen2.5-coder:7b", tagline: "balanced coding — best general-purpose default" },
  { name: "deepseek-coder:6.7b", tagline: "fast coding + debugging — leaner, snappier" },
  { name: "llama3.1:8b", tagline: "general reasoning, good tool use" },   // ← new
]
```

Then make sure it's pulled:

```bash
ollama pull llama3.1:8b
```

- Users select it with `/model llama3.1:8b` or `/model 3` (by list position).
- To change the **default**, edit `state.model` in `core/state.js`.
- Nothing else changes — `core/llm.js` always reads `state.model` and passes it
  to `ollama.chat`.

### Notes on model behavior
- **Tool calling quality varies.** Strong models use native `tool_calls`. Weaker
  ones sometimes emit a JSON tool call in the text body — `extractTextToolCalls`
  in `core/llm.js` catches that. If you add a model that does something *new and
  weird*, that function is where you'd teach the parser.
- **Context window.** Large `num_ctx` can OOM small models. Users can lower it
  with `NOBLE_NUM_CTX=4096`. The default is 8192 (`core/llm.js`).
- **File-edit reliability.** The three edit formats in `core/apply.js` exist
  precisely because different models format file blocks differently. If a model
  consistently fails to produce a parseable edit, either tune
  `BASE_SYSTEM_PROMPT` or add a parser branch (see recipe 5).

---

## 3. Add a slash command

Slash commands are handled inline in `prompt()` in `core/chat.js`. Two steps:

**a.** Add the name to `SLASH_COMMANDS` (near the top of `core/chat.js`) so TAB
completion knows about it:

```js
const SLASH_COMMANDS = [
  "/help", "/models", "/model", "/undo", "/clear",
  "/retry", "/copy", "/tokens", "/save", "/load", "/sessions",
  "/keytest", "/cwd",          // ← new
]
```

**b.** Handle it inside `prompt()`, alongside the other `if (input === ...)`
blocks. Always `return prompt()` to loop:

```js
if (input === "/cwd") {
  console.log(theme.primary("\nProject root: ") + theme.secondary(process.cwd()) + "\n")
  return prompt()
}
```

For a command with an argument, branch on a prefix like the existing `/model `
and `/save` handlers:

```js
if (input.startsWith("/echo ")) {
  const text = input.slice(6).trim()
  console.log(theme.secondary("\n" + text + "\n"))
  return prompt()
}
```

Don't forget to add a line to the `/help` output so it's discoverable.

---

## 4. Change what the model sees

Three independent levers:

### a. First-turn auto context — `core/context.js`
Adjust `getProjectContext`:
- Add file types in `EXTENSIONS`.
- Add always-include files to `PRIORITY_FILES` (they get a huge score boost).
- Tune `MAX_CONTEXT_CHARS` (total budget) or `TREE_LIMIT` (tree size).
- Change `scoreFile` to weight matches differently.

### b. Explicit `@references` — `core/references.js`
This is where `@file`, `@glob`, `@dir`, `@file:10-20`, and `@url` are resolved.
Add a new reference kind by extending `extractReferences` (detection) and
`buildReferenceContext` (how it's read into context). To change TAB completion,
edit `completeReference`.

### c. The system prompt — `core/llm.js`
`BASE_SYSTEM_PROMPT` defines the model's role, the tool-usage rules, and the
file-edit formats. `buildSystemPrompt` appends project rules from
`CLAUDE.md` / `NOBLE.md` / `AGENTS.md`. Edit the constant to change global
behavior; create one of those files to change behavior per project (no code
change needed).

---

## 5. Add a new file-edit format

If you want the model to be able to express edits a new way, **three places must
agree**:

1. **`core/apply.js`** — add a regex + branch in `parseEdits` that returns
   `{ path, content }`. (Optionally update `looksLikeMissedEdit`.)
2. **`core/render.js`** — add the block to `stripEditBlocks` (the
   `PREFERRED_BLOCK` / `MD_BLOCK` / `INLINE_BLOCK` regexes) so `renderAssistant`
   removes it from the prose, **and** teach the live `createStreamSanitizer` to
   suppress it as it streams (otherwise it shows twice — once live, once carded).
3. **`core/llm.js`** — document the new format in `BASE_SYSTEM_PROMPT` so the
   model actually produces it.

The existing parser already accepts three shapes (see
[modules.md](modules.md#applyjs)); a new one slots in the same way. Keep the
"full file contents, not diffs" rule — `applyEdits` writes the whole file.

---

## 6. Add tools via MCP (no code)

You can add tools without touching the codebase by configuring an MCP server.
Create `~/.noble/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "env": {}
    }
  }
}
```

On startup, `bin/noble.js` → `loadMCPServers` spawns each server, lists its
tools, and `registerMCPTools` exposes them to the model as
`mcp__filesystem__<toolname>`. See [configuration.md](configuration.md#mcp-servers).

---

## Testing your change

There's no test suite yet, so verify manually:

```bash
# Syntax check the files you edited
node --check core/tools.js core/chat.js

# Fast feedback loop — one-shot mode, no REPL
node bin/noble.js -p "list the files in core/ using your tools"

# Full REPL
node bin/noble.js
```

Checklist:
- [ ] `node --check` passes on every edited file.
- [ ] New tools confine paths via `resolveSafe` and cap their output.
- [ ] New slash commands are in `SLASH_COMMANDS`, handled in `prompt()`, and
      documented in `/help`.
- [ ] New models are pulled in Ollama (`ollama list`).
- [ ] Edit-format changes are mirrored across `apply.js`, `render.js`, and the
      system prompt in `llm.js`.
- [ ] Ollama is running (`ollama serve`) before you test a turn.
</content>
