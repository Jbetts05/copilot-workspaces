# 🗂️ copilot-workspaces

> Group your **Copilot CLI sessions** into named workspaces — one per customer, project, or initiative — and resume any of them with a sentence.

`copilot-workspaces` is an [MCP](https://modelcontextprotocol.io) server that adds a small, focused set of natural-language tools to the [GitHub Copilot CLI](https://github.com/github/copilot-cli). It uses Copilot's own session store as a read-only source of truth and adds a tiny private SQLite database alongside it for your workspace mappings.

You speak. The agent picks the right tool. The result is a markdown table.

---

## 🎬 In action

<p align="center">
  <img src="assets/demo.svg" alt="copilot-workspaces in action — animated terminal demo" width="820"/>
</p>

You never type a tool name. You never remember a session ID. You describe what you want, and the agent picks the right tool.

---

## 🧠 Why this exists

Copilot CLI keeps an excellent session store — every conversation is durable, auto-titled, checkpointed, and resumable. But once you have **dozens** of sessions across **multiple customers**, finding "the JWT bug from Contoso last Tuesday" is a needle in a haystack.

This plugin adds a single missing concept — **workspaces** — and lets you reach for them conversationally from any session, in any repo, on any branch.

```
   ┌──────────────────────┐
   │  Copilot CLI session │
   │  (what you're in)    │
   └──────────┬───────────┘
              │
              │  "show me my Contoso workspace"
              ▼
   ┌──────────────────────┐
   │  copilot-workspaces  │  ← MCP server (this repo)
   │  • workspaces.db     │     ~\.copilot\workspaces.db
   │  • read session-store│     ~\.copilot\session-store.db (read-only)
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │  Markdown table back │
   │  to the chat         │
   └──────────────────────┘
```

---

## 🧰 Tools

All tools are invoked **for** you by the agent based on natural language. You don't need to memorise them — but here's the full surface area.

| Tool                  | Speak it like…                                              | What it does                                                                 |
|-----------------------|-------------------------------------------------------------|------------------------------------------------------------------------------|
| `workspaces_list`     | *"what workspaces do I have"*, *"list my workspaces"*        | Shows every workspace with session counts and last activity timestamp        |
| `workspaces_create`   | *"create a workspace for Contoso"*                          | Creates an empty workspace with the given name (free text, case-insensitive) |
| `workspaces_delete`   | *"delete the Contoso workspace"*                            | Removes the workspace itself; underlying sessions are untouched              |
| `workspaces_show`     | *"show me Contoso"*, *"what's in Northwind"*                | Markdown table of every session in a workspace                               |
| `workspaces_assign`   | *"add this session to Contoso"*, *"tag this as Northwind"*  | Adds the current (or a specific) session to a workspace                      |
| `workspaces_unassign` | *"remove session ab12cd3 from Contoso"*                     | Removes one session from a workspace; the workspace remains                  |
| `workspaces_resume`   | *"resume that one"*, *"open ab12cd3 from Contoso"*          | Returns the `/resume <id>` command to run                                    |
| `workspaces_prune`    | *"clean up Contoso"*, *"prune dead sessions"*               | Removes mappings whose underlying sessions no longer exist                   |

---

## 📐 Design choices worth knowing

- **Two databases, one purpose.** Reads come from Copilot's own `~/.copilot/session-store.db` (read-only, never modified). Writes go to a private `~/.copilot/workspaces.db` we own. If this plugin ever vanishes, your Copilot data is unaffected.
- **Names are free text.** `Contoso`, `Northwind Migration`, `internal/tooling`, `🎯 Q2 OKRs` — anything goes. Lookup is case-insensitive and Unicode-normalised.
- **One session, many workspaces.** A session that's both *Contoso* and *Auth bugs* lives in both — no duplication.
- **No name leakage in summaries.** Sessions without a generated title fall back to `(unnamed <short-id>)`, never to the user's first prompt (which could contain sensitive context).
- **Stale data shows up.** If a session you assigned has since been deleted from Copilot's store, it appears as `~~(unnamed)~~ *(missing)*` — `workspaces_prune` cleans these up on demand.
- **Resume is a command, not a context switch.** The MCP layer doesn't allow swapping the host process. So `workspaces_resume` returns the exact `/resume <id>` you can paste — one keystroke away.
- **Concurrency-safe.** Workspaces DB uses WAL mode + 5s busy timeout + foreign-key enforcement. Multiple Copilot sessions can read/write at the same time without corruption.

---

## 🚀 Install

### Prerequisites

| Requirement      | Version     | Why                                  |
|------------------|-------------|--------------------------------------|
| **Node.js**      | ≥ 22.0.0    | Built-in `node:sqlite`, no native deps to compile |
| **Copilot CLI**  | ≥ 1.0.36    | MCP plugin support                   |

### Steps

```powershell
# 1. Clone
git clone https://github.com/Jbetts05/copilot-workspaces.git $env:USERPROFILE\copilot-workspaces

# 2. Install the one dependency (the MCP SDK)
cd $env:USERPROFILE\copilot-workspaces
npm install

# 3. Wire it into your user-level Copilot MCP config
# ~/.copilot/mcp-config.json
```

`~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "copilot-workspaces": {
      "command": "node",
      "args": ["C:\\Users\\YOU\\copilot-workspaces\\server.mjs"],
      "tools": ["*"]
    }
  }
}
```

```powershell
# 4. Restart Copilot CLI (or run /mcp reload inside a session)
copilot mcp list   # should show "copilot-workspaces (local)"
```

You're done. Open any Copilot CLI session and try *"what workspaces do I have?"*.

> **macOS / Linux users:** swap `$env:USERPROFILE` for `$HOME` and use forward-slash paths in the config.

---

## 🧪 Verify it's working

From inside any Copilot session:

```text
You ▸ create a workspace called Smoke Test
🤖 ▸ ✅ Created workspace Smoke Test.

You ▸ add this session to Smoke Test
🤖 ▸ ✅ Assigned session <short-id> to Smoke Test.

You ▸ show me Smoke Test
🤖 ▸ <table with one row, your current session>

You ▸ delete the Smoke Test workspace
🤖 ▸ 🗑️ Deleted workspace Smoke Test. Sessions themselves are untouched.
```

---

## 🤝 Sharing & privacy

**The plugin is portable. Your data is not.**

- The MCP server itself is just one `server.mjs` and a single npm dep — clone it, install it, done.
- The workspaces DB lives at `~/.copilot/workspaces.db` on each machine. Installing this plugin on a teammate's laptop gives them the *capability*, not your customer list.
- Copilot's session-store is read-only from this plugin's perspective. Nothing about your existing sessions changes.

---

## 🔧 Configuration (optional)

There's nothing to configure. The defaults are:

| Path                           | Purpose                                  |
|--------------------------------|------------------------------------------|
| `~/.copilot/workspaces.db`     | Your private workspaces (writeable)      |
| `~/.copilot/session-store.db`  | Copilot's session history (read-only)    |

Both are auto-discovered relative to your home directory. If you've moved your Copilot config, set `COPILOT_DIR` in your shell — but you almost certainly don't need to.

---

## 🐛 Troubleshooting

<details>
<summary><strong>Tool calls fail with "Could not read host session-store.db"</strong></summary>

Your Copilot CLI version may not have created `~/.copilot/session-store.db` yet. Open Copilot CLI once, send any message, exit, and try again. The file is created on first use.

</details>

<details>
<summary><strong>"Host session-store.db is missing expected columns"</strong></summary>

Copilot CLI's session schema changed in a way this plugin doesn't yet handle. Open an issue with your Copilot CLI version (`copilot --version`) — schema-tolerance fixes are quick to ship.

</details>

<details>
<summary><strong>I see a yellow `ExperimentalWarning: SQLite is an experimental feature` line</strong></summary>

That's Node 22's built-in SQLite warning — it's harmless and emitted to stderr only. No action needed.

</details>

<details>
<summary><strong>The agent picks the wrong tool sometimes</strong></summary>

Be more explicit. *"remove a session from Contoso"* (unassign) vs *"delete the Contoso workspace"* (delete) are clearer than *"remove Contoso"*. The descriptions are tuned, but the agent occasionally needs a nudge.

</details>

---

## 📝 License

MIT — see [LICENSE](./LICENSE).

---

<p align="center"><sub>Built because <code>~/.copilot/session-store.db</code> deserves friends.</sub></p>
