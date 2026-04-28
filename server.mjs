// copilot-workspaces-mcp
// MCP server that lets you group Copilot CLI sessions into named workspaces
// (typically one per customer/project) so you can browse and resume them later
// via natural-language chat in any Copilot CLI session.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------
const COPILOT_DIR = join(homedir(), ".copilot");
const WORKSPACES_DB_PATH = join(COPILOT_DIR, "workspaces.db");
const SESSION_STORE_DB_PATH = join(COPILOT_DIR, "session-store.db");
const SCHEMA_VERSION = 1;
const SHORT_ID_LEN = 7;

// ---------------------------------------------------------------------------
// Lazy DB connections (open on first use, reuse thereafter)
// ---------------------------------------------------------------------------
let _wsDb = null;
let _sessionDb = null;

function wsDb() {
    if (_wsDb) return _wsDb;
    const db = new DatabaseSync(WORKSPACES_DB_PATH);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS workspace_sessions (
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL,
            assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (workspace_id, session_id)
        );
    `);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    _wsDb = db;
    return db;
}

function sessionDb() {
    if (_sessionDb) return _sessionDb;
    // Open Copilot's session-store.db read-only. The host owns this file.
    const db = new DatabaseSync(SESSION_STORE_DB_PATH, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    _sessionDb = db;
    return db;
}

function verifyHostSchema() {
    try {
        const cols = sessionDb()
            .prepare("PRAGMA table_info(sessions)")
            .all()
            .map((r) => r.name);
        const required = ["id", "summary", "updated_at", "cwd"];
        const missing = required.filter((c) => !cols.includes(c));
        if (missing.length) {
            return `Host session-store.db is missing expected columns: ${missing.join(", ")}. The Copilot CLI schema may have changed.`;
        }
        return null;
    } catch (err) {
        return `Could not read host session-store.db: ${err.message}`;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normaliseName(raw) {
    if (typeof raw !== "string") return "";
    return raw.trim().normalize("NFC");
}

function shortId(id) {
    return id ? id.slice(0, SHORT_ID_LEN) : "";
}

function md(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function ok(text) {
    return { content: [{ type: "text", text }] };
}
function fail(text) {
    return { content: [{ type: "text", text }], isError: true };
}

function findWorkspace(name) {
    return wsDb()
        .prepare("SELECT id, name FROM workspaces WHERE name = ? COLLATE NOCASE")
        .get(name);
}

function resolveSessionId(ref) {
    if (!ref || typeof ref !== "string") return null;
    const r = ref.trim().toLowerCase();
    if (!/^[0-9a-f-]{4,}$/.test(r)) return null;

    const fromHost = sessionDb()
        .prepare("SELECT id FROM sessions WHERE id = ? OR id LIKE ? LIMIT 2")
        .all(r, r + "%");
    if (fromHost.length === 1) return fromHost[0].id;
    if (fromHost.length > 1) return { ambiguous: true };

    const fromMap = wsDb()
        .prepare(
            "SELECT DISTINCT session_id FROM workspace_sessions WHERE session_id = ? OR session_id LIKE ? LIMIT 2"
        )
        .all(r, r + "%");
    if (fromMap.length === 1) return fromMap[0].session_id;
    if (fromMap.length > 1) return { ambiguous: true };

    return null;
}

// "Current session" heuristic for MCP context (where we don't get an
// invocation.sessionId). Falls back to the most-recently-updated session.
function currentSessionGuess() {
    const row = sessionDb()
        .prepare("SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1")
        .get();
    return row?.id || null;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
async function tool_list() {
    const schemaErr = verifyHostSchema();
    if (schemaErr) return fail(schemaErr);

    const rows = wsDb()
        .prepare(
            `SELECT w.name,
                    COUNT(ws.session_id) AS session_count
             FROM workspaces w
             LEFT JOIN workspace_sessions ws ON ws.workspace_id = w.id
             GROUP BY w.id
             ORDER BY w.name COLLATE NOCASE`
        )
        .all();

    if (rows.length === 0) {
        return ok(
            "No workspaces yet. Create one by saying e.g. *create a workspace for Contoso*."
        );
    }

    const sessIds = wsDb()
        .prepare(
            `SELECT w.name, ws.session_id
             FROM workspaces w
             JOIN workspace_sessions ws ON ws.workspace_id = w.id`
        )
        .all();
    const lastByWs = new Map();
    if (sessIds.length) {
        const idList = [...new Set(sessIds.map((r) => r.session_id))];
        const placeholders = idList.map(() => "?").join(",");
        const acts = sessionDb()
            .prepare(`SELECT id, updated_at FROM sessions WHERE id IN (${placeholders})`)
            .all(...idList);
        const actMap = new Map(acts.map((a) => [a.id, a.updated_at]));
        for (const r of sessIds) {
            const t = actMap.get(r.session_id);
            if (!t) continue;
            const cur = lastByWs.get(r.name);
            if (!cur || t > cur) lastByWs.set(r.name, t);
        }
    }

    let out = "| Workspace | Sessions | Last activity |\n|---|---|---|\n";
    for (const r of rows) {
        out += `| ${md(r.name)} | ${r.session_count} | ${md(lastByWs.get(r.name) ?? "—")} |\n`;
    }
    return ok(out);
}

async function tool_create({ name }) {
    const n = normaliseName(name);
    if (!n) return fail("Workspace name is required.");
    try {
        wsDb().prepare("INSERT INTO workspaces (name) VALUES (?)").run(n);
        return ok(`✅ Created workspace **${n}**.`);
    } catch (err) {
        if (String(err.message).includes("UNIQUE")) {
            return fail(`Workspace **${n}** already exists.`);
        }
        throw err;
    }
}

async function tool_delete({ name }) {
    const n = normaliseName(name);
    if (!n) return fail("Workspace name is required.");
    const ws = findWorkspace(n);
    if (!ws) return fail(`No workspace called **${n}**.`);
    wsDb().prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
    return ok(`🗑️ Deleted workspace **${ws.name}**. Sessions themselves are untouched.`);
}

async function tool_show({ name }) {
    const schemaErr = verifyHostSchema();
    if (schemaErr) return fail(schemaErr);

    const n = normaliseName(name);
    if (!n) return fail("Workspace name is required.");
    const ws = findWorkspace(n);
    if (!ws) return fail(`No workspace called **${n}**.`);

    const mappings = wsDb()
        .prepare(
            "SELECT session_id, assigned_at FROM workspace_sessions WHERE workspace_id = ?"
        )
        .all(ws.id);

    if (mappings.length === 0) {
        return ok(
            `Workspace **${ws.name}** is empty. Assign the current session by saying *add this session to ${ws.name}*.`
        );
    }

    const ids = mappings.map((m) => m.session_id);
    const placeholders = ids.map(() => "?").join(",");
    const sessions = sessionDb()
        .prepare(
            `SELECT id, summary, updated_at, cwd FROM sessions WHERE id IN (${placeholders})`
        )
        .all(...ids);
    const sessMap = new Map(sessions.map((s) => [s.id, s]));

    const checkpoints = sessionDb()
        .prepare(
            `SELECT session_id, title
             FROM checkpoints
             WHERE session_id IN (${placeholders})
               AND checkpoint_number = (
                   SELECT MAX(checkpoint_number)
                   FROM checkpoints c2
                   WHERE c2.session_id = checkpoints.session_id
               )`
        )
        .all(...ids);
    const cpMap = new Map(checkpoints.map((c) => [c.session_id, c.title]));

    const rows = mappings
        .map((m) => {
            const s = sessMap.get(m.session_id);
            return {
                session_id: m.session_id,
                short: shortId(m.session_id),
                name: s?.summary || `(unnamed ${shortId(m.session_id)})`,
                updated_at: s?.updated_at || null,
                cwd: s?.cwd || "",
                checkpoint: cpMap.get(m.session_id) || "—",
                missing: !s,
                assigned_at: m.assigned_at,
            };
        })
        .sort((a, b) => {
            if (a.missing !== b.missing) return a.missing ? 1 : -1;
            return (b.updated_at || "").localeCompare(a.updated_at || "");
        });

    let out = `**${ws.name}** — ${rows.length} session${rows.length === 1 ? "" : "s"}\n\n`;
    out += "| Short ID | Name | Last active | Latest checkpoint | cwd |\n|---|---|---|---|---|\n";
    for (const r of rows) {
        const nameCell = r.missing ? `~~${md(r.name)}~~ *(missing)*` : md(r.name);
        out += `| \`${r.short}\` | ${nameCell} | ${md(r.updated_at ?? "—")} | ${md(r.checkpoint)} | ${md(r.cwd)} |\n`;
    }
    out += `\nTo resume one, say *resume <short-id> from ${ws.name}*.`;
    return ok(out);
}

