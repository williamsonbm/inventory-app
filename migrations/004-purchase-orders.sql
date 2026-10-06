-- Step 3, part 2 (#81): POs and receiving. All of part 2 goes in this one
-- file, built over several sessions and applied once part 2 is complete
-- (owner, 2026-10-03). It holds POs, the Incoming figure, and the switch
-- that makes a family live in Inventory. Two changes reach every table:
-- inv.finish_action refuses a save that changes nothing, and inv.check_lengths
-- limits every text a person types.
-- Source: docs/database-design.md, "Step 3 — inventory", tables 3, 8 and 9,
-- and "How the numbers are calculated"; #81, "Live in Inventory".
-- Follows migration 001: every change starts with inv.claim_action and ends
-- with inv.finish_action. Each change the app makes is a SECURITY DEFINER
-- function; the owner's command inv.set_family_live is not, because only the
-- owner's login runs it (as 003's inv.import_catalog). Every name is fully
-- qualified; every refusal carries an IV code (listed in 001).

-- Whether a family is live in Inventory (#81, "Live in Inventory: the
-- cutover switch"). Off for every family: the database refuses every PO line
-- for a family that is off, and later ledger entries and counts too, so
-- nothing lands in Production before the cutover. Only the owner's command
-- (src/db/switch-family-live.js) switches a family on, and nothing switches
-- one off: that would strand its records.
ALTER TABLE inv.families ADD COLUMN live boolean NOT NULL DEFAULT false;

-- What a family's PO line is ordered in (Q14): lumber in linear feet, every
-- other family in pieces.
ALTER TABLE inv.families ADD COLUMN order_unit text NOT NULL DEFAULT 'pieces'
  CHECK (order_unit IN ('pieces', 'linear feet'));
UPDATE inv.families SET order_unit = 'linear feet' WHERE code = 'lumber';
ALTER TABLE inv.families ALTER COLUMN order_unit DROP DEFAULT;

-- Whether a family's material comes back from a job site (design Q11):
-- hangers, LVL and EWP do; plates and lumber are used up. Until step 4 adds
-- the return entry, a return is a correction "Returned from job site" (Q7),
-- and inv.correct refuses it for a family that is not returnable.
ALTER TABLE inv.families ADD COLUMN returnable boolean NOT NULL DEFAULT false;
UPDATE inv.families SET returnable = true WHERE code IN ('hangers', 'lvl', 'ewp');

-- Whether a family's weathered boards are trimmed to a shorter length (design
-- Q26): LVL now; EWP joins at step 5, once its items have names.
ALTER TABLE inv.families ADD COLUMN trimmable boolean NOT NULL DEFAULT false;
UPDATE inv.families SET trimmable = true WHERE code = 'lvl';

-- The one entry a reason is kept for, or none when any entry may use it
-- (owner, Q31): a trim writes "Weathered – trimmed" itself (story 47), and
-- only part 4's import writes "Opening balance (web app)". inv.checked_reason
-- refuses such a reason anywhere else, and the pages leave it off their lists.
ALTER TABLE inv.reasons ADD COLUMN entry text CHECK (entry IN ('trim', 'import'));
UPDATE inv.reasons SET entry = 'trim' WHERE built_in AND text = 'Weathered – trimmed';
UPDATE inv.reasons SET entry = 'import' WHERE built_in AND text = 'Opening balance (web app)';

-- 003's inv.reason_json, with the entry, so a saved reason has the shape
-- the reasons list has.
CREATE OR REPLACE FUNCTION inv.reason_json(r inv.reasons) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', r.id, 'text', r.text, 'active', r.active, 'built_in', r.built_in, 'entry', r.entry, 'version', r.version)
$$;

-- A PO as entered when the office orders (S12). Who entered it and when come
-- from its activity-log row (target purchase_orders, target_id its id).
CREATE TABLE inv.purchase_orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_id bigint NOT NULL REFERENCES inv.suppliers (id),
  number      text NOT NULL CHECK (number = inv.tidy(number) AND number <> ''),
  po_date     date NOT NULL,
  -- One version for the PO and its lines (S41), moved on by inv.po_at_version.
  -- Deliberately not a bump_version trigger per table, as on the catalog: a
  -- line is changed only with its PO, and one save must move the version
  -- once whether it changed the header, a line or both. Per-table triggers
  -- would give each line its own version, and an edit would send one per line.
  version     integer NOT NULL DEFAULT 1
);

-- One supplier's PO number is entered once, whatever the capitals, so a PO
-- typed in twice cannot count its material as incoming twice.
CREATE UNIQUE INDEX purchase_orders_number_key ON inv.purchase_orders (supplier_id, pg_catalog.lower(number));

-- What a PO orders: one row per line. ordered is in the family's order unit
-- (inv.families.order_unit): linear feet for lumber, pieces otherwise.
-- pack_size is the line's own copy of the pieces in one pack, if the PO
-- names one (Q13, Q14), so correcting a pack size changes no line.
-- A line is never deleted. One not wanted any more, or not delivered, is
-- closed with a reason (S15, story 39): closed_reason_id is set while it is
-- closed, so a closed line always has its reason. Re-opening clears it.
CREATE TABLE inv.po_lines (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id            bigint NOT NULL REFERENCES inv.purchase_orders (id),
  item_id          bigint NOT NULL REFERENCES inv.items (id),
  ordered          integer NOT NULL CHECK (ordered > 0),
  pack_size        integer CHECK (pack_size > 0),
  closed_reason_id bigint REFERENCES inv.reasons (id),
  UNIQUE (id, item_id)  -- for inv.ledger's foreign key
);

CREATE INDEX po_lines_po_idx ON inv.po_lines (po_id);
CREATE INDEX po_lines_item_idx ON inv.po_lines (item_id);

-- A row's item belongs to a live family, whatever writes the row, refused
-- with the words a person sees (story 57). A trigger, not a CHECK, because
-- the flag is in another table. Switching a family off is not offered, so a
-- row that passed stays true. An item that does not exist is left to the
-- foreign key.
CREATE FUNCTION inv.check_item_family_live() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f inv.families;
BEGIN
  SELECT fam.* INTO f FROM inv.items i JOIN inv.families fam ON fam.code = i.family WHERE i.id = NEW.item_id;
  IF FOUND AND NOT f.live THEN
    RAISE EXCEPTION 'The % family is not live in Inventory yet, so it takes no POs, receipts, corrections or counts.', f.name
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_family_live BEFORE INSERT OR UPDATE OF item_id ON inv.po_lines
  FOR EACH ROW EXECUTE FUNCTION inv.check_item_family_live();

-- A PO holds one family: the office never buys two families on one PO
-- (owner, Q67–68). Refuses item i on PO p_po_id when one of its lines is of
-- another family, naming line n, or the line p_line_id's number when n is
-- blank (worked out only to refuse). Closed lines count too, so the
-- Activity Log shows a PO under one family. A PO entered for the wrong
-- family is closed and entered again; a one-line PO may change its item's
-- family. No PO, no lines: nothing is refused.
CREATE FUNCTION inv.check_po_family(i inv.items, p_po_id bigint, n integer, p_line_id bigint) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  other text;
BEGIN
  SELECT f.name INTO other FROM inv.po_lines l JOIN inv.items x ON x.id = l.item_id JOIN inv.families f ON f.code = x.family
   WHERE l.po_id = p_po_id AND x.family <> i.family
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Line %: % is %, but this PO orders %. A PO holds one family.',
      coalesce(n, inv.po_line_number(p_line_id)), inv.item_label(i),
      (SELECT name FROM inv.families WHERE code = i.family), other USING ERRCODE = 'IV422';
  END IF;
END
$$;

-- The same, whatever writes a PO line. After the row is written, so its
-- number counts it.
CREATE FUNCTION inv.check_po_one_family() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM inv.check_po_family(i, NEW.po_id, NULL, NEW.id) FROM inv.items i WHERE i.id = NEW.item_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER check_one_family AFTER INSERT OR UPDATE OF item_id ON inv.po_lines
  FOR EACH ROW EXECUTE FUNCTION inv.check_po_one_family();

