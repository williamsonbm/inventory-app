#!/usr/bin/env node
// PreToolUse(Read|Grep|Glob|Bash|Edit|Write): keep secret material out of the transcript.
//
// Anything this agent reads is written to the session transcript on disk, so a leaked .env
// outlives the session. Blocked: .env files, the /keys deploy-key mount, and private-key
// material. As SKILLS-ACCESS-ISSUE.md concluded, a string check over arbitrary shell commands
// can never be complete -- an interpreter can read a file without naming it recognisably.
// This raises the floor; it is not a guarantee.
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SECRET_DIRS = ["/keys"];
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.git-credentials|\.credentials\.json|id_rsa|id_ed25519|id_ecdsa|.*\.pem|.*\.p12|.*\.pfx)$/i;
const SECRET_TOKEN = /(\.env\b|\.env\.|\/keys\/|\bid_rsa\b|\bid_ed25519\b|\.git-credentials\b|\.pem\b|_deploy\b)/i;

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(raw);
    const ti = j.tool_input || {};

    for (const candidate of [ti.file_path, ti.path, ti.notebook_path].filter(Boolean)) {
      const resolved = path.resolve(ROOT, candidate);
      if (SECRET_DIRS.some((d) => resolved === d || resolved.startsWith(d + path.sep))) {
        return deny(`${resolved} is deploy-key material`);
      }
      if (SECRET_FILE.test(resolved)) return deny(`${resolved} holds secrets`);
    }

    // Glob/Grep patterns and shell commands are matched as text.
    for (const text of [ti.pattern, ti.glob, ti.command].filter(Boolean)) {
      if (SECRET_TOKEN.test(text)) return deny("the request names secret material");
    }
  } catch {}
});

function deny(what) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Blocked by project hook (.claude/hooks/guard-secrets.js): ${what}. ` +
          `Secrets must not enter the session transcript. If a value is genuinely needed, ` +
          `ask the user to supply or verify it themselves.`,
      },
    })
  );
}
