-- Step 3, part 3 (#81): counts and month-end. All of part 3 goes in this one
-- file, built over several sessions, applied once part 3 is complete (owner,
-- 2026-10-07, like 004). Group A (story 28) starts it: the working-day
-- setting, and the window function group D will call.
-- Source: docs/database-design.md, table 16 (settings); #81 story 28 and
-- "Changes made while building part 1", item 1 (story 28 moved here: no
-- migration before this one ever created inv.settings).
-- Follows migration 001: every change is a SECURITY DEFINER function that
-- starts with inv.claim_action and ends with inv.finish_action; every name is
-- fully qualified; every refusal carries an IV code (listed in 001).

-- Single named values, each with its own version (design table 16), so a
-- screen that read one setting can be refused a stale save without a table
-- lock on the others. value is deliberately jsonb, not integer: a later
-- setting need not be a number, and typing this one integer now would cost
-- a column-type migration to loosen later.
CREATE TABLE inv.settings (
  name    text PRIMARY KEY,
  value   jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE TRIGGER bump_version BEFORE UPDATE OF value ON inv.settings
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- The window an entry made after a count asks "before or after?" for (design
-- Q4): a whole number of working days, weekends always skipped, holidays not.
-- Seeded 1, the design's default.
INSERT INTO inv.settings (name, value) VALUES ('working_day_window', '1');

CREATE FUNCTION inv.setting_json(s inv.settings) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT pg_catalog.jsonb_build_object('name', s.name, 'value', s.value, 'version', s.version) $$;

-- The moment the working-day window reaches back to, from p_at: p_at's clock
-- time, that many working days earlier, in America/New_York, weekends
-- skipped and holidays not (design Q4). Reads the setting itself, so group D
-- (the before-or-after question) only calls this, never inv.settings
-- directly. Monday 8:00 with the default 1 reaches back to Friday 8:00: one
-- day back lands on Sunday (skipped, still 1 to go), another lands on
-- Saturday (skipped, still 1 to go), another lands on Friday (a weekday, done).
CREATE FUNCTION inv.working_day_window_start(p_at timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_local timestamp := p_at AT TIME ZONE 'America/New_York';
  v_remaining integer;
BEGIN
  SELECT (value)::integer INTO v_remaining FROM inv.settings WHERE name = 'working_day_window';
  WHILE v_remaining > 0 LOOP
    v_local := v_local - interval '1 day';
    IF pg_catalog.date_part('dow', v_local) NOT IN (0, 6) THEN
      v_remaining := v_remaining - 1;
    END IF;
  END LOOP;
  RETURN v_local AT TIME ZONE 'America/New_York';
END
$$;

INSERT INTO inv.actions (name, admin_only) VALUES ('set working day window', true);

-- Settings → Inventory → Working day. Everyone reads the value (/api/working-day);
-- only an admin changes it (owner, Q101; #81 "Admin-only actions").
CREATE FUNCTION inv.set_working_day_window(p_actor bigint, p_key uuid, p_version integer, p_days numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.settings;
  s inv.settings;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'set working day window', 'settings', NULL,
                        pg_catalog.jsonb_build_object('version', p_version, 'days', p_days));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO was FROM inv.settings WHERE name = 'working_day_window' FOR UPDATE;
  IF p_version IS DISTINCT FROM was.version THEN
    RAISE EXCEPTION 'Someone else changed the working-day window since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = inv.setting_json(was)::text;
  END IF;
  -- At most 20 (owner, Q126): four working weeks, and inv.working_day_window_start
  -- steps back one day at a time.
  IF p_days IS NULL OR p_days <> pg_catalog.trunc(p_days) OR p_days < 1 OR p_days > 20 THEN
    RAISE EXCEPTION 'The working-day window is a whole number of days, from 1 to 20.' USING ERRCODE = 'IV400';
  END IF;
  UPDATE inv.settings SET value = pg_catalog.to_jsonb(p_days::integer) WHERE name = 'working_day_window'
  RETURNING * INTO s;
  RETURN inv.finish_action(a.log_id, NULL, inv.setting_json(was), inv.setting_json(s));
END
$$;

GRANT EXECUTE ON FUNCTION inv.set_working_day_window(bigint, uuid, integer, numeric) TO inv_app;

-- Group B (stories 58–67): start, save and submit a count. Source:
-- docs/database-design.md tables 12–13, "Rules the database enforces"; ADR
-- 0002; #81 stories 58–67; owner, Q103–Q105 (2026-10-08): a spot check
-- prints the whole family, and a row left blank is not counted; only a
-- monthly count closes a month; the open PO lines before printing are shown,
-- never a gate.

-- A count of one family (design table 12). counted_at is its moment: when
-- the sheet was printed or opened, set once at the start and never moved
-- (story 59, ADR 0002), so submitting or approving it later changes nothing
-- about when it is true. closes is the month a monthly count closes, as its
-- first day ("closes: September" is 2026-09-01); a spot check closes none
-- (Q104). Like a PO, the count and its lines share one version (S41). A
-- rejected count records no approver: its log row says who rejected it.
CREATE TABLE inv.counts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family       text NOT NULL REFERENCES inv.families (code),
  kind         text NOT NULL CHECK (kind IN ('monthly', 'spot check')),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'waiting', 'approved', 'rejected')),
  closes       date CHECK (pg_catalog.date_part('day', closes) = 1),
  counted_at   timestamptz NOT NULL,
  submitted_at timestamptz,
  counted_by   bigint NOT NULL REFERENCES inv.users (id),
  approved_at  timestamptz,
  approved_by  bigint REFERENCES inv.users (id),
  version      integer NOT NULL DEFAULT 1,
  CHECK ((kind = 'monthly') = (closes IS NOT NULL)),
  CHECK ((status = 'draft') = (submitted_at IS NULL)),
  CHECK (submitted_at >= counted_at),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL) AND (status = 'approved') = (approved_by IS NOT NULL)),
  CHECK (approved_at >= submitted_at)
);