-- A delivery as entered from its Bill of Lading (S13, S16): against a PO, or
-- from a supplier without one, never both. Its lines are ledger rows. Who
-- received it and when come from its activity-log row (target receipts).
CREATE TABLE inv.receipts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id       bigint REFERENCES inv.purchase_orders (id),
  supplier_id bigint REFERENCES inv.suppliers (id),  -- without a PO; with one, the PO's supplier
  bol         text CHECK (bol = inv.tidy(bol) AND bol <> ''),  -- Bill of Lading or tracking number (story 37)
  CHECK ((po_id IS NULL) <> (supplier_id IS NULL))
);

-- One row per change in quantity, in pieces (design table 11). Never updated
-- or deleted: a mistake is undone by a reversal, a row of its own that
-- mirrors the row it reverses (reverses_id), once. A reversal of a receipt
-- line keeps its PO line, so what arrived on that line drops and its
-- incoming comes back (story 43). A receipt line keeps the
-- delivery as entered, packs × pack size + loose, which adds up to its
-- quantity, and its own copy of the pack size and its kind (Q13, story 19).
-- A line on a PO line has that line's item, by the foreign key (story 36),
-- which also keeps the item of a PO line with receipts (PO edit rule 4).
CREATE TABLE inv.ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id      bigint NOT NULL REFERENCES inv.items (id),
  quantity     integer NOT NULL CHECK (quantity <> 0),
  kind         text NOT NULL CHECK (kind IN ('receipt', 'correction', 'reversal')),
  effective_at timestamptz NOT NULL,
  action_id    bigint NOT NULL REFERENCES inv.activity_log (id),
  receipt_id   bigint REFERENCES inv.receipts (id),
  po_line_id   bigint,
  packs        integer CHECK (packs >= 0),
  pack_size    integer CHECK (pack_size > 0),
  pack_kind    text,
  loose        integer CHECK (loose >= 0),
  reason_id    bigint REFERENCES inv.reasons (id),
  note         text CHECK (note = inv.tidy(note) AND note <> ''),
  reverses_id  bigint UNIQUE REFERENCES inv.ledger (id),
  FOREIGN KEY (po_line_id, item_id) REFERENCES inv.po_lines (id, item_id),
  CHECK ((packs IS NULL) = (pack_size IS NULL) AND (packs IS NULL) = (pack_kind IS NULL)),
  CHECK ((packs IS NULL AND loose IS NULL) OR quantity = coalesce(packs * pack_size, 0) + coalesce(loose, 0)),
  CHECK (kind <> 'receipt' OR (quantity > 0 AND receipt_id IS NOT NULL)),
  CHECK (po_line_id IS NULL OR receipt_id IS NOT NULL OR kind = 'reversal'),
  CHECK ((kind = 'correction') = (reason_id IS NOT NULL)),
  CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL))
);

CREATE INDEX ledger_item_idx ON inv.ledger (item_id);
CREATE INDEX ledger_po_line_idx ON inv.ledger (po_line_id);
CREATE INDEX ledger_action_idx ON inv.ledger (action_id);  -- the rows of one entry: a trim, a reversal

CREATE TRIGGER check_family_live BEFORE INSERT ON inv.ledger
  FOR EACH ROW EXECUTE FUNCTION inv.check_item_family_live();

-- A ledger row's pack kind is one its item's family comes in, whatever
-- writes the row, as 003's inv.check_pack_size_kind holds for
-- inv.pack_sizes. inv.checked_receipt_line gives the message with its line
-- number first; this is the guarantee.
CREATE FUNCTION inv.check_ledger_pack_kind() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f inv.families;
BEGIN
  SELECT fam.* INTO f FROM inv.items i JOIN inv.families fam ON fam.code = i.family WHERE i.id = NEW.item_id;
  IF FOUND AND NEW.pack_kind IS NOT NULL AND NOT NEW.pack_kind = ANY (f.pack_kinds) THEN
    RAISE EXCEPTION 'A pack size for % is a %.', f.name, inv.word_list(f.pack_kinds, 'or') USING ERRCODE = 'IV400';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_pack_kind BEFORE INSERT ON inv.ledger
  FOR EACH ROW EXECUTE FUNCTION inv.check_ledger_pack_kind();

-- A reversal mirrors the row it reverses, whatever writes it (design, "Rules
-- the database enforces"): same item and PO line, the opposite quantity, and
-- the same moment, so a count made after the entry hides both (S27, story
-- 79). A reversal is never reversed (owner, Q44): the original is entered
-- again instead. inv.reverse_entry gives the plain refusals; this is the
-- guarantee.
CREATE FUNCTION inv.check_reversal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  o inv.ledger;
BEGIN
  SELECT * INTO o FROM inv.ledger WHERE id = NEW.reverses_id;
  IF o.kind = 'reversal' OR (NEW.item_id, NEW.quantity, NEW.effective_at, NEW.po_line_id)
       IS DISTINCT FROM (o.item_id, -o.quantity, o.effective_at, o.po_line_id) THEN
    RAISE EXCEPTION 'A reversal must mirror an entry that is not a reversal.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_reversal BEFORE INSERT ON inv.ledger
  FOR EACH ROW WHEN (NEW.reverses_id IS NOT NULL) EXECUTE FUNCTION inv.check_reversal();

-- Story 107 (003 left this refusal to part 2): once an item has receipts,
-- its name stays, so the records keep naming what arrived, whatever writes
-- the row. Part 3 adds counts to this check.
CREATE FUNCTION inv.check_item_name_kept() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.sku, NEW.product, NEW.size, NEW.grade, NEW.length_ft) IS DISTINCT FROM (OLD.sku, OLD.product, OLD.size, OLD.grade, OLD.length_ft)
     AND EXISTS (SELECT FROM inv.ledger WHERE item_id = OLD.id) THEN
    RAISE EXCEPTION '% has receipts, so its name stays.', inv.item_label(OLD) USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_name_kept BEFORE UPDATE OF sku, product, size, grade, length_ft ON inv.items
  FOR EACH ROW EXECUTE FUNCTION inv.check_item_name_kept();

-- Every text a person types has a length limit (owner, 2026-10-03): about
-- twice the longest real value, or a published limit (a name 70, the UK
-- government full-name standard; an email 254, RFC 5321). A trigger, so it
-- holds whatever writes the row, 001-003's functions and imports included.
-- Its arguments are triples: column, limit, the words for the refusal. On an
-- update a column is checked only if it changed, so a longer value saved
-- before this migration never blocks another change to its row.
CREATE FUNCTION inv.check_lengths() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_new jsonb := pg_catalog.to_jsonb(NEW);
  v_old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN pg_catalog.to_jsonb(OLD) END;
  i integer := 0;
BEGIN
  WHILE i < TG_NARGS LOOP
    IF pg_catalog.char_length(v_new ->> TG_ARGV[i]) > TG_ARGV[i + 1]::integer
       AND (v_old ->> TG_ARGV[i]) IS DISTINCT FROM (v_new ->> TG_ARGV[i]) THEN
      RAISE EXCEPTION '% has at most % characters.', TG_ARGV[i + 2], TG_ARGV[i + 1] USING ERRCODE = 'IV400';
    END IF;
    i := i + 3;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.users FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('email', '254', 'An email address', 'name', '70', 'A name');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.items FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('sku', '30', 'A SKU', 'product', '60', 'An LVL product',
    'size', '10', 'An LVL depth', 'grade', '20', 'A grade', 'note', '200', 'A note');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.suppliers FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('name', '60', 'A supplier name');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.reasons FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('text', '60', 'A reason');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.lumber_purchasable_lengths FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('grade', '20', 'A grade');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.lumber_grade_redirects FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('from_grade', '20', 'A grade', 'to_grade', '20', 'A grade');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.purchase_orders FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('number', '20', 'A PO number');
-- The longest real tracking number is 34 characters (2026-10-04).
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.receipts FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('bol', '60', 'A Bill of Lading or tracking number');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.ledger FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('note', '200', 'A note');

