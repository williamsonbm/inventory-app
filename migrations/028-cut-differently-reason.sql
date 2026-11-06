-- #187: the built-in reason "Cut differently than planned". Source: spec
-- #178, story 40; owner #187 Q76–Q77. Every name is fully qualified (#28).
--
-- Reach: one new reason, built in and with no entry, so it is picked
-- wherever a reason is and cannot be retired. A reason a person already
-- added with this text, in any capitals, becomes it: its id and records
-- stay, its text takes these capitals, and it is back in use if retired
-- (Q77). Unlike 021's Substitution, which stops, this is safe: with no
-- entry, nothing restricts where the reason is used.
-- Recovery: before anything names it, delete the row. After a record
-- names it, keep it.

INSERT INTO inv.reasons (text, built_in) VALUES ('Cut differently than planned', true)
  ON CONFLICT ((pg_catalog.lower(text)))
  DO UPDATE SET text = EXCLUDED.text, active = true, built_in = true;