async function tool_assign({ name, sessionId }) {
    const n = normaliseName(name);
    if (!n) return fail("Workspace name is required.");
    const ws = findWorkspace(n);
    if (!ws) return fail(`No workspace called **${n}**. Create it first.`);

    let sid;
    if (sessionId) {
        const resolved = resolveSessionId(sessionId);
        if (resolved && typeof resolved === "object" && resolved.ambiguous) {
            return fail(`Session ID \`${sessionId}\` is ambiguous — please use more characters.`);
        }
        if (!resolved) return fail(`No session matches \`${sessionId}\`.`);
        sid = resolved;
    } else {
        sid = currentSessionGuess();
        if (!sid)
            return fail(
                "Could not determine the current session. Pass `sessionId` explicitly."
            );
    }

    wsDb()
        .prepare(
            "INSERT OR IGNORE INTO workspace_sessions (workspace_id, session_id) VALUES (?, ?)"
        )
        .run(ws.id, sid);
    return ok(`✅ Assigned session \`${shortId(sid)}\` to **${ws.name}**.`);
}

async function tool_unassign({ name, sessionId }) {
    const n = normaliseName(name);
    if (!n) return fail("Workspace name is required.");
    if (!sessionId) return fail("`sessionId` is required.");
    const ws = findWorkspace(n);
    if (!ws) return fail(`No workspace called **${n}**.`);

    const resolved = resolveSessionId(sessionId);
    if (resolved && typeof resolved === "object" && resolved.ambiguous) {
        return fail(`Session ID \`${sessionId}\` is ambiguous — please use more characters.`);
    }
    if (!resolved) return fail(`No session matches \`${sessionId}\`.`);

    const result = wsDb()
        .prepare("DELETE FROM workspace_sessions WHERE workspace_id = ? AND session_id = ?")
        .run(ws.id, resolved);
    if (result.changes === 0)
        return fail(`Session \`${shortId(resolved)}\` was not in **${ws.name}**.`);
    return ok(`🗑️ Removed \`${shortId(resolved)}\` from **${ws.name}**.`);
}

