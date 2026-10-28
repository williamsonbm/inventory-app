-- #131 (spec #127): a lumber PO line's amount is a whole number of pieces.
-- The Receive page fills LF, board feet and pieces from any one of them and
-- saves LF; this is the guarantee, whatever writes the row. Source: spec
-- #127, owner J244–J246. Every name is fully qualified (#28).
--
-- Reach: inv.check_po_line_amount (017) also refuses a new or changed LF
-- amount that is not a whole number of the item's lengths. No row changes:
-- a line saved before keeps its amount while its other fields change. Same
-- signature and trigger.
-- Recovery: rerun 017's inv.check_po_line_amount as CREATE OR REPLACE.

-- 017's function, with whole pieces for a family ordered in linear feet
-- (inv.families.order_unit): on a new line, or when the amount or the item
-- changes. The line number counts the PO's lines saved before this one, as
-- inv.po_line_number does, so a new line is numbered as on the page.
-- Otherwise as 017.
CREATE OR REPLACE FUNCTION inv.check_po_line_amount() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f inv.families;
  i inv.items;
  v_pieces integer;
BEGIN
  SELECT * INTO i FROM inv.items WHERE id = NEW.item_id;
  -- No such item: the foreign key refuses the row, as it did before 019.
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO f FROM inv.families WHERE code = i.family;
  IF NEW.ordered IS NULL THEN
    IF NOT f.amount_optional THEN
      RAISE EXCEPTION 'A % PO line needs its amount ordered.', f.name USING ERRCODE = 'IV422';
    END IF;
    RETURN NEW;
  END IF;
  IF f.order_unit <> 'linear feet' OR NEW.ordered % i.length_ft = 0
     OR TG_OP = 'UPDATE' AND (NEW.item_id, NEW.ordered) IS NOT DISTINCT FROM (OLD.item_id, OLD.ordered) THEN
    RETURN NEW;
  END IF;
  v_pieces := NEW.ordered / i.length_ft;
  RAISE EXCEPTION 'Line %: % LF of % is not a whole number of pieces. %.',
    (SELECT pg_catalog.count(*) + 1 FROM inv.po_lines x WHERE x.po_id = NEW.po_id AND x.id < NEW.id),
    NEW.ordered, inv.item_label(i),
    CASE WHEN v_pieces = 0 THEN 'One piece is ' || i.length_ft || ' LF'
         ELSE v_pieces * i.length_ft || ' LF is ' || v_pieces || CASE WHEN v_pieces = 1 THEN ' piece' ELSE ' pieces' END END
    USING ERRCODE = 'IV422';
END
$$;