-- What has arrived against a PO line, in its family's order unit, as the
-- line's amount ordered is: for lumber, pieces × length in linear feet
-- (Q14); else pieces.
CREATE FUNCTION inv.received(p_line_id bigint) RETURNS integer
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (coalesce((SELECT pg_catalog.sum(g.quantity) FROM inv.ledger g WHERE g.po_line_id = l.id), 0)
          * CASE f.order_unit WHEN 'linear feet' THEN i.length_ft ELSE 1 END)::integer
    FROM inv.po_lines l JOIN inv.items i ON i.id = l.item_id JOIN inv.families f ON f.code = i.family
   WHERE l.id = p_line_id
$$;

-- A PO line's number, "Line n" as the Receive page, the refusals and the
-- Activity Log name it: the nth line of its PO in the order entered,
-- closed lines included.
CREATE FUNCTION inv.po_line_number(p_line_id bigint) RETURNS integer
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (SELECT pg_catalog.count(*)::integer FROM inv.po_lines x WHERE x.po_id = l.po_id AND x.id <= l.id)
    FROM inv.po_lines l WHERE l.id = p_line_id  -- blank for no line
$$;

-- PO edit rule 4 (owner, 2026-10-03), whatever writes the row: a line with
-- receipts keeps its item (inv.ledger's foreign key also holds this), and
-- its amount never goes below what arrived.
CREATE FUNCTION inv.check_po_line_received() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_received integer;
  v_amount text;
  n integer := inv.po_line_number(OLD.id);
BEGIN
  IF NOT EXISTS (SELECT FROM inv.ledger WHERE po_line_id = OLD.id) THEN RETURN NEW; END IF;
  v_received := inv.received(OLD.id);
  SELECT v_received || ' ' || f.order_unit INTO v_amount
    FROM inv.items i JOIN inv.families f ON f.code = i.family WHERE i.id = OLD.item_id;
  IF NEW.item_id <> OLD.item_id THEN
    RAISE EXCEPTION 'Line %: % of % have arrived on this line, so its item stays.', n, v_amount,
      (SELECT inv.item_label(i) FROM inv.items i WHERE i.id = OLD.item_id) USING ERRCODE = 'IV422';
  END IF;
  IF NEW.ordered < v_received THEN
    RAISE EXCEPTION 'Line %: % have arrived on this line, so it orders at least %.', n, v_amount, v_received
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_received BEFORE UPDATE OF item_id, ordered ON inv.po_lines
  FOR EACH ROW EXECUTE FUNCTION inv.check_po_line_received();

-- The figures worked out from the records, never stored (#81, "Calculated
-- figures live in one place"): one row per item. The Overview reads it now;
-- the rest of part 2 adds on hand, available and reorder here, and part 4's
-- Planner reads the same view.
-- incoming (story 32) is in the family's order unit. For each open PO line
-- it is ordered − received, never below zero, so an over-delivery (story
-- 41) takes nothing from another line. A closed line counts nothing.
-- on_hand is in pieces: every ledger row of the item. Until part 3 adds
-- counts, the ledger is all there is; part 3 starts it from the latest
-- approved count instead.
-- reorder (story 52, Q15): Short when available is below zero, Low when it
-- is at or below the threshold, otherwise OK; a blank threshold is never
-- Low. Until step 4 adds committed, available is on hand. An LVL item has
-- no threshold of its own (Q16, Q35): it is Short by its own length, and
-- Low when its depth's linear feet (depth_lf: every length at that depth
-- added together; blank for other families) are at or below the depth's
-- threshold.
CREATE VIEW inv.item_figures AS
SELECT d.item_id, d.incoming, d.on_hand, d.depth_lf,
       CASE WHEN d.on_hand < 0 THEN 'Short'
            WHEN d.on_hand <= d.threshold OR d.depth_lf <= t.threshold_lf THEN 'Low'
            ELSE 'OK' END AS reorder
  FROM (SELECT f.*,
               CASE WHEN f.family = 'lvl'
                    THEN pg_catalog.sum(f.on_hand * f.length_ft) OVER (PARTITION BY f.family, f.size)::integer END AS depth_lf
          FROM (SELECT i.id AS item_id, i.family, i.size, i.length_ft, i.threshold,
                       coalesce(pg_catalog.sum(GREATEST(l.ordered - inv.received(l.id), 0)), 0)::integer AS incoming,
                       coalesce((SELECT pg_catalog.sum(g.quantity) FROM inv.ledger g WHERE g.item_id = i.id), 0)::integer AS on_hand
                  FROM inv.items i
                  LEFT JOIN inv.po_lines l ON l.item_id = i.id AND l.closed_reason_id IS NULL
                 GROUP BY i.id) f) d
  LEFT JOIN inv.lvl_depth_thresholds t ON d.family = 'lvl' AND t.depth = d.size;

-- One row per LVL depth for the line above its lengths on the Overview
-- (Q58): its linear feet, its threshold, and its Reorder. The depth is Short
-- when any length is short (Q35), else Low or OK as its lengths are, since
-- inv.item_figures judges every length at a depth by the depth's feet.
CREATE VIEW inv.lvl_depth_figures AS
SELECT i.size AS depth, pg_catalog.max(f.depth_lf) AS available_lf, t.threshold_lf,
       CASE WHEN pg_catalog.bool_or(f.reorder = 'Short') THEN 'Short'
            WHEN pg_catalog.bool_or(f.reorder = 'Low') THEN 'Low'
            ELSE 'OK' END AS reorder
  FROM inv.items i
  JOIN inv.item_figures f ON f.item_id = i.id
  LEFT JOIN inv.lvl_depth_thresholds t ON t.depth = i.size
 WHERE i.family = 'lvl'
 GROUP BY i.size, t.threshold_lf;

INSERT INTO inv.actions (name, admin_only) VALUES ('enter PO', false), ('edit PO', false),
  ('close PO line', false), ('re-open PO line', false), ('switch family live', true), ('receive', false),
  ('correct', false), ('trim', false), ('reverse', false);

-- 001's inv.finish_action, with one change: a change whose record is the
-- same before and after, the version aside, is refused (owner, 2026-10-03).
-- One place for every edit, 003's and later parts' included, so the log
-- holds only changes (story 106) and the version stays where the screen read
-- it. An addition or a password action records no "before", so it never
-- meets this.
CREATE OR REPLACE FUNCTION inv.finish_action(p_log_id bigint, p_target_id bigint, p_old jsonb, p_new jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_new jsonb;
BEGIN
  IF p_old - 'version' = p_new - 'version' THEN
    RAISE EXCEPTION 'Nothing changed, so nothing was saved.' USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.activity_log
     SET target_id = p_target_id, old_value = p_old, new_value = p_new
   WHERE id = p_log_id
  RETURNING new_value INTO v_new;
  RETURN v_new;
END
$$;

CREATE FUNCTION inv.family_json(f inv.families) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT pg_catalog.jsonb_build_object('name', f.name, 'live', f.live) $$;

-- The owner's command (#81 story 99), run by src/db/switch-family-live.js
-- over the direct connection, never by the app: the app's login cannot run
-- it. Logged like any change, with the admin the owner names as its actor;
-- an address that is not an active admin's is refused in those words, which
-- inv.claim_action's own refusal does not give.
CREATE FUNCTION inv.set_family_live(p_admin_email text, p_family text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.families;
  f inv.families;
  v_admin bigint := (SELECT id FROM inv.users
                      WHERE email = pg_catalog.lower(inv.tidy(p_admin_email)) AND active AND admin);
BEGIN
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'No active admin has the address %.', p_admin_email USING ERRCODE = 'IV403';
  END IF;
  a := inv.claim_action(v_admin, pg_catalog.gen_random_uuid(), 'switch family live', 'families', NULL,
         pg_catalog.jsonb_build_object('family', p_family));
  SELECT * INTO was FROM inv.families WHERE code = p_family FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no family "%".', p_family USING ERRCODE = 'IV400';
  END IF;
  -- EWP holds no items until step 5 (Q28), so it has nothing to be live with.
  IF was.identity IS NULL THEN
    RAISE EXCEPTION '% stays out of Inventory until step 5.', was.name USING ERRCODE = 'IV422';
  END IF;
  IF was.live THEN
    RAISE EXCEPTION '% is already live in Inventory.', was.name USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.families SET live = true WHERE code = p_family RETURNING * INTO f;
  RETURN inv.finish_action(a.log_id, NULL, inv.family_json(was), inv.family_json(f));
END
$$;

-- A PO with its supplier's name and its lines, in the shape every function
-- returns and logs, and the Receive page lists. Each line carries its item's
-- name, so the Activity Log names the item as it was at the time, and what
-- has arrived, in the order unit (inv.received). status is "finished" when
-- no open line has anything still to arrive, "partial" when something has
-- arrived and more is to come (story 38), else "ordered".
CREATE FUNCTION inv.po_json(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH lines AS (
    SELECT l.*, inv.item_label(i) AS item, r.text AS closed_reason, inv.received(l.id) AS received
      FROM inv.po_lines l JOIN inv.items i ON i.id = l.item_id
      LEFT JOIN inv.reasons r ON r.id = l.closed_reason_id
     WHERE l.po_id = p_id)
  SELECT pg_catalog.jsonb_build_object(
    'id', po.id, 'version', po.version, 'supplier_id', po.supplier_id, 'supplier', s.name,
    'number', po.number, 'po_date', po.po_date,
    'status', CASE WHEN NOT EXISTS (SELECT FROM lines WHERE closed_reason IS NULL AND received < ordered) THEN 'finished'
                   WHEN EXISTS (SELECT FROM lines WHERE received > 0) THEN 'partial'
                   ELSE 'ordered' END,
    'lines', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', id, 'item_id', item_id, 'item', item, 'ordered', ordered, 'received', received,
                'pack_size', pack_size, 'closed_reason', closed_reason) ORDER BY id), '[]')
                FROM lines))
    FROM inv.purchase_orders po JOIN inv.suppliers s ON s.id = po.supplier_id
   WHERE po.id = p_id
