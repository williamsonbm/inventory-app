// Settings → Activity log (#77): who did what and when, newest first, a page
// at a time. Filters by person, by date range and by action; the family
// filter joins in step 3.
//
// Dates are office days: a range from D1 to D2 covers midnight at the start
// of D1 to midnight at the end of D2, Eastern Time with daylight saving (Q17).
// Postgres converts the day's edges, and `at` stays timestamptz throughout, so
// the comparison never mixes a date with a time (CODING-STANDARDS.md, Drift).
//
// Deliberately, a date must be written YYYY-MM-DD, checked here: Postgres
// would also read "yesterday", and would read 06/07/2026 by the connection's
// DateStyle setting, which a shared pooler connection does not promise.
// A person or page of the wrong type is refused by Postgres (answered 400).
const PAGE_SIZE = 50;
const OFFICE_TIME_ZONE = 'America/New_York';  // the page shows times in the same zone (app-header.js)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Answers { error } for a date in any other form, else one page of entries.
async function readActivity(database, { person, action, from, to, before }) {
  const blank = (v) => (v === undefined || v === '' ? null : v);
  if ([from, to].some((d) => blank(d) !== null && !ISO_DATE.test(d))) {
    return { error: 'A date must be written like 2026-09-29.' };
  }
  // The list of actions (for the page's filter) does not depend on the
  // entries, so the two reads run side by side.
  const [rows, actionRows] = await Promise.all([database.read(`
    SELECT l.id, l.at, who.name AS who, l.action, target.name AS target,
           l.old_value AS was, l.new_value AS now
      FROM inv.activity_log l
      JOIN inv.users who ON who.id = l.actor_id
      LEFT JOIN inv.users target ON l.target_table = 'users' AND target.id = l.target_id
     WHERE ($1::bigint IS NULL OR l.actor_id = $1)
       AND ($2::text IS NULL OR l.action = $2)
       AND ($3::date IS NULL OR l.at >= ($3::date)::timestamp AT TIME ZONE $6)
       AND ($4::date IS NULL OR l.at < ($4::date + 1)::timestamp AT TIME ZONE $6)
       AND ($5::bigint IS NULL OR l.id < $5)
     ORDER BY l.id DESC
     LIMIT ${PAGE_SIZE + 1}`,
  [blank(person), blank(action), blank(from), blank(to), blank(before), OFFICE_TIME_ZONE]),
  database.read('SELECT name FROM inv.actions ORDER BY name')]);
  // One row past the page says whether there is another page, which starts
  // before the last row shown. The ids stay here: `before` is their one reader.
  const page = rows.slice(0, PAGE_SIZE);
  const nextBefore = rows.length > PAGE_SIZE ? page.at(-1).id : null;
  const actions = actionRows.map((r) => r.name);
  return { entries: page.map(({ id, ...entry }) => entry), before: nextBefore, actions };
}

module.exports = { readActivity };