async function tool_resume({ name, sessionId }) {
    const n = normaliseName(name);
    if (!n) return fail("Workspace name is required.");
    if (!sessionId) return fail("`sessionId` is required (use the short ID from workspaces_show).");
    const ws = findWorkspace(n);
    if (!ws) return fail(`No workspace called **${n}**.`);

    const resolved = resolveSessionId(sessionId);
    if (resolved && typeof resolved === "object" && resolved.ambiguous) {
        return fail(`Session ID \`${sessionId}\` is ambiguous — please use more characters.`);
    }
    if (!resolved) return fail(`No session matches \`${sessionId}\`.`);

    const inWs = wsDb()
        .prepare(
            "SELECT 1 FROM workspace_sessions WHERE workspace_id = ? AND session_id = ?"
        )
        .get(ws.id, resolved);
    if (!inWs)
        return fail(`Session \`${shortId(resolved)}\` is not in **${ws.name}**.`);

    return ok(
        [
            `To resume session \`${shortId(resolved)}\` from **${ws.name}**, run:`,
            "",
            "```",
            `/resume ${resolved}`,
            "```",
            "",
            "Or from a fresh shell:",
            "",
            "```",
            `copilot --resume=${resolved}`,
            "```",
        ].join("\n")
    );
}

async function tool_prune({ name }) {
    const schemaErr = verifyHostSchema();
    if (schemaErr) return fail(schemaErr);

    const n = name ? normaliseName(name) : null;
    let scope, ws = null;
    if (n) {
        ws = findWorkspace(n);
        if (!ws) return fail(`No workspace called **${n}**.`);
        scope = `in **${ws.name}**`;
    } else {
        scope = "across all workspaces";
    }

    const mappings = ws
        ? wsDb()
              .prepare(
                  "SELECT workspace_id, session_id FROM workspace_sessions WHERE workspace_id = ?"
              )
              .all(ws.id)
        : wsDb().prepare("SELECT workspace_id, session_id FROM workspace_sessions").all();

    if (mappings.length === 0) return ok(`Nothing to prune ${scope}.`);

    const ids = [...new Set(mappings.map((m) => m.session_id))];
    const placeholders = ids.map(() => "?").join(",");
    const live = new Set(
        sessionDb()
            .prepare(`SELECT id FROM sessions WHERE id IN (${placeholders})`)
            .all(...ids)
            .map((r) => r.id)
    );
    const dead = mappings.filter((m) => !live.has(m.session_id));
    if (dead.length === 0) return ok(`No stale mappings ${scope}.`);

    const del = wsDb().prepare(
        "DELETE FROM workspace_sessions WHERE workspace_id = ? AND session_id = ?"
    );
    wsDb().prepare("BEGIN").run();
    try {
        for (const d of dead) del.run(d.workspace_id, d.session_id);
        wsDb().prepare("COMMIT").run();
    } catch (err) {
        wsDb().prepare("ROLLBACK").run();
        throw err;
    }
    return ok(`🧹 Pruned ${dead.length} stale mapping(s) ${scope}.`);
}

