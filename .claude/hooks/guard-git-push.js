#!/usr/bin/env node
// PreToolUse(Bash): deny force pushes anywhere, and any push that targets main/master.
// Rationale: inventory-app is a private repo on a Free plan, so GitHub Rulesets and branch
// protection are unavailable (403 "Upgrade to GitHub Pro..."). This hook is the ONLY
// enforcement of the PR workflow. It stops this agent; it cannot stop a human.
const { execSync } = require("child_process");

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const cmd = (JSON.parse(raw).tool_input || {}).command || "";
    if (!/(^|[^\w.-])git(\.exe)?\s+(-\S+\s+)*push(\s|$)/i.test(cmd)) return;

    // Isolate the push invocation's own arguments, stopping at any shell separator.
    const m = cmd.match(/git(?:\.exe)?\s+(?:-\S+\s+)*push\b(.*)/i);
    const tail = m ? m[1] : "";
    const stop = tail.search(/[;&|]/);
    const tokens = (stop === -1 ? tail : tail.slice(0, stop)).trim().split(/\s+/).filter(Boolean);
    const flags = tokens.filter((t) => t.startsWith("-"));
    const positional = tokens.filter((t) => !t.startsWith("-"));
    const refspecs = positional.slice(1); // drop the remote

    const forceFlag = flags.some((f) =>
      /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror)$/.test(f)
    );
    const forceRefspec = refspecs.some((r) => r.startsWith("+"));
    if (forceFlag || forceRefspec) return deny("force push");

    if (flags.some((f) => /^--(all|delete)$/.test(f))) return deny("--all / --delete push");

    let targetsMain = false;
    if (refspecs.length === 0) {
      try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
        targetsMain = branch === "main" || branch === "master";
      } catch {
        targetsMain = true; // cannot tell -> refuse
      }
    } else {
      targetsMain = refspecs.some((r) => {
        const dst = r.includes(":") ? r.split(":")[1] : r;
        return /(^|[/:])(main|master)$/.test(dst.replace(/^\+/, ""));
      });
    }
    if (targetsMain) return deny("direct push to main/master");
  } catch {}
});

function deny(what) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Blocked by project hook (.claude/hooks/guard-git-push.js): ${what} is disabled in ` +
          `inventory-app. Push a feature branch and open a PR, or hand the command to the user.`,
      },
    })
  );
}