$$;

-- Reads and locks the PO a change is about, refusing it when the PO or any
-- of its lines has changed since the screen read it (S41), and moves its
-- version on: every change to a PO or its lines starts here, but for a
-- reversal of a receipt line, which no screen's version is checked for, so
-- inv.reverse_entry moves the version on itself. The refusal's
-- DETAIL is the current PO, so the screen can show what the other save did.
CREATE FUNCTION inv.po_at_version(p_id bigint, p_version integer) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_version integer;
  was jsonb;
BEGIN
  SELECT version INTO v_version FROM inv.purchase_orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That PO is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  was := inv.po_json(p_id);
  IF p_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'Someone else changed this PO since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = was::text;
  END IF;
  UPDATE inv.purchase_orders SET version = version + 1 WHERE id = p_id;
  RETURN was;  -- the PO as it was, for the log
END
$$;

-- Reads the PO line a change is about, and its PO through inv.po_at_version
-- (refused when stale; its version moves on). Shared by close and re-open,
-- which differ only in the state they check and the reason they set.
CREATE FUNCTION inv.po_line_at_version(p_line_id bigint, p_po_version integer, OUT line inv.po_lines, OUT was jsonb)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  SELECT * INTO line FROM inv.po_lines WHERE id = p_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That PO line is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  was := inv.po_at_version(line.po_id, p_po_version);
END
$$;

-- The reason picked for `what` ("A correction"), which must be on the list,
-- in use (Settings → Reasons retires one) and not kept for another entry.
CREATE FUNCTION inv.checked_reason(p_id bigint, what text) RETURNS inv.reasons
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r inv.reasons;
BEGIN
  SELECT * INTO r FROM inv.reasons WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% needs a reason from the list.', what USING ERRCODE = 'IV400';
  END IF;
  IF NOT r.active THEN
    RAISE EXCEPTION '"%" is retired. Pick a reason in use.', r.text USING ERRCODE = 'IV400';
  END IF;
  IF r.entry = 'trim' THEN
    RAISE EXCEPTION '"%" is for a trim. Use Trim on the LVL item.', r.text USING ERRCODE = 'IV422';
  ELSIF r.entry = 'import' THEN
    RAISE EXCEPTION '"%" is for the cutover import only.', r.text USING ERRCODE = 'IV422';
  END IF;
  RETURN r;
END
$$;

-- Inventory → Receive → a PO line → Close: the line no longer counts as
-- incoming (S15, story 39). The reason is picked from Settings → Reasons.
CREATE FUNCTION inv.close_po_line(p_actor bigint, p_key uuid, p_line_id bigint, p_po_version integer, p_reason_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  x record;
  r inv.reasons;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'close PO line', 'purchase_orders', NULL,
                        pg_catalog.jsonb_build_object('line_id', p_line_id, 'po_version', p_po_version,
                                                      'reason_id', p_reason_id));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  x := inv.po_line_at_version(p_line_id, p_po_version);
  IF (x.line).closed_reason_id IS NOT NULL THEN
    RAISE EXCEPTION 'That line is already closed.' USING ERRCODE = 'IV422';
  END IF;
  r := inv.checked_reason(p_reason_id, 'Closing a line');
  UPDATE inv.po_lines SET closed_reason_id = r.id WHERE id = p_line_id;
  RETURN inv.finish_action(a.log_id, (x.line).po_id, x.was, inv.po_json((x.line).po_id));
END
$$;