-- What was found for one item: packs × pack size + loose (story 62), which
-- is the quantity counted. 0 is a real count, an empty rack (story 64). An
-- item sitting in two pack sizes has a line for each (S74). Each line keeps
-- its own copy of the pack size and its kind, as a receipt line does (Q13).
-- A line with neither packs nor loose is a row left blank, never saved.
-- expected is the app's number for the item at the count's moment, worked
-- out at approval and then kept, as the record of what the approver saw
-- (design table 13, story 70). Every line of one item keeps the same number:
-- Matched is the item's lines added up against it. reason_id explains an
-- Unmatched item, picked by the approver (story 71, Q111), on each of its lines.
CREATE TABLE inv.count_lines (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id  bigint NOT NULL REFERENCES inv.counts (id),
  item_id   bigint NOT NULL REFERENCES inv.items (id),
  packs     integer CHECK (packs >= 0),
  pack_size integer CHECK (pack_size > 0),
  pack_kind text,
  loose     integer CHECK (loose >= 0),
  quantity  integer NOT NULL GENERATED ALWAYS AS (coalesce(packs * pack_size, 0) + coalesce(loose, 0)) STORED,
  expected  integer,
  reason_id bigint REFERENCES inv.reasons (id),
  CHECK (reason_id IS NULL OR expected IS NOT NULL),
  CHECK ((packs IS NULL) = (pack_size IS NULL) AND (packs IS NULL) = (pack_kind IS NULL)),
  CHECK (packs IS NOT NULL OR loose IS NOT NULL)
);

-- At most one approved monthly count per family per month (design, "Rules
-- the database enforces"): the one that closes it. inv.decide_count gives
-- the plain refusal; this is the guarantee.
CREATE UNIQUE INDEX counts_one_approved_monthly ON inv.counts (family, closes)
  WHERE status = 'approved' AND kind = 'monthly';

CREATE INDEX count_lines_count_idx ON inv.count_lines (count_id);
CREATE INDEX count_lines_item_idx ON inv.count_lines (item_id);

-- A count's family is live in Inventory, whatever writes the row, in 004's
-- words (story 57). inv.check_item_family_live does the same for a row
-- with an item; a count has only its family.
CREATE FUNCTION inv.check_count_family_live() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f inv.families;
BEGIN
  SELECT * INTO f FROM inv.families WHERE code = NEW.family;
  IF FOUND AND NOT f.live THEN
    RAISE EXCEPTION 'The % family is not live in Inventory yet, so it takes no POs, receipts, corrections or counts.', f.name
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_family_live BEFORE INSERT ON inv.counts
  FOR EACH ROW EXECUTE FUNCTION inv.check_count_family_live();

-- The month before the one p_at falls in, in the office's time zone: the
-- month a count taken then closes unless the person picks another (story
-- 65, S10). A count taken July 1 or July 3 closes June.
CREATE FUNCTION inv.month_before(p_at timestamptz) RETURNS date
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (pg_catalog.date_trunc('month', p_at AT TIME ZONE 'America/New_York') - interval '1 month')::date
$$;

-- A count with its lines, in the shape every count function returns and
-- logs. family_name, counted_by and approved_by name the family and the
-- people, and each line carries its item's name, so the Activity Log names
-- them as they were; closes is "YYYY-MM". Once approved, each line carries
-- the app's number for its item (expected), whether the item's lines add
-- up to it (matched), and the reason for an Unmatched item; before that all
-- three are blank.
-- Lines go without their ids: a draft save writes them anew, so a save that
-- gives the same lines again is the same count, and inv.finish_action
-- refuses it as changing nothing.
CREATE FUNCTION inv.count_json(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', c.id, 'version', c.version, 'family', c.family, 'family_name', f.name, 'kind', c.kind, 'status', c.status,
    'closes', pg_catalog.to_char(c.closes, 'YYYY-MM'), 'counted_at', c.counted_at, 'counted_by', u.name,
    'approved_by', (SELECT name FROM inv.users WHERE id = c.approved_by),
    'lines', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'item_id', l.item_id, 'item', inv.item_label(i), 'packs', l.packs, 'pack_size', l.pack_size,
                'pack_kind', l.pack_kind, 'loose', l.loose, 'quantity', l.quantity,
                'expected', l.expected, 'matched', l.item_quantity = l.expected,
                'reason', (SELECT text FROM inv.reasons WHERE id = l.reason_id)) ORDER BY l.id), '[]')
                FROM (SELECT x.*, pg_catalog.sum(x.quantity) OVER (PARTITION BY x.item_id) AS item_quantity
                        FROM inv.count_lines x WHERE x.count_id = c.id) l
                JOIN inv.items i ON i.id = l.item_id))
    FROM inv.counts c JOIN inv.users u ON u.id = c.counted_by JOIN inv.families f ON f.code = c.family
   WHERE c.id = p_id
$$;

