// The owner's command that switches a family live in Inventory (#81 story 99).
// Until a family is live, the database refuses its PO lines, and later its
// receipts and counts. Production stays off until the cutover; the Preview
// database is switched on for the office trial. There is no way back: the
// database offers no switch off.
//
// Run it over the direct connection (port 5432) with the owner's login, like
// the migrations; the app's login cannot run inv.set_family_live. The
// activity log names the admin given here as the one who switched it.
//
// Usage:
//   DIRECT_DATABASE_URL=postgres://... node src/db/switch-family-live.js <admin email> <family> [<family> ...]
// Families: lumber, plates, hangers, lvl. Each is its own save.
//
// Glue, NOT UNIT-TESTED: it passes its arguments to inv.set_family_live,
// which test/purchasing.test.js tests. The owner's first run on the Preview
// database checks the command (docs/runbook.md).
const { Client } = require('pg');

async function main() {
  const url = process.env.DIRECT_DATABASE_URL;
  const [email, ...families] = process.argv.slice(2);
  if (!url || !families.length) {
    throw new Error('Usage: DIRECT_DATABASE_URL=... node src/db/switch-family-live.js <admin email> <family> [<family> ...]');
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const family of families) {
      const { rows: [{ result }] } = await client.query('SELECT inv.set_family_live($1, $2) AS result', [email, family]);
      console.log(`${result.name} is live in Inventory.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
