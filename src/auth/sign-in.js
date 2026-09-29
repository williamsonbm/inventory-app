// Signing in, and loading the signed-in person on every request (#77).
const crypto = require('node:crypto');
const { hashPassword, checkPassword, passwordProblem, couldBePassword } = require('./password.js');

// The person as the identity middleware sees them. password_changed_at is read
// as whole microseconds since 1970, as text, so the session cookie can carry
// it and compare it exactly (see src/auth/session.js). EXTRACT is SQL syntax
// that Postgres itself turns into pg_catalog.extract, so it needs no prefix,
// and it answers in exact numeric, where date_part's double would round.
const PERSON_COLUMNS = `id, name, active, admin, password_temporary, sign_outs,
  (EXTRACT(epoch FROM password_changed_at) * 1000000)::bigint::text AS password_changed_at`;

async function loadPerson(database, id) {
  const [row] = await database.read(`SELECT ${PERSON_COLUMNS} FROM inv.users WHERE id = $1`, [id]);
  return row || null;
}

// For an address with no row, the typed password is still checked once,
// against this, so the answer takes the same time and does not tell a
// stranger who is on the list. A hash of a random password nobody kept,
// made at load with the current settings, so it costs what a real check costs.
const decoy = hashPassword(crypto.randomBytes(24).toString('base64'));

// The person if `email` and `password` sign them in, else null. The database
// decides the guessing limit and whether a removed person is refused
// (inv.record_password_check); this counts the attempt there. An address
// nobody has makes the same database call, for no row, so it takes the same
// time. A locked address still has its password checked, for the same reason:
// a departure, named, from #77's "without checking the password"; the answer
// is the same refusal either way.
async function signIn(database, email, password) {
  if (typeof email !== 'string' || !couldBePassword(password)) return null;
  // Trimmed and lower-cased by the same rule the stored address was.
  const [row] = await database.read(
    `SELECT ${PERSON_COLUMNS}, password_hash FROM inv.users WHERE email = pg_catalog.lower(inv.tidy($1))`,
    [email]);
  const passwordOk = await checkPassword(password, row ? row.password_hash : await decoy);
  const answer = await database.save('record_password_check', [row ? row.id : null, passwordOk, true]);
  if (!row || answer !== 'right') return null;
  const { password_hash: _, ...person } = row;
  return person;
}

// A person replaces their own password: a temporary one, or one they think
// someone saw. Answers { error } or { person }, the person as reloaded after
// the change, with the new password time the fresh cookie carries.
async function changePassword(database, person, { key, current, password }) {
  const problem = passwordProblem(password);
  if (problem) return { error: problem };
  const [{ password_hash: stored }] = await database.read(
    'SELECT password_hash FROM inv.users WHERE id = $1', [person.id]);
  // No retry path here: once a change saves, the cookie that sent it is out
  // of date, so a retry after a lost answer is refused as signed out before
  // it arrives. The page tells the person to sign in with the new password.
  const ok = couldBePassword(current) && await checkPassword(current, stored);
  // A wrong current password counts toward the same guessing limit as sign-in,
  // so a cookie left on a shared computer cannot be used to guess it; during a
  // lock even the right one is refused, for the same reason.
  const answer = await database.save('record_password_check', [person.id, ok, false]);
  if (answer === 'locked') {
    return { error: 'Too many wrong passwords. Try again in 15 minutes, or ask an admin for a temporary password.' };
  }
  if (answer !== 'right') return { error: 'The current password is wrong.' };
  await database.save('change_password', [person.id, key, await hashPassword(password)]);
  return { person: await loadPerson(database, person.id) };
}

module.exports = { signIn, loadPerson, changePassword };
