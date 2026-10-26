// Inventory → Overview → an item (#112): the committed jobs that make up the
// item's Committed figure. Each job's quantity is what inv.job_to_consume says
// Shipped would still consume of the item, the way inv.job_committed sums it,
// so the list adds up to Committed. A built job lists only under the
// families consumed at Shipped, and a family not live in Inventory lists none.

// Quantities are pieces; the page shows them in the item's order unit.
const ITEM_JOBS = `
  SELECT j.number, j.name, pg_catalog.to_char(j.delivery_date, 'YYYY-MM-DD') AS delivery_date, c.quantity
    FROM inv.jobs j CROSS JOIN LATERAL inv.job_to_consume(j, 'shipped') c
   WHERE j.status IN ('committed', 'built') AND c.live AND c.item_id = $1
   ORDER BY j.delivery_date NULLS LAST, j.number`;

// Answers { error } for an item not in the catalog, else { jobs }.
async function readItemJobs(database, id) {
  const known = /^\d{1,18}$/.test(id ?? '') && (await database.read('SELECT 1 FROM inv.items WHERE id = $1', [id])).length;
  if (!known) return { error: 'That item is not in the catalog.' };
  return { jobs: await database.read(ITEM_JOBS, [id]) };
}

module.exports = { readItemJobs };
