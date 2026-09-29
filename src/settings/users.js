// Settings → Users (#77): the user list, and the changes an admin makes to it.
//
// Every change differs only in DATA — which database function it calls and
// which fields of the request it passes — so the operation lives once in
// saveUserChange, and USER_CHANGES keys that data by the route's full literal
// path (CODING-STANDARDS.md, Seams and Readers). The database function checks
// the role, the version, the retry key and every rule again, and writes the
// activity-log row in the same save.
const { hashPassword, passwordProblem } = require('../auth/password.js');

// What the Users screen shows for each person. The version rides along so a
// save can say which version it read (S41).
async function listUsers(database) {
  return database.read(`
    SELECT id, email, name, active, admin, version, last_signed_in_at
      FROM inv.users ORDER BY active DESC, pg_catalog.lower(name), id`);
}

// Route → the database function it calls, and its arguments after the actor
// and the retry key. `password` is hashed here; the database never sees it.
const USER_CHANGES = {
  '/api/users/add': { fn: 'add_user', args: async (b) => [b.email, b.name, await hashPassword(b.password)], password: true },
  '/api/users/rename': { fn: 'rename_user', args: (b) => [b.id, b.version, b.name] },
  '/api/users/remove': { fn: 'remove_user', args: (b) => [b.id, b.version] },
  '/api/users/reactivate': { fn: 'reactivate_user', args: (b) => [b.id, b.version] },
  '/api/users/grant-admin': { fn: 'grant_admin', args: (b) => [b.id, b.version] },
  '/api/users/revoke-admin': { fn: 'revoke_admin', args: (b) => [b.id, b.version] },
  '/api/users/set-password': { fn: 'set_password', args: async (b) => [b.id, await hashPassword(b.password)], password: true },
};

// Runs one change for `actor`. Answers { error } for a password the rules
// refuse, else { user }, the person as the database left them. A refusal by
// the database is thrown, and the app's error shaping answers it.
async function saveUserChange(database, actor, route, body) {
  const { fn, args, password } = USER_CHANGES[route];
  if (password) {
    const problem = passwordProblem(body.password);
    if (problem) return { error: problem };
  }
  return { user: await database.save(fn, [actor.id, body.key, ...await args(body)]) };
}

module.exports = { listUsers, saveUserChange, USER_CHANGES };