-- The month a count closes, from what the person gave: blank takes the
-- month before p_at (story 65); a monthly count may close another month,
-- written YYYY-MM, but never one after the month it was taken in. A spot
-- check closes none (Q104).
CREATE FUNCTION inv.checked_closes(p_kind text, p_closes text, p_at timestamptz) RETURNS date
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_closes date;
BEGIN
  IF p_kind = 'spot check' THEN
    IF coalesce(p_closes, '') <> '' THEN
      RAISE EXCEPTION 'A spot check closes no month; only a monthly count does.' USING ERRCODE = 'IV400';
    END IF;
    RETURN NULL;
  END IF;
  IF coalesce(p_closes, '') = '' THEN RETURN inv.month_before(p_at); END IF;
  BEGIN
    IF p_closes ~ '^\d{4}-\d{2}$' THEN v_closes := (p_closes || '-01')::date; END IF;
  EXCEPTION WHEN datetime_field_overflow THEN  -- 2026-13
    NULL;
  END;
  IF v_closes IS NULL THEN
    RAISE EXCEPTION 'The month a count closes is written like 2026-09.' USING ERRCODE = 'IV400';
  END IF;
  IF v_closes > inv.month_before(p_at) + interval '1 month' THEN
    RAISE EXCEPTION 'A count taken in % cannot close a later month.',
      pg_catalog.to_char(p_at AT TIME ZONE 'America/New_York', 'FMMonth YYYY') USING ERRCODE = 'IV400';
  END IF;
  RETURN v_closes;
END
$$;

INSERT INTO inv.actions (name, admin_only) VALUES ('start count', false), ('save count', false), ('submit count', false);

-- Inventory → Count → Start (stories 58, 59, 65): a draft count of one
-- family, monthly or a spot check, timed now. The page then opens the sheet
-- to print; a draft blocks nothing (design, Q31) and changes no on hand (S7).
--   p_closes  YYYY-MM, or blank for last month; blank for a spot check.
CREATE FUNCTION inv.start_count(p_actor bigint, p_key uuid, p_family text, p_kind text, p_closes text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_id bigint;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'start count', 'counts', NULL,
                        pg_catalog.jsonb_build_object('family', p_family, 'kind', p_kind, 'closes', p_closes));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  IF NOT EXISTS (SELECT FROM inv.families WHERE code = p_family AND identity IS NOT NULL) THEN
    RAISE EXCEPTION 'Pick the family to count.' USING ERRCODE = 'IV400';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('monthly', 'spot check') THEN
    RAISE EXCEPTION 'A count is monthly or a spot check.' USING ERRCODE = 'IV400';
  END IF;
  INSERT INTO inv.counts (family, kind, closes, counted_at, counted_by)
  VALUES (p_family, p_kind, inv.checked_closes(p_kind, p_closes, pg_catalog.now()), pg_catalog.now(), p_actor)
  RETURNING id INTO v_id;
  RETURN inv.finish_action(a.log_id, v_id, NULL, inv.count_json(v_id));
END
$$;

GRANT EXECUTE ON FUNCTION inv.start_count(bigint, uuid, text, text, text) TO inv_app;

-- Line n of a count as a person gives it ({item_id, packs, pack_size,
-- pack_kind, loose}), checked, as a row not saved yet. A refusal names the
-- item, as the sheet lists it. p_was_items are the items the draft already
-- counts: one retired since it was saved still saves, as on a PO. An item of
-- another family is refused by the trigger on inv.count_lines.
CREATE FUNCTION inv.checked_count_line(n integer, r jsonb, p_was_items bigint[]) RETURNS inv.count_lines
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i inv.items;
  f inv.families;
  l inv.count_lines;
  v_item text;
BEGIN
  SELECT * INTO i FROM inv.items
   WHERE id = CASE WHEN inv.is_whole_above_zero(r -> 'item_id') THEN (r ->> 'item_id')::bigint END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Line %: pick the item from the catalog.', n USING ERRCODE = 'IV400';
  END IF;
  v_item := inv.item_label(i);
  IF NOT i.active AND NOT i.id = ANY (p_was_items) THEN
    RAISE EXCEPTION '% is retired. Un-retire it before you count it.', v_item USING ERRCODE = 'IV422';
  END IF;
  SELECT * INTO f FROM inv.families WHERE code = i.family;
  l.item_id := i.id;
  IF inv.is_given(r -> 'packs') <> inv.is_given(r -> 'pack_size') THEN
    RAISE EXCEPTION '%: give both the packs and the pack size, or neither.', v_item USING ERRCODE = 'IV400';
  END IF;
  IF inv.is_given(r -> 'packs') THEN
    IF NOT inv.is_whole_above_zero(r -> 'pack_size') THEN
      RAISE EXCEPTION '%: a pack size is a whole number of pieces above 0.', v_item USING ERRCODE = 'IV400';
    END IF;
    IF NOT inv.is_whole_zero_or_more(r -> 'packs') THEN
      RAISE EXCEPTION '%: packs are a whole number, 0 or more.', v_item USING ERRCODE = 'IV400';
    END IF;
    IF NOT coalesce(r ->> 'pack_kind' = ANY (f.pack_kinds), false) THEN
      RAISE EXCEPTION '%: a pack size for % is a %.', v_item, f.name, inv.word_list(f.pack_kinds, 'or') USING ERRCODE = 'IV400';
    END IF;
    l.packs := (r ->> 'packs')::integer;
    l.pack_size := (r ->> 'pack_size')::integer;
    l.pack_kind := r ->> 'pack_kind';
  END IF;
  IF inv.is_given(r -> 'loose') THEN
    IF NOT inv.is_whole_zero_or_more(r -> 'loose') THEN
      RAISE EXCEPTION '%: loose pieces are a whole number, 0 or more.', v_item USING ERRCODE = 'IV400';
    END IF;
    l.loose := (r ->> 'loose')::integer;
  END IF;
  -- In numeric, so a total too large for the quantity column is refused in words.
  IF coalesce(l.packs::numeric * l.pack_size, 0) + coalesce(l.loose, 0) > 2147483647 THEN
    RAISE EXCEPTION '%: % × % is more pieces than the app can hold.', v_item, l.packs, l.pack_size USING ERRCODE = 'IV400';
  END IF;
  RETURN l;
