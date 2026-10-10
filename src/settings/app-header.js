// app-header.js — the header every signed-in page shares (#77): the theme
// switch, the signed-in person's name, and Sign out. Also `send`, the one way
// a page posts a change, `getAll`, the way it reads its lists, `say`, its
// message area, `itemLabel`, `unitShort`,
// `inOrderUnit`,
// `familyBar`, the family filter the Planner and Inventory share, and
// `typingIn`, which keeps a box's typing through a repaint.
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

  // "Was this before or after the count?" (stories 77, 78): a receipt,
  // correction or trim saved soon after a count is refused with the counts
  // to pick from, oldest first (err.current.counts). Shows the question in
  // #message, one button per answer: before the first count, between each
  // two, after the last. `resend(timing)` saves the same entry again with
  // the answer. Cancel saves nothing and leaves the form as typed. With no
  // count left to ask about (one was rejected meanwhile), the one button
  // saves without an answer. Answers whether `err` was that refusal.
  function askTiming(err, resend) {
    const counts = err.current && err.current.counts;
    if (!Array.isArray(counts)) return false;
    say(err.message, 'bad');
    const note = el('message').firstChild;
    const count = (c) => 'the ' + c.family_name + ' count of ' + showTime(c.counted_at);
    const last = counts[counts.length - 1];
    const answers = !last ? [['Save', null]] : counts.map((c, n) =>
      [n ? 'Between ' + count(counts[n - 1]) + ' and ' + count(c) : 'Before ' + count(c), { before: c.id }])
      .concat([['After ' + count(last), { after: last.id }]]);
    const button = (label, className, onClick) => {
      const pick = document.createElement('button');
      Object.assign(pick, { type: 'button', className, textContent: label });
      pick.addEventListener('click', onClick);
      note.append(' ', pick);
    };
    for (const [label, timing] of answers) button(label, '', () => resend(timing));
    button('Cancel', 'ghost', () => say(''));
    return true;
  }

  // Reads every route a page lists from at once; null, with the reason said
  // in #message, if any fails.
  async function getAll(routes) {
    const fail = { ok: false, error: 'The page did not load. Reload it to try again.' };
    const bodies = await Promise.all(routes.map((route) => fetch(route).then((r) => r.json()).catch(() => fail)));
    const bad = bodies.find((b) => !b.ok);
    if (bad) { say(bad.error, 'bad'); return null; }
    return bodies;
  }

  // An item as people name it: "LUS28", "2x4 #2 16′",
  // "2.1 RigidLam LVL 1-3/4 x 11-7/8 26′". The same words as inv.item_label.
  function itemLabel(i) {
    if (i.sku) return i.sku;
    if (i.product) return `${i.product} x ${i.size} ${i.length_ft}′`;
    return `${i.size} ${i.grade} ${i.length_ft}′`;
  }

  // A family's order unit as a page writes it after an amount: linear feet
  // are "LF" (Q14); pieces stay "pieces". One rule for every page.
  function unitShort(orderUnit) {
    return orderUnit === 'linear feet' ? 'LF' : orderUnit;
  }

  // Pieces of an item as an amount in its family's order unit: 80 pieces of
  // 16′ lumber are 1,280 LF (Q14). The database counts a receipt against its
  // PO line the same way.
  function inOrderUnit(pieces, item, orderUnit) {
    return orderUnit === 'linear feet' ? pieces * item.length_ft : pieces;
  }

  // A time as the office clock shows it: Eastern Time with daylight saving (Q17).
  // The same zone as OFFICE_TIME_ZONE in src/settings/activity.js, which picks the days.
  const OFFICE_ZONE = 'America/New_York';
  const officeTime = new Intl.DateTimeFormat('en-US', { timeZone: OFFICE_ZONE, dateStyle: 'medium', timeStyle: 'short' });
  const showTime = (iso) => (iso ? officeTime.format(new Date(iso)) : '—');
  // The office date alone, for a column of dates: "Aug 1, 2026".
  const officeDate = new Intl.DateTimeFormat('en-US', { timeZone: OFFICE_ZONE, dateStyle: 'medium' });
  const showDate = (iso) => officeDate.format(new Date(iso));
  // The month a count closes, YYYY-MM, in words: "September 2026". The
  // Activity Log words it the same way on the server (src/settings/activity.js).
  const monthWords = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const monthName = (m) => monthWords.format(new Date(m + '-01T00:00:00Z'));
  // A count's kind as a title says it: "monthly count" or "spot check".
  const countKind = (kind) => (kind === 'monthly' ? 'monthly count' : 'spot check');
  // Today's office date as a date box writes it, YYYY-MM-DD.
  const officeDay = new Intl.DateTimeFormat('en-CA', { timeZone: OFFICE_ZONE });
  const today = () => officeDay.format(new Date());

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

  // A repaint rebuilds every row, so text a person is typing in one box while
  // another save comes back would be lost. typingIn(container), called before
  // the repaint, notes the focused box: its text, if not saved yet, and its
  // cursor. restore(), after the repaint, finds the same box (the same data-
  // attributes, in the row with the same data-id) and puts them back.
  function typingIn(container) {
    const box = document.activeElement;
    if (!box || box.tagName !== 'INPUT' || !container.contains(box)) return { restore() {} };
    const mark = (n) => JSON.stringify([{ ...n.dataset }, (n.closest('[data-id]') || { dataset: {} }).dataset.id]);
    const which = mark(box);
    const typed = box.value !== box.defaultValue ? box.value : null;
    let cursor = null;
    try { cursor = [box.selectionStart, box.selectionEnd]; } catch { /* a number box has no cursor position */ }
    return {
      restore() {
        const again = [...container.querySelectorAll('input')].find((n) => mark(n) === which);
        if (!again) return;
        if (typed !== null) again.value = typed;
        again.focus();
        try { if (cursor && cursor[0] !== null) again.setSelectionRange(cursor[0], cursor[1]); } catch { /* number box */ }
      },
    };
  }

  return { me, send, getAll, say, askTiming, itemLabel, unitShort, inOrderUnit, showTime, showDate, monthName, countKind, today, familyBar, typingIn };
})();
