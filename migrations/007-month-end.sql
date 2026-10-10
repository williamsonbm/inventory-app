-- Step 3, part 3 (#81), group F (stories 83–88): the month-end record, its
-- revisions and its CSV, and last counted in the one calculation (#81
-- "Database"). A new file, not 006: the owner's own database has already
-- run 006, and an edit there would reach it only through a reset (Q157).
-- Follows migration 001: every change is a SECURITY DEFINER function that
-- starts with inv.claim_action and ends with inv.finish_action; every name is
-- fully qualified; every refusal carries an IV code (listed in 001).

-- A month-end record's revisions (design table 14, S11; stories 85, 86):
-- an approved monthly count is revision 1, and each correction adds the
-- next number, shared by every item it changes, with one why. A row holds
-- an item's corrected quantity, in pieces; the item may be one the count
-- missed. Was is the previous revision's figure, and who and when come from
-- the action's log row. The count and its lines never change, so the
-- original stays.
CREATE TABLE inv.count_corrections (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id  bigint NOT NULL REFERENCES inv.counts (id),
  revision  integer NOT NULL CHECK (revision >= 2),
  item_id   bigint NOT NULL REFERENCES inv.items (id),
  quantity  integer NOT NULL CHECK (quantity >= 0),
  why       text NOT NULL CHECK (why = inv.tidy(why) AND why <> ''),
  action_id bigint NOT NULL REFERENCES inv.activity_log (id),
  UNIQUE (count_id, item_id, revision)
);

CREATE INDEX count_corrections_item_idx ON inv.count_corrections (item_id);

-- Only a month-end record is corrected, and only with an item of its
-- family, whatever writes the row.
CREATE FUNCTION inv.check_count_correction() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM inv.counts c JOIN inv.items i ON i.family = c.family
                  WHERE c.id = NEW.count_id AND c.status = 'approved' AND c.kind = 'monthly' AND i.id = NEW.item_id) THEN
    RAISE EXCEPTION 'Only an approved monthly count is corrected, with items of its family.' USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_correction BEFORE INSERT ON inv.count_corrections
  FOR EACH ROW EXECUTE FUNCTION inv.check_count_correction();