-- Inventory → Receive → a closed PO line → Re-open: it counts as incoming again.
CREATE FUNCTION inv.reopen_po_line(p_actor bigint, p_key uuid, p_line_id bigint, p_po_version integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  x record;
BEGIN
  a := inv.claim_action(p_actor, p_key, 're-open PO line', 'purchase_orders', NULL,
                        pg_catalog.jsonb_build_object('line_id', p_line_id, 'po_version', p_po_version));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  x := inv.po_line_at_version(p_line_id, p_po_version);
  IF (x.line).closed_reason_id IS NULL THEN
    RAISE EXCEPTION 'That line is already open.' USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.po_lines SET closed_reason_id = NULL WHERE id = p_line_id;
  RETURN inv.finish_action(a.log_id, (x.line).po_id, x.was, inv.po_json((x.line).po_id));
END
$$;

-- Whether a JSON value is a whole number above 0 that an integer column
-- holds (at most 2,147,483,647), so a mistyped huge number gets the plain
-- refusal, not Postgres's "out of range". Ids are checked with it too; none
-- comes near that.
CREATE FUNCTION inv.is_whole_above_zero(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(pg_catalog.jsonb_typeof(p) = 'number'
                  AND p::numeric = pg_catalog.trunc(p::numeric) AND p::numeric BETWEEN 1 AND 2147483647, false)
$$;

-- The same, with 0 allowed: packs and loose pieces on a receipt line.
CREATE FUNCTION inv.is_whole_zero_or_more(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT p = '0' OR inv.is_whole_above_zero(p) $$;

-- Whether a request's field holds anything: neither missing nor JSON null.
CREATE FUNCTION inv.is_given(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT coalesce(p <> 'null', false) $$;

-- A PO's supplier, number and date as a person gives them, checked and
-- tidied, as a row not saved yet. Shared by inv.enter_po and inv.edit_po, so
-- both refuse the same things.
--   p_po_date  YYYY-MM-DD; deliberately text, checked here, because Postgres
--              would also read "yesterday", or 06/07/2026 by the connection's
--              DateStyle, which a shared pooler connection does not promise.
CREATE FUNCTION inv.checked_po(p_supplier_id bigint, p_number text, p_po_date text) RETURNS inv.purchase_orders
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  po inv.purchase_orders;
BEGIN
  IF NOT EXISTS (SELECT FROM inv.suppliers WHERE id = p_supplier_id) THEN
    RAISE EXCEPTION 'Pick the supplier from the list.' USING ERRCODE = 'IV400';
  END IF;
  po.supplier_id := p_supplier_id;
  po.number := inv.tidy(p_number);
  IF coalesce(po.number, '') = '' THEN
    RAISE EXCEPTION 'A PO needs its number.' USING ERRCODE = 'IV400';
  END IF;
  BEGIN
    IF p_po_date ~ '^\d{4}-\d{2}-\d{2}$' THEN po.po_date := p_po_date::date; END IF;
  EXCEPTION WHEN datetime_field_overflow THEN  -- 2026-02-30
    NULL;
  END;
  IF po.po_date IS NULL THEN
    RAISE EXCEPTION 'A PO date is a real date, written like 2026-10-03.' USING ERRCODE = 'IV400';
  END IF;
  RETURN po;
END
$$;

-- Called when a save breaks purchase_orders_number_key.
CREATE FUNCTION inv.refuse_po_number_in_use(po inv.purchase_orders) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'PO % from % is already entered.', po.number,
    (SELECT name FROM inv.suppliers WHERE id = po.supplier_id) USING ERRCODE = 'IV400';
END
$$;

-- Line n of a PO as a person gives it ({item_id, ordered, pack_size}),
-- checked, as a row not saved yet. Shared by inv.enter_po and inv.edit_po.
-- p_was_item is the item the line already orders (null for a new line): a
-- retired item cannot come onto a PO, but a line whose item was retired
-- since it was entered still saves. A family not live in Inventory is
-- refused by the trigger on inv.po_lines when the line is saved.
CREATE FUNCTION inv.checked_po_line(n integer, r jsonb, p_was_item bigint) RETURNS inv.po_lines
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i inv.items;
  l inv.po_lines;
BEGIN
  SELECT * INTO i FROM inv.items
   WHERE id = CASE WHEN inv.is_whole_above_zero(r -> 'item_id') THEN (r ->> 'item_id')::bigint END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Line %: pick the item from the catalog.', n USING ERRCODE = 'IV400';
  END IF;
  IF NOT i.active AND i.id IS DISTINCT FROM p_was_item THEN
    RAISE EXCEPTION 'Line %: % is retired. Un-retire it before you order it.', n, inv.item_label(i)
      USING ERRCODE = 'IV422';
  END IF;
  IF NOT inv.is_whole_above_zero(r -> 'ordered') THEN
    RAISE EXCEPTION 'Line %: the amount ordered is a whole number of % above 0.', n,
      (SELECT order_unit FROM inv.families WHERE code = i.family) USING ERRCODE = 'IV400';
  END IF;
  IF coalesce(r -> 'pack_size', 'null') <> 'null' AND NOT inv.is_whole_above_zero(r -> 'pack_size') THEN
    RAISE EXCEPTION 'Line %: a pack size is a whole number of pieces above 0, or blank.', n USING ERRCODE = 'IV400';
  END IF;
  l.item_id := i.id;
  l.ordered := (r ->> 'ordered')::integer;
  l.pack_size := (r ->> 'pack_size')::integer;
  RETURN l;
END
$$;

-- Inventory → Receive → Enter a PO (stories 29–31). One save: a refused line
-- leaves nothing saved (S21).
--   p_lines  [{item_id, ordered, pack_size}]; ordered in the item's family's
--            order unit; pack_size blank or pieces per pack.
CREATE FUNCTION inv.enter_po(
  p_actor bigint, p_key uuid, p_supplier_id bigint, p_number text, p_po_date text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  po inv.purchase_orders;
  l inv.po_lines;
  r jsonb;
  n integer;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'enter PO', 'purchase_orders', NULL,
                        pg_catalog.jsonb_build_object('supplier_id', p_supplier_id, 'number', p_number,
                                                      'po_date', p_po_date, 'lines', p_lines));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  po := inv.checked_po(p_supplier_id, p_number, p_po_date);
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'A PO needs at least one line.' USING ERRCODE = 'IV400';
  END IF;
  BEGIN
    INSERT INTO inv.purchase_orders (supplier_id, number, po_date)
    VALUES (po.supplier_id, po.number, po.po_date) RETURNING id INTO po.id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM inv.refuse_po_number_in_use(po);
  END;
  FOR r, n IN SELECT e, e_n::integer FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS x(e, e_n) LOOP
    l := inv.checked_po_line(n, r, NULL);
    INSERT INTO inv.po_lines (po_id, item_id, ordered, pack_size) VALUES (po.id, l.item_id, l.ordered, l.pack_size);
  END LOOP;
  RETURN inv.finish_action(a.log_id, po.id, NULL, inv.po_json(po.id));
END
$$;

-- Inventory → Receive → a PO → Edit: fixes its supplier, number and date,
-- and its open lines' item, amount and pack size, and adds lines (owner,
-- 2026-10-03). p_lines lists every open line, by id, plus any new line
-- without one; a closed line may be listed too, unchanged. A line is never
-- removed: one not wanted is closed with a reason (inv.close_po_line), and a
-- closed line is re-opened before it is changed. A save that changes nothing
-- is refused by inv.finish_action. Receiving adds its own limits on a line with receipts: its item
-- stays, and its amount never goes below what arrived.
CREATE FUNCTION inv.edit_po(
  p_actor bigint, p_key uuid, p_id bigint, p_version integer,
  p_supplier_id bigint, p_number text, p_po_date text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was jsonb;
  po inv.purchase_orders;
  old inv.po_lines;
  l inv.po_lines;
  r jsonb;
  n integer;
  v_listed bigint[] := '{}';
  v_left_out inv.items;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'edit PO', 'purchase_orders', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version, 'supplier_id', p_supplier_id,
                                                      'number', p_number, 'po_date', p_po_date, 'lines', p_lines));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  was := inv.po_at_version(p_id, p_version);
  po := inv.checked_po(p_supplier_id, p_number, p_po_date);
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'An edit lists the PO''s lines.' USING ERRCODE = 'IV400';
  END IF;
  SELECT i.* INTO v_left_out FROM inv.po_lines x JOIN inv.items i ON i.id = x.item_id
   WHERE x.po_id = p_id AND x.closed_reason_id IS NULL
     AND NOT EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_lines) e WHERE e ->> 'id' = x.id::text)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% is left out. A line is never removed; close it instead.', inv.item_label(v_left_out)
      USING ERRCODE = 'IV422';
  END IF;
  BEGIN
    UPDATE inv.purchase_orders SET supplier_id = po.supplier_id, number = po.number, po_date = po.po_date
     WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM inv.refuse_po_number_in_use(po);
  END;
  FOR r, n IN SELECT e, e_n::integer FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS x(e, e_n) LOOP
    IF coalesce(r -> 'id', 'null') = 'null' THEN
      l := inv.checked_po_line(n, r, NULL);
      INSERT INTO inv.po_lines (po_id, item_id, ordered, pack_size) VALUES (p_id, l.item_id, l.ordered, l.pack_size);
      CONTINUE;
    END IF;
    SELECT * INTO old FROM inv.po_lines
     WHERE po_id = p_id AND id = CASE WHEN inv.is_whole_above_zero(r -> 'id') THEN (r ->> 'id')::bigint END;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Line %: that line is not on this PO.', n USING ERRCODE = 'IV400';
    END IF;
    IF old.id = ANY (v_listed) THEN
      RAISE EXCEPTION 'Line % repeats a line already listed.', n USING ERRCODE = 'IV400';
    END IF;
    v_listed := v_listed || old.id;
    l := inv.checked_po_line(n, r, old.item_id);
    -- A closed line comes back as it is: the Receive page lists every line,
    -- so "Line n" here is line n on the page and in the Activity Log.
    IF old.closed_reason_id IS NOT NULL THEN
      IF (l.item_id, l.ordered, l.pack_size) IS DISTINCT FROM (old.item_id, old.ordered, old.pack_size) THEN
        RAISE EXCEPTION 'Line %: that line is closed. Re-open it before you change it.', n USING ERRCODE = 'IV422';
      END IF;
      CONTINUE;
    END IF;
    UPDATE inv.po_lines SET item_id = l.item_id, ordered = l.ordered, pack_size = l.pack_size WHERE id = old.id;
  END LOOP;
  RETURN inv.finish_action(a.log_id, p_id, was, inv.po_json(p_id));
END
$$;

-- A receipt with its PO's number or its supplier, and its lines, in the
-- shape inv.receive returns and logs. po_line is the line's number on its
-- PO, "Line n" as the Receive page numbers it; blank for a line not on a PO.
CREATE FUNCTION inv.receipt_json(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', rc.id, 'po_id', rc.po_id, 'po_number', po.number, 'supplier', s.name, 'bol', rc.bol,
    'lines', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', g.id,
                'po_line', inv.po_line_number(g.po_line_id),
                'item_id', g.item_id, 'item', inv.item_label(i), 'quantity', g.quantity, 'packs', g.packs,
                'pack_size', g.pack_size, 'pack_kind', g.pack_kind, 'loose', g.loose) ORDER BY g.id)
                FROM inv.ledger g JOIN inv.items i ON i.id = g.item_id
               WHERE g.receipt_id = rc.id))
    FROM inv.receipts rc
    LEFT JOIN inv.purchase_orders po ON po.id = rc.po_id
    JOIN inv.suppliers s ON s.id = coalesce(rc.supplier_id, po.supplier_id)
   WHERE rc.id = p_id
