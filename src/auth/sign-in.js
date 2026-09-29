// Signing in, and loading the signed-in person on every request (#77).
const { hashPassword, checkPassword, passwordProblem } = require('./password.js');

// The person as the identity middleware sees them. password_changed_at is read
// as whole microseconds since 1970, as text, so the session cookie can carry
// it and compare it exactly (see src/auth/session.js). EXTRACT is SQL syntax
// that Postgres itself turns into pg_catalog.extract, so it needs no prefix,
// and it answers in exact numeric, where date_part's double would round.
const PERSON = `
  SELECT id, name, active, admin, password_temporary,
         (EXTRACT(epoch FROM password_changed_at) * 1000000)::bigint::text AS password_changed_at
    FROM inv.users`;

async function loadPerson(database, id) {
  const [row] = await database.read(`${PERSON} WHERE id = $1`, [id]);
  return row || null;
}

// For an address with no row, the typed password is still checked once,
// against this, so the answer takes the same time and does not tell a
// stranger who is on the list. Made on first use, not at load.
let decoy = null;

// The person if `email` and `password` sign them in, else null. The database
// decides the guessing limit and whether a removed person is refused
// (inv.record_sign_in); this counts the attempt there.
async function signIn(database, email, password) {
  // No stored password is longer than 200 characters, so a longer one is
  // refused unhashed: the cap limits the work one request can cause.
  if (typeof email !== 'string' || typeof password !== 'string' || password.length > 1000) return null;
  // Lower-cased by Postgres, as the stored address was. JavaScript's trim
  // removes every blank inv.tidy removes, the non-breaking space included.
  const [row] = await database.read(
    'SELECT id, password_hash FROM inv.users WHERE email = pg_catalog.lower($1)', [email.trim()]);
  decoy ||= hashPassword('no one has this password');
  const passwordOk = await checkPassword(password, row ? row.password_hash : await decoy);
  if (!row) return null;
  const allowed = await database.save('record_sign_in', [row.id, passwordOk]);
  return allowed ? loadPerson(database, row.id) : null;
}

// A person replaces their own password: a temporary one, or one they think
// someone saw. Answers { error } or { person }, the person as reloaded after
// the change, with the new password time the fresh cookie carries.
async function changePassword(database, person, { key, current, password }) {
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const [{ password_hash: stored }] = await database.read(
    'SELECT password_hash FROM inv.users WHERE id = $1', [person.id]);
  // A retry after a lost response arrives with the old password as "current",
  // and the new one already stored. It passes here, and the retry key makes
  // the database answer with the first call's outcome instead of changing
  // anything again.
  const ok = typeof current === 'string' && current.length <= 1000
    && (await checkPassword(current, stored) || await checkPassword(password, stored));
  // A wrong current password counts toward the same guessing limit as sign-in,
  // so a cookie left on a shared computer cannot be used to guess it.
  if (!await database.save('record_sign_in', [person.id, ok])) {
    return { error: 'The current password is wrong.' };
  }
  await database.save('change_password', [person.id, key, await hashPassword(password)]);
  return { person: await loadPerson(database, person.id) };
}

module.exports = { signIn, loadPerson, changePassword };
