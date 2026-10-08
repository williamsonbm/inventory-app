// new-item.js — story 4 (#81 part 3, group B): the item a person typed
// while counting or receiving that the catalog lacks, so the page can offer
// "Add 26′ of 2.1 RigidLam LVL 1-3/4 x 11-7/8" in one click and the new item
// joins the line being entered. Adding it is inv.add_item (/api/items/add),
// which checks the name again; this only decides what to offer.
//
// For a family whose names end in a length (inv.families.identity holds
// length_ft: lumber, LVL), a new length is offered only of an item the
// catalog already has, at another length, and spelled as the catalog spells
// it: a length is what goes missing (a leftover from a trim, a length not
// stocked before), and a typo in a product or grade would otherwise add a
// wrong item in one click. A new product, depth or grade is added from the
// Overview's "+ Add item". The names are built with itemLabel, the one
// naming rule, so this never parses a name format of its own. A SKU names no
// family, so a SKU is offered only for the family shown, never under All.
//
// Loaded by the Count and Receive pages as /new-item.js, and by Node for
// test/new-item.test.js.
(function (root) {
  // Capitals and spaces aside, as the database names items ("lus28" is
  // LUS28), and a typed ' or ’ is the foot mark ′ in "2x4 #2 16′".
  const plain = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').replace(/['’]/g, '′').toLowerCase();

  // The item `text` names that the catalog lacks, as { family, identity,
  // offer }, or null: for `family`, or under 'all' any family whose names end
  // in a length. Null too when `text` names an item the catalog has, by its
  // name or, as Receive offers it under All, "Family · name".
  function missingItem(families, items, family, text, itemLabel) {
    const typed = plain(text);
    const name = (f) => families.find((x) => x.code === f).name;
    if (!typed || items.some((i) => [itemLabel(i), name(i.family) + ' · ' + itemLabel(i)].map(plain).includes(typed))) return null;
    const shown = families.filter((f) => (family === 'all' ? f.identity?.includes('length_ft') : f.code === family));
    for (const f of shown) {
      if (f.identity?.includes('length_ft')) {
        const m = /^.+ (\d+) ?′?$/.exec(typed);
        const length = m && Number(m[1]);
        if (!length) continue;
        const kin = items.find((i) => i.family === f.code && plain(itemLabel({ ...i, length_ft: length })) === typed.replace(/ ?′?$/, '′'));
        if (!kin) continue;
        const identity = Object.fromEntries(f.identity.map((k) => [k, k === 'length_ft' ? length : kin[k]]));
        return { family: f.code, identity, offer: 'Add ' + length + '′ of ' + itemLabel(identity).slice(0, -` ${length}′`.length) };
      }
      if (family !== 'all' && f.identity?.join() === 'sku') {
        const sku = String(text).trim().replace(/\s+/g, ' ');
        return { family: f.code, identity: { sku }, offer: 'Add ' + sku + ' to ' + f.name };
      }
    }
    return null;
  }

  const api = { missingItem, plain };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NewItem = api;
})(typeof window !== 'undefined' ? window : globalThis);
