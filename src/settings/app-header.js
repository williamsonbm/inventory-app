// app-header.js — the header every signed-in page shares (#77): the theme
// switch, the signed-in person's name, and Sign out. Also `send`, the one way
// a page posts a change, `say`, its message area, `itemLabel`, and
// `familyBar`, the family filter the Planner and Inventory share.
//
// Glue, NOT UNIT-TESTED: it needs a browser, and this repo has no DOM harness.
// The routes it calls are tested in test/sign-in.test.js and
// test/users.test.js; the header is checked by hand (#77, Testing Decisions).
//
// Expects #theme-btn, #user-name and #sign-out in the page, #message
// where it calls `say`, and #family-filter where it calls `familyBar`. The theme itself
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
  // The server clears this computer's cookie even when it cannot record the
  // sign-out; then the person is told that other computers may still be
  // signed in, instead of being sent on as if all went well.
  // A request that never arrived cleared nothing, so that case stays here.
  el('sign-out').addEventListener('click', async () => {
    const res = await fetch('/api/sign-out', { method: 'POST' }).catch(() => null);
    if (!res) {
      window.alert('Sign out did not reach the app, so this computer is still signed in. Try again.');
      return;
    }
    // A 401 means this session had already ended (signed out in another tab,
    // or the person was removed): nothing is left to sign out, so no warning.
    const reply = await res.json().catch(() => ({ ok: false }));
    if (!reply.ok && res.status !== 401) {
      window.alert('This computer is signed out, but the app could not confirm it for your other computers. '
        + 'If you are signed in elsewhere, sign out there too, or ask an admin to set you a temporary password.');
    }
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
      // Same words as the app's 503 for an unconfirmed save (src/app.js, appError).
      throw Object.assign(new Error('The save was not confirmed. Check whether it happened before you try again.'), { unconfirmed: true });
    }
    const reply = await res.json().catch(() => ({ ok: false, error: 'The app gave an answer it could not read.' }));
    if (!reply.ok) throw Object.assign(new Error(reply.error), { current: reply.current, unconfirmed: res.status === 503 });
    return reply;
  }

  // Shows one message in #message, or clears it when `text` is empty. A save
  // that was not confirmed passes `retry`, which keeps its body, retry key
  // included, so "Try again" sends the very same request and acts once.
  function say(text, kind, retry) {
    const box = el('message');
    box.replaceChildren();
    if (!text) return;
    const note = document.createElement('div');
    note.className = 'note ' + (kind || '');
    note.textContent = text;
    if (retry) {
      const again = document.createElement('button');
      Object.assign(again, { type: 'button', className: 'ghost', textContent: 'Try again' });
      again.addEventListener('click', retry);
      note.append(' ', again);
    }
    box.append(note);
  }

  // An item as people name it: "LUS28", "2x4 #2 16′",
  // "2.1 RigidLam LVL 1-3/4 x 11-7/8 26′". The same words as inv.item_label.
  function itemLabel(i) {
    if (i.sku) return i.sku;
    if (i.product) return `${i.product} x ${i.size} ${i.length_ft}′`;
    return `${i.size} ${i.grade} ${i.length_ft}′`;
  }

  // A time as the office clock shows it: Eastern Time with daylight saving (Q17).
  // The same zone as OFFICE_TIME_ZONE in src/settings/activity.js, which picks the days.
  const officeTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
  });
  const showTime = (iso) => (iso ? officeTime.format(new Date(iso)) : '—');

  // The family bar under the modes, one for the Planner and Inventory so the
  // two match (owner, 2026-10-02): `families` ({ code, label }) in screen
  // order, then All at the far right (owner, 2026-09-25). `pick(code)` shows
  // a family, or 'all'. The choice is kept in this browser (spec #72) under
  // one app-wide key, so it follows the person from one mode to the other.
  // `first` is a family the address names, shown for this visit only.
  // Deliberately, only a click saves the choice, not opening the page: an
  // old family address arrives as /?family=<family>, and saving it on
  // arrival would let an old bookmark silently replace the saved choice,
  // so every later visit would open on that family with no hint why.
  const FAMILY_KEY = 'app.family';
  function familyBar(families, pick, first) {
    const bar = el('family-filter');
    const choices = families.concat({ code: 'all', label: 'All' });
    bar.replaceChildren(...choices.map(({ code, label }) => {
      const b = document.createElement('button');
      Object.assign(b, { type: 'button', textContent: label });
      b.dataset.family = code;
      return b;
    }));
    const show = (code) => {
      for (const b of bar.children) b.setAttribute('aria-pressed', String(b.dataset.family === code));
      pick(code);
    };
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-family]');
      if (!b) return;
      show(b.dataset.family);
      try { localStorage.setItem(FAMILY_KEY, b.dataset.family); } catch { /* storage blocked: this visit only */ }
    });
    let saved = null;
    try { saved = localStorage.getItem(FAMILY_KEY); } catch { /* storage blocked */ }
    show([first, saved].find((f) => choices.some((c) => c.code === f)) || 'all');
  }

  return { me, send, say, itemLabel, showTime, familyBar };
})();
