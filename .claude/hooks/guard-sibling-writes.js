#!/usr/bin/env node
// PreToolUse(Edit|Write|NotebookEdit|Bash): this repo may READ its siblings but never change them.
//
// The merge effort depends on reading hanger-web-app and materials-planner, so reads stay open.
// Only mutation is blocked. Edit/Write/NotebookEdit are checked exactly, by resolved path.
// Bash is best-effort: a path plus a mutating token. An interpreter can always evade a string
// check (node -e, python3 -c), so treat this as defence in depth, not a guarantee.
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");          // /workspace/inventory-app
const PROTECTED = ["/workspace/hanger-web-app", "/workspace/materials-planner"];

const MUTATORS = /(^|[\s;&|(`])(rm|rmdir|mv|cp|dd|truncate|tee|touch|mkdir|chmod|chown|ln|unlink|shred)(\s|$)|>>?\s*(?!&)(?!\/dev\/null\b)|\bsed\s+[^|;]*-i\b|\bgit\s+(-C\s+\S+\s+)?(add|commit|checkout|switch|restore|reset|clean|rm|mv|apply|stash|merge|rebase|push|pull|fetch|init)\b|\bnpm\s+(i|install|ci|update|uninstall)\b/;

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(raw);
    const tool = j.tool_name || "";
    const ti = j.tool_input || {};

    // Exact check: a file-mutating tool aimed outside this repo.
    if (/^(Edit|Write|NotebookEdit)$/.test(tool)) {
      const target = ti.file_path || ti.notebook_path || ti.path;
      if (target) {
        const resolved = path.resolve(ROOT, target);
        const hit = PROTECTED.find((p) => resolved === p || resolved.startsWith(p + path.sep));
        if (hit) return deny(`${tool} targets ${hit}`);
        if (!resolved.startsWith(ROOT + path.sep) && !/^\/(tmp|var\/tmp)\//.test(resolved)) {
          return deny(`${tool} targets ${resolved}, outside this repo`);
        }
      }
      return;
    }

    // Best-effort check: a shell command naming a sibling alongside a mutating token.
    const cmd = ti.command || "";
    if (!cmd) return;
    const hit = PROTECTED.find((p) => cmd.includes(p) || cmd.includes(path.basename(p)));
    if (hit && MUTATORS.test(cmd)) return deny(`shell command appears to modify ${hit}`);
  } catch {}
});

function deny(what) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Blocked by project hook (.claude/hooks/guard-sibling-writes.js): ${what}. ` +
          `hanger-web-app and materials-planner are read-only from an inventory-app session. ` +
          `Reading and grepping them is fine; changing them is not. Ask the user to make the change.`,
      },
    })
  );
}