END
$$;

-- A count line's item is of its count's family (Q103: one family's sheet),
-- whatever writes the row, and a count's lines change only while it is a
-- draft: a submitted count is what its approver judges. The one change after
-- that is approval's, while the count still waits: it writes the app's
-- number and the reason on each line, and nothing else. An approved or rejected count's
-- lines never change (S75): only a correction changes an approved count.
CREATE FUNCTION inv.check_count_line() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c inv.counts;
  i inv.items;
  l inv.count_lines := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  SELECT * INTO c FROM inv.counts WHERE id = l.count_id;
  -- quantity is left out: a BEFORE trigger sees a generated column blank.
  IF c.status = 'waiting' AND TG_OP = 'UPDATE'
     AND (pg_catalog.to_jsonb(NEW) - '{expected,reason_id,quantity}'::text[])
       = (pg_catalog.to_jsonb(OLD) - '{expected,reason_id,quantity}'::text[]) THEN
    RETURN NEW;
  END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'This count is already submitted, so its lines stay as they are.' USING ERRCODE = 'IV422';
  END IF;
  SELECT * INTO i FROM inv.items WHERE id = l.item_id;
  IF TG_OP <> 'DELETE' AND i.family <> c.family THEN
    RAISE EXCEPTION '% is %, but this count is of %.', inv.item_label(i),
      (SELECT name FROM inv.families WHERE code = i.family), (SELECT name FROM inv.families WHERE code = c.family)
      USING ERRCODE = 'IV422';
  END IF;
  RETURN l;
END
$$;

CREATE TRIGGER check_count_line BEFORE INSERT OR UPDATE OR DELETE ON inv.count_lines
  FOR EACH ROW EXECUTE FUNCTION inv.check_count_line();
CREATE TRIGGER check_family_live BEFORE INSERT OR UPDATE OF item_id ON inv.count_lines
  FOR EACH ROW EXECUTE FUNCTION inv.check_item_family_live();
-- 004's check on a ledger row's pack kind reads only item_id and pack_kind,
-- so a count line uses it as it is.
CREATE TRIGGER check_pack_kind BEFORE INSERT OR UPDATE ON inv.count_lines
  FOR EACH ROW EXECUTE FUNCTION inv.check_ledger_pack_kind();

-- Save draft and Submit, one save each (stories 66–67). Refused when the
-- count or its lines changed since the screen read it (S41; the refusal's
-- DETAIL is the count as it is now), or when it is no longer a draft. Writes
-- the month and the lines as the person gave them, replacing the lines the
-- draft had: a draft is work in progress, and its log rows keep each earlier
-- version (owner, Q108). A row with neither packs nor loose is a row left
-- blank on the sheet, so it is skipped (Q103). A refused line leaves nothing
-- saved (S21). p_action 'submit count' then sends the count for approval.
CREATE FUNCTION inv.change_draft(
  p_actor bigint, p_key uuid, p_action text, p_id bigint, p_version integer, p_closes text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  c inv.counts;
  was jsonb;
  v_was_items bigint[];
  l inv.count_lines;
  r jsonb;
  n integer;
BEGIN
  a := inv.claim_action(p_actor, p_key, p_action, 'counts', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version, 'closes', p_closes, 'lines', p_lines));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO c FROM inv.counts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That count is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  was := inv.count_json(p_id);
  IF p_version IS DISTINCT FROM c.version THEN
    RAISE EXCEPTION 'Someone else changed this count since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = was::text;
  END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'This count is already submitted, so it is not changed here.' USING ERRCODE = 'IV422';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A count lists its lines.' USING ERRCODE = 'IV400';
  END IF;
  UPDATE inv.counts SET version = version + 1, closes = inv.checked_closes(c.kind, p_closes, c.counted_at) WHERE id = p_id;
  v_was_items := ARRAY(SELECT item_id FROM inv.count_lines WHERE count_id = p_id);
  DELETE FROM inv.count_lines WHERE count_id = p_id;
  FOR r, n IN SELECT e, e_n::integer FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS x(e, e_n) LOOP
    CONTINUE WHEN NOT (inv.is_given(r -> 'packs') OR inv.is_given(r -> 'loose'));
    l := inv.checked_count_line(n, r, v_was_items);
    INSERT INTO inv.count_lines (count_id, item_id, packs, pack_size, pack_kind, loose)
    VALUES (p_id, l.item_id, l.packs, l.pack_size, l.pack_kind, l.loose);
  END LOOP;
  IF p_action = 'submit count' THEN
    IF NOT EXISTS (SELECT FROM inv.count_lines WHERE count_id = p_id) THEN
      RAISE EXCEPTION 'A count needs at least one counted line to submit. A row left blank is not counted; type 0 for an empty rack.'
        USING ERRCODE = 'IV400';
    END IF;
    UPDATE inv.counts SET status = 'waiting', submitted_at = pg_catalog.now() WHERE id = p_id;
  END IF;
  RETURN inv.finish_action(a.log_id, p_id, was, inv.count_json(p_id));
END
$$;

-- Inventory → Count → a draft → Save draft (story 66): keeps what is
-- entered so far, changing no on hand (S7) and blocking nothing (Q31).
--   p_closes  YYYY-MM, or blank for the month before the count's moment;
--             blank for a spot check.
--   p_lines   [{item_id, packs, pack_size, pack_kind, loose}], in pieces.
CREATE FUNCTION inv.save_count(p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_closes text, p_lines jsonb)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.change_draft(p_actor, p_key, 'save count', p_id, p_version, p_closes, p_lines) $$;

-- Inventory → Count → a draft → Submit for approval (story 67): saves the
-- lines as given and sends the count for approval, in one save. Its moment
-- stays when it started (ADR 0002). Refused when one of its items is
-- already on a waiting count (S8, inv.check_one_waiting_count). Arguments
-- as inv.save_count.
CREATE FUNCTION inv.submit_count(p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_closes text, p_lines jsonb)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.change_draft(p_actor, p_key, 'submit count', p_id, p_version, p_closes, p_lines) $$;

GRANT EXECUTE ON FUNCTION inv.save_count(bigint, uuid, bigint, integer, text, jsonb) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.submit_count(bigint, uuid, bigint, integer, text, jsonb) TO inv_app;
-- Count lists the drafts and waiting counts in the shape the count functions
-- answer with (src/inventory/catalog.js, listCounts).
GRANT EXECUTE ON FUNCTION inv.count_json(bigint) TO inv_app;

-- Story 107, as 004 left it for part 3: an item on a count keeps its name,
-- a draft's included, so the count and its log rows go on naming it. 004's
-- check, with counts added; its trigger calls this by name.
CREATE OR REPLACE FUNCTION inv.check_item_name_kept() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.sku, NEW.product, NEW.size, NEW.grade, NEW.length_ft) IS NOT DISTINCT FROM (OLD.sku, OLD.product, OLD.size, OLD.grade, OLD.length_ft) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT FROM inv.ledger WHERE item_id = OLD.id) THEN
    RAISE EXCEPTION '% has entries in its History, so its name stays.', inv.item_label(OLD) USING ERRCODE = 'IV422';
  END IF;
  IF EXISTS (SELECT FROM inv.count_lines WHERE item_id = OLD.id) THEN
    RAISE EXCEPTION '% is on a count, so its name stays.', inv.item_label(OLD) USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