$$;

-- Whether a receipt line has nothing filled in: no pieces, packs or loose.
CREATE FUNCTION inv.is_blank_receipt_line(r jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NOT (inv.is_given(r -> 'quantity') OR inv.is_given(r -> 'packs') OR inv.is_given(r -> 'loose'))
$$;

-- Line n of a receipt as a person gives it ({po_line_id, item_id, quantity,
-- packs, pack_size, pack_kind, loose}), checked, as a ledger row not saved
-- yet. p_po_id is the receipt's PO, or null without one.
CREATE FUNCTION inv.checked_receipt_line(n integer, r jsonb, p_po_id bigint) RETURNS inv.ledger
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i inv.items;
  f inv.families;
  pl inv.po_lines;
  g inv.ledger;
BEGIN
  SELECT * INTO i FROM inv.items
   WHERE id = CASE WHEN inv.is_whole_above_zero(r -> 'item_id') THEN (r ->> 'item_id')::bigint END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Line %: pick the item from the catalog.', n USING ERRCODE = 'IV400';
  END IF;
  SELECT * INTO f FROM inv.families WHERE code = i.family;
  IF inv.is_given(r -> 'po_line_id') THEN
    SELECT * INTO pl FROM inv.po_lines
     WHERE po_id = p_po_id AND id = CASE WHEN inv.is_whole_above_zero(r -> 'po_line_id') THEN (r ->> 'po_line_id')::bigint END;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Line %: that line is not on this PO.', n USING ERRCODE = 'IV400';
    END IF;
    IF pl.item_id <> i.id THEN
      RAISE EXCEPTION 'Line %: that PO line orders %, not %.', n,
        (SELECT inv.item_label(x) FROM inv.items x WHERE x.id = pl.item_id), inv.item_label(i) USING ERRCODE = 'IV400';
    END IF;
    IF pl.closed_reason_id IS NOT NULL THEN
      RAISE EXCEPTION 'Line %: that PO line is closed. Re-open it before you receive against it.', n USING ERRCODE = 'IV422';
    END IF;
  -- A PO line whose item was retired since it was ordered still takes its delivery.
  ELSIF NOT i.active THEN
    RAISE EXCEPTION 'Line %: % is retired. Un-retire it before you receive it.', n, inv.item_label(i) USING ERRCODE = 'IV422';
  END IF;
  PERFORM inv.check_po_family(i, p_po_id, n, NULL);  -- an item not on the PO comes in on it all the same
  IF NOT inv.is_whole_above_zero(r -> 'quantity') THEN
    RAISE EXCEPTION 'Line %: the pieces received are a whole number above 0.', n USING ERRCODE = 'IV400';
  END IF;
  g.item_id := i.id;
  g.po_line_id := pl.id;
  g.quantity := (r ->> 'quantity')::integer;
  -- How the delivery came, if the person gives it: packs × pack size + loose.
  IF inv.is_given(r -> 'packs') <> inv.is_given(r -> 'pack_size') THEN
    RAISE EXCEPTION 'Line %: give both the packs and the pack size, or neither.', n USING ERRCODE = 'IV400';
  END IF;
  IF inv.is_given(r -> 'pack_size') THEN
    IF NOT inv.is_whole_above_zero(r -> 'pack_size') THEN
      RAISE EXCEPTION 'Line %: a pack size is a whole number of pieces above 0.', n USING ERRCODE = 'IV400';
    END IF;
    IF NOT inv.is_whole_zero_or_more(r -> 'packs') THEN
      RAISE EXCEPTION 'Line %: packs are a whole number, 0 or more.', n USING ERRCODE = 'IV400';
    END IF;
    g.packs := (r ->> 'packs')::integer;
    g.pack_size := (r ->> 'pack_size')::integer;
    g.pack_kind := r ->> 'pack_kind';
    IF NOT coalesce(g.pack_kind = ANY (f.pack_kinds), false) THEN
      RAISE EXCEPTION 'Line %: a pack size for % is a %.', n, f.name, inv.word_list(f.pack_kinds, 'or') USING ERRCODE = 'IV400';
    END IF;
  END IF;
  IF inv.is_given(r -> 'loose') THEN
    IF NOT inv.is_whole_zero_or_more(r -> 'loose') THEN
      RAISE EXCEPTION 'Line %: loose pieces are a whole number, 0 or more.', n USING ERRCODE = 'IV400';
    END IF;
    g.loose := (r ->> 'loose')::integer;
  END IF;
  -- In numeric, so packs × pack size too large for an integer is a mismatch, not an error.
  IF (g.packs IS NOT NULL OR g.loose IS NOT NULL)
     AND coalesce(g.packs::numeric * g.pack_size, 0) + coalesce(g.loose, 0) <> g.quantity THEN
    RAISE EXCEPTION 'Line %: % is %, not the % pieces received.', n,
      pg_catalog.concat_ws(' + ', g.packs || ' × ' || g.pack_size, g.loose || ' loose'),
      coalesce(g.packs::numeric * g.pack_size, 0) + coalesce(g.loose, 0), g.quantity USING ERRCODE = 'IV400';
  END IF;
  RETURN g;
END
$$;

-- Inventory → Receive → Receive (stories 33–41): a delivery against a PO
-- (p_po_id and the version the screen read; refused when stale, so one
-- delivery is not entered twice from two screens) or without one
-- (p_supplier_id). One save: a refused line leaves nothing saved (S21).
-- The moment it takes effect is the save's; part 3's "before or after the
-- count?" question changes that near a count.
--   p_lines     [{po_line_id, item_id, quantity, packs, pack_size, pack_kind, loose}];
--               quantity in pieces; po_line_id blank for a line not on the PO.
--   p_replaces  a receipt line this receipt replaces (inv.replaced_at), or null.
CREATE FUNCTION inv.receive(
  p_actor bigint, p_key uuid, p_po_id bigint, p_po_version integer, p_supplier_id bigint, p_bol text, p_lines jsonb,
  p_replaces bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_receipt bigint;
  v_at timestamptz;
  v_added jsonb := '[]';
  g inv.ledger;
  r jsonb;
  n integer;
  v_last integer;  -- the PO's last line number; a line not on the PO comes after it
BEGIN
  a := inv.claim_action(p_actor, p_key, 'receive', 'receipts', NULL,
                        pg_catalog.jsonb_build_object('po_id', p_po_id, 'po_version', p_po_version,
                                                      'supplier_id', p_supplier_id, 'bol', p_bol, 'lines', p_lines,
                                                      'replaces', p_replaces));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  IF p_po_id IS NOT NULL AND p_supplier_id IS NOT NULL THEN
    RAISE EXCEPTION 'A receipt against a PO takes its PO''s supplier.' USING ERRCODE = 'IV400';
  ELSIF p_po_id IS NOT NULL THEN
    PERFORM inv.po_at_version(p_po_id, p_po_version);
  ELSIF NOT EXISTS (SELECT FROM inv.suppliers WHERE id = p_supplier_id) THEN
    RAISE EXCEPTION 'Pick the supplier from the list.' USING ERRCODE = 'IV400';
  END IF;
  -- After the PO's check: reversing a line it replaces on the same PO moves
  -- that PO on too, and must not make this screen look stale (Q76).
  v_at := inv.replaced_at(a.log_id, p_replaces);
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A receipt lists its lines.' USING ERRCODE = 'IV400';
  END IF;
  -- A line with no pieces, packs or loose filled in is a PO line nothing
  -- arrived on this time, and is skipped. "Line n" is the number the Receive
  -- page shows (owner, Q74): a PO line's own number, closed lines counted,
  -- as on the PO list; a line not on the PO, numbered on after the PO's last.
  IF NOT EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_lines) e WHERE NOT inv.is_blank_receipt_line(e)) THEN
    RAISE EXCEPTION 'Nothing to receive. Fill in the pieces that arrived.' USING ERRCODE = 'IV400';
  END IF;
  INSERT INTO inv.receipts (po_id, supplier_id, bol)
  VALUES (p_po_id, p_supplier_id, nullif(inv.tidy(p_bol), '')) RETURNING id INTO v_receipt;
  v_last := (SELECT pg_catalog.count(*) FROM inv.po_lines WHERE po_id = p_po_id);
  FOR r, n IN
    SELECT e, coalesce(inv.po_line_number(l.id), v_last + pg_catalog.count(*) FILTER (WHERE l.id IS NULL) OVER (ORDER BY e_n)::integer)
      FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS x(e, e_n)
      LEFT JOIN inv.po_lines l
        ON l.po_id = p_po_id AND l.id = CASE WHEN inv.is_whole_above_zero(e -> 'po_line_id') THEN (e ->> 'po_line_id')::bigint END
     ORDER BY e_n LOOP
    CONTINUE WHEN inv.is_blank_receipt_line(r);
    g := inv.checked_receipt_line(n, r, p_po_id);
    INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, receipt_id, po_line_id,
                            packs, pack_size, pack_kind, loose)
    VALUES (g.item_id, g.quantity, 'receipt', v_at, a.log_id, v_receipt, g.po_line_id,
            g.packs, g.pack_size, g.pack_kind, g.loose);
    -- Story 19 = B (owner, 2026-10-03): a size typed for a kind the item has
    -- no size of becomes its size on file, logged with this receipt. One it
    -- has already stays; only Settings → Pack sizes changes that.
    IF g.pack_size IS NOT NULL THEN
      INSERT INTO inv.pack_sizes (item_id, kind, pieces) VALUES (g.item_id, g.pack_kind, g.pack_size)
      ON CONFLICT (item_id, kind) DO NOTHING;
      IF FOUND THEN
        v_added := v_added || pg_catalog.jsonb_build_object(
          'item', (SELECT inv.item_label(i) FROM inv.items i WHERE i.id = g.item_id), 'kind', g.pack_kind, 'pieces', g.pack_size);
      END IF;
    END IF;
  END LOOP;
  RETURN inv.finish_action(a.log_id, v_receipt, NULL,
    inv.receipt_json(v_receipt) || pg_catalog.jsonb_build_object('pack_sizes_added', v_added) || inv.replaced_json(a.log_id, p_replaces));
