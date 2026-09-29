// The one-time setup (#77): the owner adds the first person, as an admin, so
// the app has someone who can sign in and reach Settings → Users. Run it once
// from the pod, over the direct connection with the owner's login, after the
// migrations:
//
//   DIRECT_DATABASE_URL=postgres://... node src/db/add-first-user.js
//
// It asks for the email address, the name and a temporary password, hashes
// the password here (the database never sees it), and calls
// inv.add_first_user, which refuses to run once anyone exists and logs the
// addition as that person's own. At their first sign-in they choose their own
// password.
//
// Glue, NOT UNIT-TESTED: the prompts need a terminal. inv.add_first_user is
// tested in test/database.test.js; the command is checked by the owner's
// first run (the runbook's step 5).
const readline = require('node:readline/promises');
const { Client } = require('pg');
const { hashPassword, passwordProblem } = require('../auth/password.js');

async function main() {
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) throw new Error('DIRECT_DATABASE_URL is not set (the direct connection, port 5432, owner login).');

  // Deliberately the line iterator, not rl.question: it keeps lines that
  // arrive before they are asked for. With rl.question, answers piped in all
  // at once were dropped and the command ended, exit 0, having added no one.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    if (done) throw new Error('Stopped: no answer was given, and no one was added.');
    return value;
  };
  const email = await ask('Email address: ');
  const name = await ask('Name: ');
  // The typed password is not echoed, so it stays out of the terminal's scrollback.
  rl._writeToOutput = () => {};
  const password = await ask('Temporary password (not shown): ');
  rl.close();
  process.stdout.write('\n');
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: [{ person }] } = await client.query(
      'SELECT inv.add_first_user($1, $2, $3) AS person', [email, name, await hashPassword(password)]);
    console.log(`Added ${person.name} <${person.email}> as an admin. They choose their own password at first sign-in.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