// ---------------------------------------------------------------------------
// Wire up the MCP server
// ---------------------------------------------------------------------------
const server = new McpServer({
    name: "copilot-workspaces",
    version: "0.1.0",
});

server.tool(
    "workspaces_list",
    "List all Copilot workspaces with session counts and last activity. Use when the user asks to see, list, or browse their workspaces (e.g. 'what workspaces do I have', 'show my workspaces').",
    {},
    tool_list
);

server.tool(
    "workspaces_create",
    "Create a new empty workspace by name. Use when the user asks to create, add, or make a new workspace (e.g. 'create a workspace for Contoso').",
    { name: z.string().describe("Workspace name (free text, e.g. 'Contoso').") },
    tool_create
);

server.tool(
    "workspaces_delete",
    "Delete an entire workspace. Removes the workspace and all its session mappings (the underlying Copilot sessions are NOT deleted). Use ONLY when the user asks to delete or remove the workspace itself, NOT when they ask to remove a single session from a workspace (use workspaces_unassign for that).",
    { name: z.string().describe("Workspace name.") },
    tool_delete
);

server.tool(
    "workspaces_show",
    "Show all sessions assigned to a specific workspace as a markdown table (short ID, name, last active, latest checkpoint, cwd). Use when the user asks to see, view, open, or look at a specific workspace by name (e.g. 'show me Contoso', 'what's in my Northwind workspace').",
    { name: z.string().describe("Workspace name.") },
    tool_show
);

server.tool(
    "workspaces_assign",
    "Assign a session to a workspace. If sessionId is omitted, assigns the most-recently-active session (treated as the 'current' session). Use when the user asks to add, assign, tag, or attach a session to a workspace (e.g. 'add this session to Contoso', 'tag this as Northwind').",
    {
        name: z.string().describe("Workspace name."),
        sessionId: z
            .string()
            .optional()
            .describe(
                "Optional. Full or short (7+ char) session ID. Omit to assign the current (most-recently-active) session."
            ),
    },
    tool_assign
);

server.tool(
    "workspaces_unassign",
    "Remove a single session from a workspace (the workspace itself is preserved). Use when the user asks to remove, detach, or unassign a session from a workspace. Do NOT use this to delete the workspace itself (use workspaces_delete).",
    {
        name: z.string().describe("Workspace name."),
        sessionId: z.string().describe("Full or short (7+ char) session ID to remove."),
    },
    tool_unassign
);

server.tool(
    "workspaces_resume",
    "Get the command to resume a specific session from a workspace. Returns a /resume command for the user to run. Use when the user asks to resume, continue, reopen, switch to, or pick up a session from a workspace (e.g. 'resume that one', 'open session abc1234 from Contoso').",
    {
        name: z.string().describe("Workspace name."),
        sessionId: z
            .string()
            .describe("Full or short (7+ char) session ID, as shown by workspaces_show."),
    },
    tool_resume
);

server.tool(
    "workspaces_prune",
    "Remove mappings for sessions that no longer exist in Copilot's session store. Use when the user asks to clean up, prune, or tidy a workspace. If no name is given, prunes all workspaces.",
    {
        name: z.string().optional().describe("Optional workspace name. Omit to prune everywhere."),
    },
    tool_prune
);

const transport = new StdioServerTransport();
await server.connect(transport);