-- An item is on at most one waiting count at a time (S8, Q31), whatever
-- writes the row: two waiting counts would each claim to be the item's true
-- figure. It spans two tables, so it is a trigger under a lock (design,
-- "Rules the database enforces"). Deliberately a row lock on each counted
-- item, in id order, not a lock on the whole counts table: two submits of
-- different items go side by side, and receipts and corrections, which take
-- only a key-share lock on their item, never wait. FOR NO KEY UPDATE is
-- that row lock: two submits of one item take it in turn, so the second
-- reads the first's waiting count once the first commits (each statement
-- here reads afresh, at the app's READ COMMITTED). A draft holds nothing.
CREATE FUNCTION inv.check_one_waiting_count() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_item text;
  v_who text;
  v_at timestamptz;
BEGIN
  PERFORM FROM inv.items WHERE id IN (SELECT item_id FROM inv.count_lines WHERE count_id = NEW.id)
    ORDER BY id FOR NO KEY UPDATE;
  SELECT inv.item_label(i), u.name, c.counted_at INTO v_item, v_who, v_at
    FROM inv.count_lines l
    JOIN inv.count_lines o ON o.item_id = l.item_id AND o.count_id <> l.count_id
    JOIN inv.counts c ON c.id = o.count_id AND c.status = 'waiting'
    JOIN inv.users u ON u.id = c.counted_by
    JOIN inv.items i ON i.id = l.item_id
   WHERE l.count_id = NEW.id
   ORDER BY l.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% is on %''s count from %, waiting for approval.', v_item, v_who,
      pg_catalog.to_char(v_at AT TIME ZONE 'America/New_York', 'FMMonth FMDD') USING ERRCODE = 'IV422';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER check_one_waiting_count AFTER UPDATE OF status ON inv.counts
  FOR EACH ROW WHEN (NEW.status = 'waiting' AND OLD.status <> 'waiting')
  EXECUTE FUNCTION inv.check_one_waiting_count();

-- Group C (stories 69–76, 80): approve or reject a count, and on hand from
-- approved counts. Source: docs/database-design.md tables 12–13, "How the
-- numbers are calculated" (On hand), "Rules the database enforces"; ADR
-- 0002 (a count is true at its moment, never at approval); owner, Q110–Q114
-- (2026-10-08).

-- The entries made during a count that its approver marked as already in
-- it: "Was this item counted after this entry?" Yes (Q33, S63, S70). A
-- table, not a column on count_lines: one item may have several such
-- entries. On hand leaves them out, and the reversal of one with them.
CREATE TABLE inv.count_reflected (
  count_id  bigint NOT NULL REFERENCES inv.counts (id),
  ledger_id bigint NOT NULL REFERENCES inv.ledger (id),
  PRIMARY KEY (count_id, ledger_id)
);