END
$$;

-- One correction as the app shows it, and as its log row records it.
CREATE FUNCTION inv.correction_json(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object('id', g.id, 'item_id', g.item_id, 'item', inv.item_label(i),
           'quantity', g.quantity, 'reason', r.text, 'note', g.note)
    FROM inv.ledger g JOIN inv.items i ON i.id = g.item_id JOIN inv.reasons r ON r.id = g.reason_id
   WHERE g.id = p_id
$$;

-- Inventory → Overview → an item → Correct on hand: changes its on hand by
-- p_quantity pieces, + or −, with a reason (S46, story 44). The moment it
-- takes effect is the save's; part 3's "before or after the count?" question
-- changes that near a count. p_replaces: a correction this one replaces
-- (inv.replaced_at), or null.
CREATE FUNCTION inv.correct(
  p_actor bigint, p_key uuid, p_item_id bigint, p_quantity numeric, p_reason_id bigint, p_note text,
  p_replaces bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_id bigint;
  v_at timestamptz;
  f inv.families;
  r inv.reasons;
  v_note text := nullif(inv.tidy(p_note), '');
BEGIN
  a := inv.claim_action(p_actor, p_key, 'correct', 'ledger', NULL,
                        pg_catalog.jsonb_build_object('item_id', p_item_id, 'quantity', p_quantity,
                                                      'reason_id', p_reason_id, 'note', p_note, 'replaces', p_replaces));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  v_at := inv.replaced_at(a.log_id, p_replaces);
  SELECT fam.* INTO f FROM inv.items i JOIN inv.families fam ON fam.code = i.family WHERE i.id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pick the item from the catalog.' USING ERRCODE = 'IV400';
  END IF;
  IF p_quantity IS NULL OR p_quantity = 0 OR p_quantity <> pg_catalog.trunc(p_quantity) THEN
    RAISE EXCEPTION 'Type the change in pieces: a whole number other than 0, such as 12 or -3.' USING ERRCODE = 'IV400';
  END IF;
  r := inv.checked_reason(p_reason_id, 'A correction');
  IF r.text = 'Damaged – scrapped' AND p_quantity > 0 THEN
    RAISE EXCEPTION '"%" takes pieces away: type a number below 0.', r.text USING ERRCODE = 'IV400';
  ELSIF r.text = 'Returned from job site' AND p_quantity < 0 THEN
    RAISE EXCEPTION '"%" adds pieces: type a number above 0.', r.text USING ERRCODE = 'IV400';
  ELSIF r.text = 'Returned from job site' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Type the job number in the note, so the return can be traced.' USING ERRCODE = 'IV400';
  ELSIF r.text = 'Returned from job site' AND NOT f.returnable THEN
    RAISE EXCEPTION '% does not come back from a job site: it is used up on the job.', f.name USING ERRCODE = 'IV422';
  END IF;
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, reason_id, note)
  VALUES (p_item_id, p_quantity, 'correction', v_at, a.log_id, r.id, v_note)
  RETURNING id INTO v_id;
  RETURN inv.finish_action(a.log_id, v_id, NULL, inv.correction_json(v_id) || inv.replaced_json(a.log_id, p_replaces));
END
$$;

-- Inventory → Overview → an LVL item → Trim: p_boards weathered boards of
-- the item cut down to p_length_ft, one usable piece from each, the cut-off
-- thrown away (stories 47–48; owner, Q35–Q37). Two correction rows, − on the
-- long item and + on the short one, in one action, so a trim is complete or
-- refused (design, "A trim or swap is complete"). The short item is the same
-- product and depth; if the catalog has no such length, the trim adds it as
-- Non-Stock (Q21), so a leftover length is not taken for a special order.
-- A retired length is put back in use, but only when p_unretire says the
-- screen told the person so (owner, Q39); a stale screen is refused.
-- The reason is the one kept for a trim (inv.reasons.entry), looked up here:
-- inv.checked_reason refuses it everywhere else. EWP has no names until step
-- 5, so only LVL is trimmed for now (inv.families.trimmable). p_replaces: a
-- trim this one replaces (inv.replaced_at), or null.
CREATE FUNCTION inv.trim(
  p_actor bigint, p_key uuid, p_item_id bigint, p_length_ft numeric, p_boards numeric, p_note text, p_unretire boolean,
  p_replaces bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_id bigint;
  v_at timestamptz;
  v_unretired boolean := false;
  long inv.items;
  short inv.items;
  wanted inv.items;
  f inv.families;
  v_added boolean := false;
  v_reason inv.reasons;
  v_note text := nullif(inv.tidy(p_note), '');
BEGIN
  a := inv.claim_action(p_actor, p_key, 'trim', 'ledger', NULL,
                        pg_catalog.jsonb_build_object('item_id', p_item_id, 'length_ft', p_length_ft,
                                                      'boards', p_boards, 'note', p_note, 'unretire', p_unretire,
                                                      'replaces', p_replaces));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  v_at := inv.replaced_at(a.log_id, p_replaces);
  SELECT * INTO long FROM inv.items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pick the item from the catalog.' USING ERRCODE = 'IV400';
  END IF;
  SELECT * INTO f FROM inv.families WHERE code = long.family;
  IF NOT f.trimmable THEN
    RAISE EXCEPTION '% items are not trimmed. A trim is for a weathered LVL board.', f.name USING ERRCODE = 'IV422';
  END IF;
  IF NOT inv.is_whole_above_zero(pg_catalog.to_jsonb(p_length_ft)) OR p_length_ft >= long.length_ft THEN
    RAISE EXCEPTION 'Pick a length shorter than %′.', long.length_ft USING ERRCODE = 'IV400';
  END IF;
  IF NOT inv.is_whole_above_zero(pg_catalog.to_jsonb(p_boards)) THEN
    RAISE EXCEPTION 'Type how many boards: a whole number above 0, such as 1 or 3.' USING ERRCODE = 'IV400';
  END IF;
  -- The short item is the long one at the new length: same product and depth.
  wanted := long;
  wanted.length_ft := p_length_ft;
  SELECT * INTO short FROM inv.items i WHERE inv.same_item(i, wanted);
  IF NOT FOUND THEN
    -- Two trims to a new length at once: the second finds the item the first added.
    BEGIN
      INSERT INTO inv.items (family, product, size, length_ft, stocking)
      VALUES (wanted.family, wanted.product, wanted.size, wanted.length_ft, 'Non-Stock')
      RETURNING * INTO short;
      v_added := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO short FROM inv.items i WHERE inv.same_item(i, wanted);
    END;
  END IF;
  IF NOT short.active AND NOT coalesce(p_unretire, false) THEN
    RAISE EXCEPTION '% is retired. Pick the length again: the trim puts it back in use.', inv.item_label(short)
      USING ERRCODE = 'IV422';
  ELSIF NOT short.active THEN
    UPDATE inv.items SET active = true WHERE id = short.id;
    v_unretired := true;
  END IF;
  SELECT * INTO v_reason FROM inv.reasons WHERE entry = 'trim';
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, reason_id, note)
  VALUES (long.id, -p_boards, 'correction', v_at, a.log_id, v_reason.id, v_note)
  RETURNING id INTO v_id;
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, reason_id, note)
  VALUES (short.id, p_boards, 'correction', v_at, a.log_id, v_reason.id, v_note);
  RETURN inv.finish_action(a.log_id, v_id, NULL, pg_catalog.jsonb_build_object(
    'id', v_id, 'item', inv.item_label(long), 'to_item', inv.item_label(short), 'length_ft', short.length_ft,
    'boards', p_boards, 'note', v_note, 'item_added', v_added, 'item_unretired', v_unretired)
    || inv.replaced_json(a.log_id, p_replaces));