-- What an approved count found of an item: its newest correction, or its
-- lines added up; null when the count has neither (it left the item out).
-- p_below gives it as it stood before that revision: a correction's was.
-- Deliberately plpgsql, as is inv.base_count: Postgres keeps a plpgsql
-- function's plans for the session, but plans a SQL function with SET
-- search_path again on every call, and inv.item_figures calls these once
-- per item. As SQL, the Overview's figures took 2.4 s, not 0.6 s (3,000
-- items, a year of monthly counts; 006 alone: 0.24 s).
CREATE FUNCTION inv.count_found(p_count_id bigint, p_item_id bigint, p_below integer DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN coalesce(
    (SELECT x.quantity FROM inv.count_corrections x WHERE x.count_id = p_count_id AND x.item_id = p_item_id
        AND x.revision < coalesce(p_below, 2147483647)
      ORDER BY x.revision DESC LIMIT 1),
    (SELECT pg_catalog.sum(l.quantity) FROM inv.count_lines l WHERE l.count_id = p_count_id AND l.item_id = p_item_id));
END
$$;

-- An item's latest approved count up to p_at that includes it, by moment:
-- the count, when it was counted, and what it found of the item, at its
-- newest revision (design, "How the numbers are calculated"). On hand
-- starts from it, and its moment is the item's last counted, so the two
-- never disagree. A count includes an item it has a line or a correction
-- for. No row when no approved count includes the item.
CREATE FUNCTION inv.base_count(p_item_id bigint, p_at timestamptz)
RETURNS TABLE (count_id bigint, counted_at timestamptz, quantity bigint)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT b.id, b.counted_at, inv.count_found(b.id, p_item_id)
    FROM (SELECT c.id, c.counted_at
            FROM inv.counts c
           WHERE c.status = 'approved' AND c.counted_at <= p_at
             AND c.id IN (SELECT l.count_id FROM inv.count_lines l WHERE l.item_id = p_item_id
                          UNION ALL
                          SELECT x.count_id FROM inv.count_corrections x WHERE x.item_id = p_item_id)
           ORDER BY c.counted_at DESC, c.id DESC
           LIMIT 1) b;
END
$$;

-- 005's, starting from inv.base_count.
CREATE OR REPLACE FUNCTION inv.on_hand_at(p_item_id bigint, p_at timestamptz) RETURNS integer
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH base AS (SELECT * FROM inv.base_count(p_item_id, p_at))
  SELECT (coalesce((SELECT quantity FROM base), 0)
          + coalesce((SELECT pg_catalog.sum(g.quantity) FROM inv.ledger g
                       WHERE g.item_id = p_item_id AND g.effective_at <= p_at
                         AND g.effective_at > coalesce((SELECT counted_at FROM base), '-infinity')
                         AND NOT EXISTS (SELECT FROM inv.count_reflected r
                                          WHERE r.count_id = (SELECT count_id FROM base)
                                            AND r.ledger_id IN (g.id, g.reverses_id))), 0))::integer
$$;

-- 005's view, with last counted (counted_at) added at the end, as CREATE OR
-- REPLACE VIEW requires. The Overview and the month-end CSV read it.
CREATE OR REPLACE VIEW inv.item_figures AS
SELECT d.item_id, d.incoming, d.on_hand, d.depth_lf,
       CASE WHEN d.on_hand < 0 THEN 'Short'
            WHEN d.on_hand <= d.threshold OR d.depth_lf <= t.threshold_lf THEN 'Low'
            ELSE 'OK' END AS reorder,
       d.counted_at
  FROM (SELECT f.*,
               CASE WHEN f.family = 'lvl'
                    THEN pg_catalog.sum(f.on_hand * f.length_ft) OVER (PARTITION BY f.family, f.size)::integer END AS depth_lf
          FROM (SELECT i.id AS item_id, i.family, i.size, i.length_ft, i.threshold,
                       coalesce(pg_catalog.sum(GREATEST(l.ordered - inv.received(l.id), 0)), 0)::integer AS incoming,
                       inv.on_hand_at(i.id, 'infinity') AS on_hand,
                       (SELECT b.counted_at FROM inv.base_count(i.id, 'infinity') b) AS counted_at
                  FROM inv.items i
                  LEFT JOIN inv.po_lines l ON l.item_id = i.id AND l.closed_reason_id IS NULL
                 GROUP BY i.id) f) d
  LEFT JOIN inv.lvl_depth_thresholds t ON d.family = 'lvl' AND t.depth = d.size;

-- inv.item_figures reads them, as the app's login.
GRANT EXECUTE ON FUNCTION inv.base_count(bigint, timestamptz) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.count_found(bigint, bigint, integer) TO inv_app;

-- A month-end record (stories 83, 85–87): an approved monthly count, at its
-- newest revision, in the shape the Month-end page, the CSV and the log
-- read. identity names the family's identity fields, in order, and each
-- line carries them (the CSV's first columns); quantity is the item's
-- figure at the newest revision. Lines keep the count's order; an item a
-- correction added comes after them. revisions lists each correction: who,
-- when, why, and was → now for each item it changed (was is null for an
-- item the count missed). Null for any other count.
CREATE FUNCTION inv.month_end_json(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', c.id, 'family', c.family, 'family_name', f.name, 'closes', pg_catalog.to_char(c.closes, 'YYYY-MM'),
    'counted_at', c.counted_at, 'identity', pg_catalog.to_jsonb(f.identity),
    'revision', coalesce((SELECT pg_catalog.max(revision) FROM inv.count_corrections WHERE count_id = c.id), 1),
    'lines', (SELECT coalesce(pg_catalog.jsonb_agg(
                pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                  'item_id', i.id, 'item', inv.item_label(i), 'sku', i.sku, 'product', i.product, 'size', i.size,
                  'grade', i.grade, 'length_ft', i.length_ft))
                || pg_catalog.jsonb_build_object('quantity', inv.count_found(c.id, i.id)) ORDER BY o.first), '[]')
                FROM (SELECT item_id, pg_catalog.min(rank) AS first
                        FROM (SELECT item_id, ARRAY[0, id] AS rank FROM inv.count_lines WHERE count_id = c.id
                              UNION ALL
                              SELECT item_id, ARRAY[1, id] FROM inv.count_corrections WHERE count_id = c.id) r
                       GROUP BY item_id) o
                JOIN inv.items i ON i.id = o.item_id),
    'revisions', (SELECT coalesce(pg_catalog.jsonb_agg(v ORDER BY v -> 'revision'), '[]') FROM (
                    SELECT pg_catalog.jsonb_build_object('revision', x.revision, 'by', u.name, 'at', a.at, 'why', pg_catalog.min(x.why),
                             'changes', pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                               'item_id', x.item_id, 'item', inv.item_label(i),
                               'was', inv.count_found(c.id, x.item_id, x.revision),
                               'now', x.quantity) ORDER BY x.id)) AS v
                      FROM inv.count_corrections x
                      JOIN inv.activity_log a ON a.id = x.action_id
                      JOIN inv.users u ON u.id = a.actor_id
                      JOIN inv.items i ON i.id = x.item_id
                     WHERE x.count_id = c.id
                     GROUP BY x.revision, a.id, u.name) r))
    FROM inv.counts c JOIN inv.families f ON f.code = c.family
   WHERE c.id = p_id AND c.status = 'approved' AND c.kind = 'monthly'