-- An entry entered again with other numbers (inv.replaced_at) reverses the
-- original and writes the new rows in one action, at the original's moment.
-- A count that held the original holds each new row of the same item too,
-- or on hand adds the new one on top of the pieces the count already holds
-- (PR #89 review). Recorded when the row is written, so a re-entry of a
-- re-entry is held as well; a trim's two rows each follow their own item.
CREATE FUNCTION inv.hold_reentry() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO inv.count_reflected (count_id, ledger_id)
  SELECT r.count_id, NEW.id
    FROM inv.ledger v JOIN inv.count_reflected r ON r.ledger_id = v.reverses_id
   WHERE v.action_id = NEW.action_id AND v.item_id = NEW.item_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER hold_reentry AFTER INSERT ON inv.ledger
  FOR EACH ROW WHEN (NEW.reverses_id IS NULL) EXECUTE FUNCTION inv.hold_reentry();

-- An item's on hand at p_at (design, "How the numbers are calculated"): its
-- figure on the latest approved count that includes it, by moment, plus
-- every ledger row after that moment up to p_at, except the entries that
-- count's approval marked as already in it, and their reversals (Q33). With
-- no approved count, the sum of its ledger rows up to p_at. inv.item_figures asks for 'infinity';
-- approval asks for the count's own moment (ADR 0002).
CREATE FUNCTION inv.on_hand_at(p_item_id bigint, p_at timestamptz) RETURNS integer
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH base AS (
    SELECT c.id, c.counted_at, pg_catalog.sum(l.quantity) AS quantity
      FROM inv.count_lines l JOIN inv.counts c ON c.id = l.count_id
     WHERE l.item_id = p_item_id AND c.status = 'approved' AND c.counted_at <= p_at
     GROUP BY c.id
     ORDER BY c.counted_at DESC, c.id DESC
     LIMIT 1)
  SELECT (coalesce((SELECT quantity FROM base), 0)
          + coalesce((SELECT pg_catalog.sum(g.quantity) FROM inv.ledger g
                       WHERE g.item_id = p_item_id AND g.effective_at <= p_at
                         AND g.effective_at > coalesce((SELECT counted_at FROM base), '-infinity')
                         AND NOT EXISTS (SELECT FROM inv.count_reflected r
                                          WHERE r.count_id = (SELECT id FROM base)
                                            AND r.ledger_id IN (g.id, g.reverses_id))), 0))::integer
$$;

-- 004's view, with on hand from inv.on_hand_at (part 3 starts it from the
-- latest approved count, as 004 said it would). Everything else as 004.
CREATE OR REPLACE VIEW inv.item_figures AS
SELECT d.item_id, d.incoming, d.on_hand, d.depth_lf,
       CASE WHEN d.on_hand < 0 THEN 'Short'
            WHEN d.on_hand <= d.threshold OR d.depth_lf <= t.threshold_lf THEN 'Low'
            ELSE 'OK' END AS reorder
  FROM (SELECT f.*,
               CASE WHEN f.family = 'lvl'
                    THEN pg_catalog.sum(f.on_hand * f.length_ft) OVER (PARTITION BY f.family, f.size)::integer END AS depth_lf
          FROM (SELECT i.id AS item_id, i.family, i.size, i.length_ft, i.threshold,
                       coalesce(pg_catalog.sum(GREATEST(l.ordered - inv.received(l.id), 0)), 0)::integer AS incoming,
                       inv.on_hand_at(i.id, 'infinity') AS on_hand
                  FROM inv.items i
                  LEFT JOIN inv.po_lines l ON l.item_id = i.id AND l.closed_reason_id IS NULL
                 GROUP BY i.id) f) d
  LEFT JOIN inv.lvl_depth_thresholds t ON d.family = 'lvl' AND t.depth = d.size;

-- inv.item_figures works out on hand with inv.on_hand_at, as the app's login.
GRANT EXECUTE ON FUNCTION inv.on_hand_at(bigint, timestamptz) TO inv_app;

-- Whether an item had nothing recorded up to p_at: no approved count and no
-- ledger entry. Such an item needs no reason when Unmatched (owner, Q118),
-- e.g. one added from the count sheet (story 4). An item the cutover gave an
-- opening balance has an entry, so its day-one count still needs one.
CREATE FUNCTION inv.nothing_before(p_item_id bigint, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT FROM inv.ledger WHERE item_id = p_item_id AND effective_at <= p_at)
     AND NOT EXISTS (SELECT FROM inv.count_lines l JOIN inv.counts c ON c.id = l.count_id
                      WHERE l.item_id = p_item_id AND c.status = 'approved' AND c.counted_at <= p_at)
$$;

-- inv.count_review asks it, as the app's login.
GRANT EXECUTE ON FUNCTION inv.nothing_before(bigint, timestamptz) TO inv_app;

INSERT INTO inv.actions (name, admin_only) VALUES ('approve count', false), ('reject count', false);

-- A sixth built-in reason, for an Unmatched item nobody can explain, so a
-- large count is approved without inventing reasons (owner, Q117). Any
-- entry may use it.
INSERT INTO inv.reasons (text, built_in) VALUES ('Unexplained', true);

-- Whether a count needs a second person to approve it (owner, Q110, Q114):
-- on, nobody who started, saved or submitted the count approves it; off,
-- anyone may, the counter included. Seeded on, the design's rule (S5).
INSERT INTO inv.settings (name, value) VALUES ('count_approval_by_another', 'true');

INSERT INTO inv.actions (name, admin_only) VALUES ('set count approval', true);

-- Settings → Inventory → Count approval. Everyone reads it; only an admin
-- changes it (owner, Q110).
CREATE FUNCTION inv.set_count_approval_by_another(p_actor bigint, p_key uuid, p_version integer, p_on boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.settings;
  s inv.settings;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'set count approval', 'settings', NULL,
                        pg_catalog.jsonb_build_object('version', p_version, 'on', p_on));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO was FROM inv.settings WHERE name = 'count_approval_by_another' FOR UPDATE;
  IF p_version IS DISTINCT FROM was.version THEN
    RAISE EXCEPTION 'Someone else changed count approval since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = inv.setting_json(was)::text;
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'Count approval by a second person is on or off.' USING ERRCODE = 'IV400';
  END IF;
  UPDATE inv.settings SET value = pg_catalog.to_jsonb(p_on) WHERE name = 'count_approval_by_another'
  RETURNING * INTO s;
  RETURN inv.finish_action(a.log_id, NULL, inv.setting_json(was), inv.setting_json(s));
END
$$;

GRANT EXECUTE ON FUNCTION inv.set_count_approval_by_another(bigint, uuid, integer, boolean) TO inv_app;

