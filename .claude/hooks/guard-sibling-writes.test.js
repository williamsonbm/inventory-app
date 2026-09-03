#!/usr/bin/env node
// Tests guard-sibling-writes.js by sending it real PreToolUse payloads and checking the verdict.
//
// This file executes NOTHING. Each command below is passed to the hook as JSON text on stdin.
// The hook reads it, matches strings, and prints an allow/deny verdict. No shell ever sees these
// strings, and the hook itself imports only `path` - it has no fs and no child_process.
//
// Run:  node .claude/hooks/guard-sibling-writes.test.js
// Run it after ANY change to the hook's MUTATORS pattern. An earlier candidate fix looked
// correct by eye and silently allowed two real writes to a sibling; this caught it.

const { execFileSync } = require("child_process");
const path = require("path");

const HOOK = path.join(__dirname, "guard-sibling-writes.js");

// Must match PROTECTED in the hook.
const SIB = "/workspace/materials-planner";
const SIB2 = "/workspace/hanger-web-app";

// [description, payload, mustDeny]
const CASES = [
  ["rm inside planner",        { tool_name: "Bash",  tool_input: { command: `rm -rf ${SIB}/src` } }, true],
  ["redirect into planner",    { tool_name: "Bash",  tool_input: { command: `echo x > ${SIB}/f.txt` } }, true],
  ["append into web app",      { tool_name: "Bash",  tool_input: { command: `echo x >> ${SIB2}/f.txt` } }, true],
  ["stderr INTO web app file", { tool_name: "Bash",  tool_input: { command: `node x.js 2> ${SIB2}/err.log` } }, true],
  ["fd1 INTO planner file",    { tool_name: "Bash",  tool_input: { command: `node x.js 1>${SIB}/out.log` } }, true],
  ["sed -i on web app",        { tool_name: "Bash",  tool_input: { command: `sed -i 's/a/b/' ${SIB2}/x.md` } }, true],
  ["git commit in planner",    { tool_name: "Bash",  tool_input: { command: `git -C ${SIB} commit -m x` } }, true],
  ["Write tool into web app",  { tool_name: "Write", tool_input: { file_path: `${SIB2}/x.md` } }, true],

  ["grep with 2>/dev/null",    { tool_name: "Bash",  tool_input: { command: `grep -rl 'x' ${SIB2} 2>/dev/null` } }, false],
  ["head with 2>&1",           { tool_name: "Bash",  tool_input: { command: `head -12 ${SIB2}/STATUS.md 2>&1` } }, false],
  ["ls with 2>/dev/null",      { tool_name: "Bash",  tool_input: { command: `ls -la ${SIB} 2>/dev/null` } }, false],
  ["plain cat",                { tool_name: "Bash",  tool_input: { command: `cat ${SIB}/README.md` } }, false],
  ["git status in web app",    { tool_name: "Bash",  tool_input: { command: `git -C ${SIB2} status --short` } }, false],
  ["find with 2>/dev/null",    { tool_name: "Bash",  tool_input: { command: `find ${SIB} -name '*.md' 2>/dev/null` } }, false],
  ["git log with 2>/dev/null", { tool_name: "Bash",  tool_input: { command: `git -C ${SIB} log --oneline 2>/dev/null` } }, false],
  ["stdout to /dev/null",      { tool_name: "Bash",  tool_input: { command: `grep -c x ${SIB}/README.md >/dev/null` } }, false],
];

let fails = 0;
for (const [desc, payload, mustDeny] of CASES) {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify(payload) }).toString();
  const denied = out.includes('"deny"');
  const ok = denied === mustDeny;
  if (!ok) fails++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  want=${(mustDeny ? "DENY" : "ALLOW").padEnd(5)}` +
      `  got=${(denied ? "DENY" : "ALLOW").padEnd(5)}  ${desc}`
  );
}
console.log(`\n${CASES.length - fails}/${CASES.length} passed`);
process.exit(fails ? 1 : 0);