END
$$;

-- A reversal as the app shows it and its log row records it: the action
-- it reverses, and each row with its item, the opposite of the original.
CREATE FUNCTION inv.reversal_json(p_log_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'reverses', pg_catalog.min(ol.action), 'note', pg_catalog.min(g.note),
    'lines', pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('item', inv.item_label(i), 'quantity', g.quantity) ORDER BY g.id))
    FROM inv.ledger g
    JOIN inv.items i ON i.id = g.item_id
    JOIN inv.ledger o ON o.id = g.reverses_id
    JOIN inv.activity_log ol ON ol.id = o.action_id
   WHERE g.action_id = p_log_id AND g.kind = 'reversal'
$$;

-- Writes the reversal of ledger row p_id, and of every other row of the same
-- entry, in action p_log_id; answers the first reversal row's id. An entry
-- is reversed whole, so a trim's two rows go together or not at all (design,
-- "A trim or a swap is complete"); a receipt is reversed one line at a time
-- (owner, Q45). Rows a replacing entry reversed are not part of it. Each
-- reversal takes the moment of the row it reverses (inv.check_reversal).
CREATE FUNCTION inv.reverse_entry(p_log_id bigint, p_id bigint, p_note text) RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  o inv.ledger;
  g inv.ledger;
  v_first bigint;
  v_id bigint;
BEGIN
  SELECT x.* INTO o FROM inv.ledger x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That entry is not in the records.' USING ERRCODE = 'IV400';
  END IF;
  IF o.kind = 'reversal' THEN
    RAISE EXCEPTION 'A reversal cannot be reversed. Enter the original again instead.' USING ERRCODE = 'IV422';
  END IF;
  FOR g IN SELECT x.* FROM inv.ledger x
            WHERE x.action_id = o.action_id AND x.kind <> 'reversal' AND (x.id = o.id OR o.receipt_id IS NULL)
            ORDER BY x.id FOR UPDATE LOOP
    BEGIN
      INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, po_line_id, reverses_id, note)
      VALUES (g.item_id, -g.quantity, 'reversal', g.effective_at, p_log_id, g.po_line_id, g.id, p_note)
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'That entry is already reversed.' USING ERRCODE = 'IV422';
    END;
    -- A receipt line's PO now has less received, so a screen that read it
    -- before is stale (S41, owner Q76).
    UPDATE inv.purchase_orders SET version = version + 1
     WHERE id = (SELECT po_id FROM inv.po_lines WHERE id = g.po_line_id);
    v_first := coalesce(v_first, v_id);
  END LOOP;
  RETURN v_first;
END
$$;

-- The moment a new entry takes effect, in action p_log_id: now, or, when it
-- replaces ledger row p_replaces, that row's moment, after reversing it in
-- the same save (owner, 2026-10-05). So a receipt moved to the right PO, or
-- a correction or trim entered again with the right numbers, is timed as
-- the entry it replaces: a count made in between already holds the real
-- pieces, and hides both the reversal and the new entry, as it hides any
-- reversal (S27). Entered as a new entry, it would be timed after that count
-- and counted twice. An entry replaces only one of its own kind.
CREATE FUNCTION inv.replaced_at(p_log_id bigint, p_replaces bigint) RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_action text := (SELECT action FROM inv.activity_log WHERE id = p_log_id);
  v_at timestamptz;
BEGIN
  IF p_replaces IS NULL THEN RETURN pg_catalog.now(); END IF;
  SELECT g.effective_at INTO v_at FROM inv.ledger g JOIN inv.activity_log l ON l.id = g.action_id
   WHERE g.id = p_replaces AND l.action = v_action AND g.kind <> 'reversal';
  IF NOT FOUND THEN
    RAISE EXCEPTION '%. Reverse this entry from History instead.',
      CASE v_action WHEN 'receive' THEN 'A receipt replaces only a receipt line'
                    WHEN 'correct' THEN 'A correction replaces only a correction' ELSE 'A trim replaces only a trim' END
      USING ERRCODE = 'IV422';
  END IF;
  PERFORM inv.reverse_entry(p_log_id, p_replaces, NULL);
  RETURN v_at;
END
$$;

-- What a replacing entry adds to its answer and its log row: the reversal it
-- made, or nothing when it replaces none.
CREATE FUNCTION inv.replaced_json(p_log_id bigint, p_replaces bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN p_replaces IS NULL THEN '{}'::jsonb
              ELSE pg_catalog.jsonb_build_object('reversed', inv.reversal_json(p_log_id)) END
$$;

-- Inventory → Overview → an item → History → Reverse: undoes a receipt
-- line, a correction or a trim entered by mistake; the original stays,
-- marked reversed (stories 42, 43, 49).
CREATE FUNCTION inv.reverse(p_actor bigint, p_key uuid, p_id bigint, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_id bigint;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'reverse', 'ledger', NULL,
                        pg_catalog.jsonb_build_object('id', p_id, 'note', p_note));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  v_id := inv.reverse_entry(a.log_id, p_id, nullif(inv.tidy(p_note), ''));
  RETURN inv.finish_action(a.log_id, v_id, NULL, inv.reversal_json(a.log_id));
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inv FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inv.reverse(bigint, uuid, bigint, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.correct(bigint, uuid, bigint, numeric, bigint, text, bigint) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.trim(bigint, uuid, bigint, numeric, numeric, text, boolean, bigint) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.receive(bigint, uuid, bigint, integer, bigint, text, jsonb, bigint) TO inv_app;
-- inv.po_json and inv.item_figures work out what arrived with inv.received.
GRANT EXECUTE ON FUNCTION inv.received(bigint) TO inv_app;
-- An item's History (src/inventory/history.js) numbers each receipt's PO line.
GRANT EXECUTE ON FUNCTION inv.po_line_number(bigint) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.enter_po(bigint, uuid, bigint, text, text, jsonb) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.edit_po(bigint, uuid, bigint, integer, bigint, text, text, jsonb) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.close_po_line(bigint, uuid, bigint, integer, bigint) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.reopen_po_line(bigint, uuid, bigint, integer) TO inv_app;
-- The app lists POs in the shape inv.enter_po answers with (src/inventory/catalog.js);
-- inv.po_json names each line's item with inv.item_label, so the app runs that too.
GRANT EXECUTE ON FUNCTION inv.po_json(bigint) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.item_label(inv.items) TO inv_app;