-- Whatever writes the row (design, "Rules the database enforces"): while
-- the setting is on, a count's approver is nobody who started, saved or
-- submitted it (S5; owner, Q113); and every line of an approved count has
-- the app's number, and a reason when its item is Unmatched (S9), unless
-- the item had nothing recorded before the count (Q118). Who worked
-- on a count is in its log rows, and Matched spans an item's lines, so this
-- is a trigger, not a CHECK. inv.approve_count gives the plain refusals.
CREATE FUNCTION inv.check_count_approval() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (SELECT (value)::boolean FROM inv.settings WHERE name = 'count_approval_by_another')
     AND EXISTS (SELECT FROM inv.activity_log
                  WHERE target_table = 'counts' AND target_id = NEW.id AND actor_id = NEW.approved_by
                    AND action IN ('start count', 'save count', 'submit count')) THEN
    RAISE EXCEPTION 'You worked on this count, so a second person approves it.' USING ERRCODE = 'IV422';
  END IF;
  IF EXISTS (SELECT FROM (SELECT l.item_id, l.expected, l.reason_id, pg_catalog.sum(l.quantity) OVER (PARTITION BY l.item_id) AS counted
                            FROM inv.count_lines l WHERE l.count_id = NEW.id) x
              WHERE x.expected IS NULL
                 OR (x.counted <> x.expected AND x.reason_id IS NULL AND NOT inv.nothing_before(x.item_id, NEW.counted_at))) THEN
    RAISE EXCEPTION 'Every line of an approved count has the app''s number, and a reason when Unmatched.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_approval BEFORE UPDATE OF status ON inv.counts
  FOR EACH ROW WHEN (NEW.status = 'approved') EXECUTE FUNCTION inv.check_count_approval();

-- The entries made during a count for the items it counts (Q33): every
-- ledger row after its moment, up to when it was submitted, but reversals,
-- which follow the entry they undo. Oldest first, each naming its item and
-- the action it came from. Approval asks of each one "Was this item counted
-- after this entry?"; the approval screen lists them (/api/counts/review).
-- net is its quantity with its reversal, if any, added: what a Yes adds to
-- the app's number, so the page shows Matched as approval works it out.
CREATE FUNCTION inv.count_entries(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', g.id, 'item_id', g.item_id, 'item', inv.item_label(i), 'action', a.action,
           'quantity', g.quantity,
           'net', g.quantity + coalesce((SELECT v.quantity FROM inv.ledger v WHERE v.reverses_id = g.id), 0),
           'at', g.effective_at) ORDER BY g.effective_at, g.id), '[]')
    FROM inv.counts c
    JOIN inv.ledger g ON g.item_id IN (SELECT item_id FROM inv.count_lines WHERE count_id = c.id)
                     AND g.effective_at > c.counted_at AND g.effective_at <= c.submitted_at AND g.kind <> 'reversal'
    JOIN inv.items i ON i.id = g.item_id
    JOIN inv.activity_log a ON a.id = g.action_id
   WHERE c.id = p_id
$$;

GRANT EXECUTE ON FUNCTION inv.count_entries(bigint) TO inv_app;

-- What the approval screen reads before Approve: the entries to ask about
-- (Q33) and each counted item's on hand at the count's moment, so the page
-- can show Matched or Unmatched without doing sums (S9), and the items that
-- need no reason (Q118). NULL when no such count.
CREATE FUNCTION inv.count_review(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
           'entries', inv.count_entries(c.id),
           'on_hand', coalesce(pg_catalog.jsonb_object_agg(x.item_id, inv.on_hand_at(x.item_id, c.counted_at))
                                 FILTER (WHERE x.item_id IS NOT NULL), '{}'),
           'nothing_before', coalesce(pg_catalog.jsonb_agg(x.item_id ORDER BY x.item_id)
                                        FILTER (WHERE x.item_id IS NOT NULL AND inv.nothing_before(x.item_id, c.counted_at)), '[]'))
    FROM inv.counts c
    LEFT JOIN (SELECT DISTINCT count_id, item_id FROM inv.count_lines) x ON x.count_id = c.id
   WHERE c.id = p_id
   GROUP BY c.id
$$;

GRANT EXECUTE ON FUNCTION inv.count_review(bigint) TO inv_app;

