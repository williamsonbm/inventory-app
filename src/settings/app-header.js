// app-header.js — the header every signed-in page shares (#77): the theme
// switch, the signed-in person's name, and Sign out. Also `send`, the one way
// a page posts a change.
//
// Glue, NOT UNIT-TESTED: it needs a browser, and this repo has no DOM harness.
// The routes it calls are tested in test/sign-in.test.js and
// test/users.test.js; the header is checked by hand (#77, Testing Decisions).
//
// Expects #theme-btn, #user-name and #sign-out in the page. The theme itself
// is set before first paint by a small inline script in each page's <head>.
window.AppHeader = (() => {
  const el = (id) => document.getElementById(id);

  // ── Theme switch ───────────────────────────────────────────────────────────
  const root = document.documentElement;
  const themeBtn = el('theme-btn');
  const paintThemeBtn = () => { themeBtn.textContent = root.dataset.theme === 'dark' ? '☀' : '☾'; };
  paintThemeBtn();
  let themeChosen = false;
  themeBtn.addEventListener('click', () => {
    themeChosen = true;
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('app.theme', root.dataset.theme); } catch { /* storage blocked: this visit only */ }
    paintThemeBtn();
  });
  // Until the user picks a theme, follow the computer's setting as it changes.
  try { themeChosen = !!localStorage.getItem('app.theme'); } catch { /* storage blocked */ }
  const followComputer = (e) => {
    if (themeChosen) return;
    root.dataset.theme = e.matches ? 'dark' : 'light';
    paintThemeBtn();
  };
  const darkQuery = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  // addListener is the older name; Safari before 14 has only that one.
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', followComputer);
  else if (darkQuery && darkQuery.addListener) darkQuery.addListener(followComputer);

  // ── Who is signed in, and Sign out ─────────────────────────────────────────
  const me = fetch('/api/me').then((r) => r.json()).then((body) => {
    if (!body.ok) { location.assign('/sign-in'); return null; }
    el('user-name').textContent = body.user.name;
    return body.user;
  });
  el('sign-out').addEventListener('click', async () => {
    await fetch('/api/sign-out', { method: 'POST' }).catch(() => {});
    location.assign('/sign-in');
  });

  // Posts `body` to `route` and answers the parsed reply; throws an Error
  // carrying the reply's plain message. A reply that never arrives may still
  // have saved: the caller keeps the same body, retry key included, so
  // "Try again" acts once. `err.current` carries the row a stale save found.
  async function send(route, body) {
    let res;
    try {
      res = await fetch(route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch {
      throw Object.assign(new Error('The save was not confirmed. Check whether it happened before you try again.'), { unconfirmed: true });
    }
    const reply = await res.json().catch(() => ({ ok: false, error: 'The app gave an answer it could not read.' }));
    if (!reply.ok) throw Object.assign(new Error(reply.error), { current: reply.current, unconfirmed: res.status === 503 });
    return reply;
  }

  // A time as the office clock shows it: Eastern Time with daylight saving (Q17).
  const officeTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
  });
  const showTime = (iso) => (iso ? officeTime.format(new Date(iso)) : '—');

  return { me, send, showTime };
})();