$$;

GRANT EXECUTE ON FUNCTION inv.month_end_json(bigint) TO inv_app;

INSERT INTO inv.actions (name, admin_only) VALUES ('correct month-end', true);

-- Inventory → Month-end → a record → Correct (stories 85, 86; S11): the
-- next revision of the record. Admin only (#81, "Admin-only actions").
--   p_revision  the revision the screen read; an older one is refused (S41).
--   p_why       why, required, one for the whole revision.
--   p_lines     [{item_id, quantity}], quantity in pieces; an item the
--               count missed may be added. A line that matches the record
--               is not part of the revision; none changed is refused.
CREATE FUNCTION inv.correct_month_end(p_actor bigint, p_key uuid, p_id bigint, p_revision integer, p_why text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  c inv.counts;
  i inv.items;
  was jsonb;
  r jsonb;
  n integer;
  v_why text := inv.tidy(p_why);
  v_seen bigint[] := '{}';
BEGIN
  a := inv.claim_action(p_actor, p_key, 'correct month-end', 'counts', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'revision', p_revision, 'why', p_why, 'lines', p_lines));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO c FROM inv.counts WHERE id = p_id FOR UPDATE;
  was := inv.month_end_json(p_id);
  IF was IS NULL THEN
    RAISE EXCEPTION 'Only an approved monthly count is a month-end record.' USING ERRCODE = 'IV422';
  END IF;
  IF p_revision IS DISTINCT FROM (was ->> 'revision')::integer THEN
    RAISE EXCEPTION 'Someone else corrected this month-end record since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = was::text;
  END IF;
  IF coalesce(v_why, '') = '' THEN
    RAISE EXCEPTION 'Say why the record is corrected.' USING ERRCODE = 'IV400';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A correction lists its items.' USING ERRCODE = 'IV400';
  END IF;
  FOR r, n IN SELECT x, o FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS e(x, o) LOOP
    i := NULL;
    IF inv.is_whole_above_zero(r -> 'item_id') THEN
      SELECT * INTO i FROM inv.items WHERE id = (r ->> 'item_id')::bigint AND family = c.family;
    END IF;
    IF i.id IS NULL THEN
      RAISE EXCEPTION 'Line %: pick a % item from the catalog.', n, was ->> 'family_name' USING ERRCODE = 'IV400';
    END IF;
    IF i.id = ANY (v_seen) THEN
      RAISE EXCEPTION '% is listed twice.', inv.item_label(i) USING ERRCODE = 'IV400';
    END IF;
    v_seen := v_seen || i.id;
    IF NOT inv.is_whole_zero_or_more(r -> 'quantity') THEN
      RAISE EXCEPTION '%: the quantity is a whole number of pieces, 0 or more.', inv.item_label(i) USING ERRCODE = 'IV400';
    END IF;
    IF inv.count_found(p_id, i.id) IS DISTINCT FROM (r ->> 'quantity')::bigint THEN
      INSERT INTO inv.count_corrections (count_id, revision, item_id, quantity, why, action_id)
      VALUES (p_id, p_revision + 1, i.id, (r ->> 'quantity')::integer, v_why, a.log_id);
    END IF;
  END LOOP;
  RETURN inv.finish_action(a.log_id, p_id, was, inv.month_end_json(p_id));
END
$$;

GRANT EXECUTE ON FUNCTION inv.correct_month_end(bigint, uuid, bigint, integer, text, jsonb) TO inv_app;

-- A monthly count is submitted only for a month that has no month-end
-- record yet (owner, Q142): the counter learns it at Submit, while the month
-- can still be changed on the sheet (story 65), not at Approve. The page
-- warns from the start; inv.decide_count and counts_one_approved_monthly
-- still guard approval.
CREATE FUNCTION inv.check_month_open() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.kind = 'monthly' AND EXISTS (
       SELECT FROM inv.counts WHERE family = NEW.family AND closes = NEW.closes AND kind = 'monthly' AND status = 'approved') THEN
    RAISE EXCEPTION '% already has an approved monthly count closing %. Change the month before you submit.',
      (SELECT name FROM inv.families WHERE code = NEW.family), pg_catalog.to_char(NEW.closes, 'FMMonth YYYY')
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_month_open BEFORE UPDATE OF status ON inv.counts
  FOR EACH ROW WHEN (NEW.status = 'waiting' AND OLD.status <> 'waiting')
  EXECUTE FUNCTION inv.check_month_open();