-- Approve and Reject, one decision each on a waiting count. Refused when the
-- count changed since the screen read it (S41), or when it is not waiting.
-- p_action 'approve count' (stories 69–73), final after the page's warning
-- (S62), writes on each line the app's number for its
-- item at the count's moment, which on hand then starts from (ADR 0002).
-- An item whose lines do not add up to that number is Unmatched and needs a
-- reason from Settings → Reasons (story 71, Q111), unless it had nothing
-- recorded before the count (Q118); a Matched one takes none.
-- 'reject count' (story 74) only ends the count: it never becomes on hand
-- (S6), and the recount is a new count with its own moment (Q112).
CREATE FUNCTION inv.decide_count(p_actor bigint, p_key uuid, p_action text, p_id bigint, p_version integer, p_answers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  c inv.counts;
  was jsonb;
  t record;
  e jsonb;
  v_reason jsonb;
  v_answers jsonb := coalesce(p_answers -> 'counted_after', '{}');
  v_entries jsonb;
BEGIN
  a := inv.claim_action(p_actor, p_key, p_action, 'counts', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version, 'answers', p_answers));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO c FROM inv.counts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That count is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  was := inv.count_json(p_id);
  IF p_version IS DISTINCT FROM c.version THEN
    RAISE EXCEPTION 'Someone else changed this count since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = was::text;
  END IF;
  IF c.status <> 'waiting' THEN
    RAISE EXCEPTION 'Only a count waiting for approval can be approved or rejected.' USING ERRCODE = 'IV422';
  END IF;
  IF p_action = 'approve count' AND EXISTS (
       SELECT FROM inv.counts WHERE family = c.family AND closes = c.closes AND kind = 'monthly' AND status = 'approved') THEN
    RAISE EXCEPTION '% already has an approved monthly count closing %.', was ->> 'family_name',
      pg_catalog.to_char(c.closes, 'FMMonth YYYY') USING ERRCODE = 'IV422';
  END IF;
  IF p_action = 'reject count' THEN
    UPDATE inv.counts SET status = 'rejected', version = version + 1 WHERE id = p_id;
    RETURN inv.finish_action(a.log_id, p_id, was, inv.count_json(p_id));
  END IF;
  IF pg_catalog.jsonb_typeof(v_answers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Answer "Was this item counted after this entry?" entry by entry.' USING ERRCODE = 'IV400';
  END IF;
  v_entries := inv.count_entries(p_id);
  FOR e IN SELECT x FROM pg_catalog.jsonb_array_elements(v_entries) x LOOP
    IF pg_catalog.jsonb_typeof(v_answers -> (e ->> 'id')) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION '%: answer "Was this item counted after this entry?" for the % of %.', e ->> 'item',
        CASE e ->> 'action' WHEN 'receive' THEN 'receipt' WHEN 'correct' THEN 'correction' ELSE e ->> 'action' END,
        e ->> 'quantity' USING ERRCODE = 'IV400';
    END IF;
    IF (v_answers ->> (e ->> 'id'))::boolean THEN
      INSERT INTO inv.count_reflected (count_id, ledger_id) VALUES (p_id, (e ->> 'id')::bigint);
    END IF;
  END LOOP;
  -- Compared as text, so a key no entry could have is refused, never cast.
  IF EXISTS (SELECT FROM pg_catalog.jsonb_object_keys(v_answers) k
              WHERE NOT EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(v_entries) x WHERE x ->> 'id' = k)) THEN
    RAISE EXCEPTION 'Answer only for the entries listed.' USING ERRCODE = 'IV400';
  END IF;
  -- The app's number: on hand at the count's moment, plus the entries the
  -- item was counted after (and their reversals), which the count holds.
  UPDATE inv.count_lines l SET expected = inv.on_hand_at(l.item_id, c.counted_at)
         + coalesce((SELECT pg_catalog.sum(g.quantity) FROM inv.ledger g JOIN inv.count_reflected r
                       ON r.count_id = p_id AND r.ledger_id IN (g.id, g.reverses_id)
                      WHERE g.item_id = l.item_id), 0)
   WHERE l.count_id = p_id;
  FOR t IN SELECT l.item_id, inv.item_label(i) AS item, pg_catalog.sum(l.quantity) AS counted, pg_catalog.min(l.expected) AS expected
             FROM inv.count_lines l JOIN inv.items i ON i.id = l.item_id
            WHERE l.count_id = p_id GROUP BY l.item_id, i.id ORDER BY pg_catalog.min(l.id) LOOP
    v_reason := p_answers -> 'reasons' -> t.item_id::text;
    IF t.counted = t.expected AND inv.is_given(v_reason) THEN
      RAISE EXCEPTION '% is Matched, so it takes no reason.', t.item USING ERRCODE = 'IV400';
    END IF;
    CONTINUE WHEN t.counted = t.expected;
    IF NOT inv.is_given(v_reason) THEN
      CONTINUE WHEN inv.nothing_before(t.item_id, c.counted_at);
      RAISE EXCEPTION '% is Unmatched: counted %, the app had %. Pick a reason.', t.item, t.counted, t.expected
        USING ERRCODE = 'IV400';
    END IF;
    -- One that is not a number is not on the list either.
    PERFORM inv.checked_reason(CASE WHEN inv.is_whole_above_zero(v_reason) THEN (v_reason #>> '{}')::bigint END, t.item);
    UPDATE inv.count_lines SET reason_id = (v_reason #>> '{}')::bigint WHERE count_id = p_id AND item_id = t.item_id;
  END LOOP;
  -- Two approvals of the same family and month at the same moment both pass
  -- the check above; the unique index stops the second, with the same words.
  BEGIN
    UPDATE inv.counts SET status = 'approved', approved_at = pg_catalog.now(), approved_by = p_actor, version = version + 1
     WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION '% already has an approved monthly count closing %.', was ->> 'family_name',
      pg_catalog.to_char(c.closes, 'FMMonth YYYY') USING ERRCODE = 'IV422';
  END;
  RETURN inv.finish_action(a.log_id, p_id, was, inv.count_json(p_id));
END
$$;

-- Inventory → Count → a waiting count → Approve.
--   p_answers  {"reasons": {item id: reason id}}, for each Unmatched item.
CREATE FUNCTION inv.approve_count(p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_answers jsonb)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.decide_count(p_actor, p_key, 'approve count', p_id, p_version, p_answers) $$;

-- Inventory → Count → a waiting count → Reject.
CREATE FUNCTION inv.reject_count(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.decide_count(p_actor, p_key, 'reject count', p_id, p_version, NULL) $$;

GRANT EXECUTE ON FUNCTION inv.reject_count(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.approve_count(bigint, uuid, bigint, integer, jsonb) TO inv_app;

-- An approved or rejected count never changes, and no count is ever
-- removed, whatever writes the row (S75; design, "Nothing is lost"): only a
-- correction changes an approved count. Its lines are held by
-- inv.check_count_line.
CREATE FUNCTION inv.check_count_decided() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'This count is % and stays as it is.', CASE WHEN TG_OP = 'DELETE' THEN 'on the record' ELSE OLD.status END
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_decided BEFORE UPDATE OR DELETE ON inv.counts
  FOR EACH ROW EXECUTE FUNCTION inv.check_count_decided();
