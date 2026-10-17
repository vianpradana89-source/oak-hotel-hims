/**
 * PHASE B3 — Direct test of projectPosOrderToTransaction.
 *
 * Creates a POS order with service+tax via API (B2 path),
 * then calls projectPosOrderToTransaction directly and verifies
 * the transactions row has correct service_amount, tax_amount,
 * amount, discount_amount, net_amount, and invariant holds.
 *
 * Also tests:
 *  - legacy order (svc/tax=0)
 *  - re-projection idempotency
 *  - ON CONFLICT path (second projection)
 *  - reversal (void)
 *  - invariant rejection (mismatch)
 */
const { Pool } = require('pg');
const { projectPosOrderToTransaction } =
  require('../dist/domains/transactions/transactionService.js');
// Strictly restricted to the disposable local PostgreSQL test instance.
function disposablePgConfig() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL required for disposable B3 test');
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid TEST_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== '127.0.0.1' || url.port !== '15434' ||
      decodeURIComponent(url.username) !== 'minibar_test' ||
      decodeURIComponent(url.pathname) !== '/oak_minibar_test' ||
      !url.password || url.search || url.hash) {
    throw new Error('B3 test refuses any non-disposable database target');
  }
  return {
    host: '127.0.0.1', port: 15434, user: 'minibar_test',
    password: decodeURIComponent(url.password), database: 'oak_minibar_test'
  };
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS | ' + msg); }
  else { failed++; console.log('  FAIL | ' + msg); }
}

async function main() {
  const PG = disposablePgConfig();
  const pool = new Pool(PG);
  const tracked = { properties: [], menuItems: [], categories: [], posOrders: [], transactions: [], settings: [] };
  let cleanupFailed = false;

  try {
    // Check actual database identity and connection before any fixture write.
    const connection = await pool.connect();
    try {
      if (connection.connectionParameters.host !== PG.host ||
          Number(connection.connectionParameters.port) !== PG.port ||
          connection.connectionParameters.user !== PG.user ||
          connection.connectionParameters.database !== PG.database) {
        throw new Error('B3 pool connection does not match disposable database guard');
      }
      const identity = await connection.query('SELECT current_database() AS db, current_user AS db_user');
      if (identity.rows[0]?.db !== PG.database || identity.rows[0]?.db_user !== PG.user) {
        throw new Error('B3 database identity verification failed');
      }
    } finally {
      connection.release();
    }

  // Create the main test property + menu + settings
  const propR = await pool.query(
    `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
     VALUES ('B3PROP', 'B3PRP', 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`
  );
  const pid = Number(propR.rows[0].id);
  tracked.properties.push(pid);
  const catR = await pool.query(`INSERT INTO pos_menu_categories (property_id, name) VALUES ($1,'B3 Cat') RETURNING id`, [pid]);
  tracked.categories.push(Number(catR.rows[0].id));
  const itemR = await pool.query(
    `INSERT INTO pos_menu_items (property_id, category_id, item_code, name, price, is_active)
     VALUES ($1,$2,'B3-ITEM', 'B3 Item', 100000, TRUE) RETURNING id`,
    [pid, catR.rows[0].id]
  );
  const itemId = Number(itemR.rows[0].id);
  tracked.menuItems.push(itemId);

  // Create pricing settings: service 10%, tax 11%
  const settingsR = await pool.query(
    `INSERT INTO property_pos_pricing_settings
       (property_id, service_charge_enabled, service_charge_percent, tax_enabled, tax_percent, updated_at)
     VALUES ($1, TRUE, 10.0, TRUE, 11.0, NOW()) RETURNING id`,
    [pid]
  );
  tracked.settings.push(Number(settingsR.rows[0].id));

  // All fixture setup and scenarios are guarded by the outer try/finally.

    // ── Scenario 1: Legacy order (svc=0, tax=0) ──────────────────────────────
    console.log('\n── Scenario 1: Legacy order (service/tax OFF) ──');
    // Set pricing to OFF
    await pool.query(
      `UPDATE property_pos_pricing_settings SET service_charge_enabled=FALSE, tax_enabled=FALSE WHERE property_id=$1`, [pid]);

    // Create pos_order directly via DB (Bypass B2 API to test legacy path)
    const orderR = await pool.query(
      `INSERT INTO pos_orders
         (property_id, order_number, table_number, guest_name, status, total_amount, discount_amount,
          service_amount, tax_amount, service_charge_percent_snapshot, tax_percent_snapshot,
          service_charge_enabled_snapshot, tax_enabled_snapshot, created_at, updated_at)
       VALUES
         ($1, 'POS-B3-L1', 'Meja 1', 'Legacy Guest', 'PAID', 200000, 0,
          0, 0, 0, 0, FALSE, FALSE, NOW(), NOW())
       RETURNING id`,
      [pid]
    );
    const legacyOrderId = Number(orderR.rows[0].id);
    tracked.posOrders.push(legacyOrderId);
    // Insert items: 2 × 100000 = 200000
    await pool.query(
      `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, discount_amount, item_name_snapshot, item_code_snapshot)
       VALUES ($1, $2, 2, 100000, 0, 'B3 ITEM', 'B3-ITEM')`,
      [legacyOrderId, itemId]
    );

    const legacyTx = await projectPosOrderToTransaction(pool, legacyOrderId, { propertyId: pid });
    assert(legacyTx !== null, '(1) Legacy projection returns tx');
    if (legacyTx) {
      tracked.transactions.push(legacyTx.id);
      assert(Number(legacyTx.amount) === 200000, `(1) amount = 200000 (got ${legacyTx.amount})`);
      assert(Number(legacyTx.discount_amount) === 0, `(1) discount = 0 (got ${legacyTx.discount_amount})`);
      assert(Number(legacyTx.service_amount) === 0, `(1) service = 0 (got ${legacyTx.service_amount})`);
      assert(Number(legacyTx.tax_amount) === 0, `(1) tax = 0 (got ${legacyTx.tax_amount})`);
      assert(Number(legacyTx.net_amount) === 200000, `(1) net = 200000 (got ${legacyTx.net_amount})`);
      const inv = Number(legacyTx.amount) - Number(legacyTx.discount_amount) +
                  Number(legacyTx.service_amount) + Number(legacyTx.tax_amount);
      assert(inv === Number(legacyTx.net_amount), `(1) invariant: ${inv} == net ${legacyTx.net_amount}`);
    }

    // ── Scenario 2: Service-only order ──────────────────────────────────────
    console.log('\n── Scenario 2: Service-only (svc=10%, tax=OFF) ──');
    await pool.query(
      `UPDATE property_pos_pricing_settings SET service_charge_enabled=TRUE, service_charge_percent=10.0,
       tax_enabled=FALSE WHERE property_id=$1`, [pid]);

    const order2R = await pool.query(
      `INSERT INTO pos_orders
         (property_id, order_number, table_number, guest_name, status, total_amount, discount_amount,
          service_amount, tax_amount, service_charge_percent_snapshot, tax_percent_snapshot,
          service_charge_enabled_snapshot, tax_enabled_snapshot, created_at, updated_at)
       VALUES
         ($1, 'POS-B3-S2', 'Meja 2', 'Svc Guest', 'PAID', 110000, 0,
          10000, 0, 10.0, 0, TRUE, FALSE, NOW(), NOW())
       RETURNING id`,
      [pid]
    );
    const order2Id = Number(order2R.rows[0].id);
    tracked.posOrders.push(order2Id);
    // 1 × 100000 = 100000 gross; svc = 10% × 100000 = 10000; total = 110000
    await pool.query(
      `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, discount_amount, item_name_snapshot, item_code_snapshot)
       VALUES ($1, $2, 1, 100000, 0, 'B3 ITEM', 'B3-ITEM')`,
      [order2Id, itemId]
    );

    const svcTx = await projectPosOrderToTransaction(pool, order2Id, { propertyId: pid });
    assert(svcTx !== null, '(2) Svc-only projection returns tx');
    if (svcTx) {
      tracked.transactions.push(svcTx.id);
      assert(Number(svcTx.amount) === 100000, `(2) amount = 100000 (got ${svcTx.amount})`);
      assert(Number(svcTx.service_amount) === 10000, `(2) service = 10000 (got ${svcTx.service_amount})`);
      assert(Number(svcTx.tax_amount) === 0, `(2) tax = 0 (got ${svcTx.tax_amount})`);
      assert(Number(svcTx.net_amount) === 110000, `(2) net = 110000 (got ${svcTx.net_amount})`);
      const inv = Number(svcTx.amount) - Number(svcTx.discount_amount) +
                  Number(svcTx.service_amount) + Number(svcTx.tax_amount);
      assert(inv === Number(svcTx.net_amount), `(2) invariant: ${inv} == net ${svcTx.net_amount}`);
    }

    // ── Scenario 3: Tax-only order ───────────────────────────────────────────
    console.log('\n── Scenario 3: Tax-only (svc=OFF, tax=11%) ──');
    await pool.query(
      `UPDATE property_pos_pricing_settings SET service_charge_enabled=FALSE,
       tax_enabled=TRUE, tax_percent=11.0 WHERE property_id=$1`, [pid]);

    // 1 × 100000; tax = 11% × 100000 = 11000; total = 111000
    const order3R = await pool.query(
      `INSERT INTO pos_orders
         (property_id, order_number, table_number, guest_name, status, total_amount, discount_amount,
          service_amount, tax_amount, service_charge_percent_snapshot, tax_percent_snapshot,
          service_charge_enabled_snapshot, tax_enabled_snapshot, created_at, updated_at)
       VALUES
         ($1, 'POS-B3-S3', 'Meja 3', 'Tax Guest', 'PAID', 111000, 0,
          0, 11000, 0, 11.0, FALSE, TRUE, NOW(), NOW())
       RETURNING id`,
      [pid]
    );
    const order3Id = Number(order3R.rows[0].id);
    tracked.posOrders.push(order3Id);
    await pool.query(
      `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, discount_amount, item_name_snapshot, item_code_snapshot)
       VALUES ($1, $2, 1, 100000, 0, 'B3 ITEM', 'B3-ITEM')`,
      [order3Id, itemId]
    );

    const taxTx = await projectPosOrderToTransaction(pool, order3Id, { propertyId: pid });
    assert(taxTx !== null, '(3) Tax-only projection returns tx');
    if (taxTx) {
      tracked.transactions.push(taxTx.id);
      assert(Number(taxTx.amount) === 100000, `(3) amount = 100000 (got ${taxTx.amount})`);
      assert(Number(taxTx.tax_amount) === 11000, `(3) tax = 11000 (got ${taxTx.tax_amount})`);
      assert(Number(taxTx.net_amount) === 111000, `(3) net = 111000 (got ${taxTx.net_amount})`);
    }

    // ── Scenario 4: Combined service+tax ─────────────────────────────────────
    console.log('\n── Scenario 4: Combined svc+tax (svc=10%, tax=11%) ──');
    await pool.query(
      `UPDATE property_pos_pricing_settings SET service_charge_enabled=TRUE, service_charge_percent=10.0,
       tax_enabled=TRUE, tax_percent=11.0 WHERE property_id=$1`, [pid]);

    // 1 × 100000; svc=10000; tax base=110000; tax=12100; total=122100
    const order4R = await pool.query(
      `INSERT INTO pos_orders
         (property_id, order_number, table_number, guest_name, status, total_amount, discount_amount,
          service_amount, tax_amount, service_charge_percent_snapshot, tax_percent_snapshot,
          service_charge_enabled_snapshot, tax_enabled_snapshot, created_at, updated_at)
       VALUES
         ($1, 'POS-B3-S4', 'Meja 4', 'Combo Guest', 'PAID', 122100, 0,
          10000, 12100, 10.0, 11.0, TRUE, TRUE, NOW(), NOW())
       RETURNING id`,
      [pid]
    );
    const order4Id = Number(order4R.rows[0].id);
    tracked.posOrders.push(order4Id);
    await pool.query(
      `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, discount_amount, item_name_snapshot, item_code_snapshot)
       VALUES ($1, $2, 1, 100000, 0, 'B3 ITEM', 'B3-ITEM')`,
      [order4Id, itemId]
    );

    const comboTx = await projectPosOrderToTransaction(pool, order4Id, { propertyId: pid });
    assert(comboTx !== null, '(4) Combined svc+tax projection returns tx');
    if (comboTx) {
      tracked.transactions.push(comboTx.id);
      assert(Number(comboTx.amount) === 100000, `(4) amount = 100000 (got ${comboTx.amount})`);
      assert(Number(comboTx.service_amount) === 10000, `(4) service = 10000 (got ${comboTx.service_amount})`);
      assert(Number(comboTx.tax_amount) === 12100, `(4) tax = 12100 (got ${comboTx.tax_amount})`);
      assert(Number(comboTx.net_amount) === 122100, `(4) net = 122100 (got ${comboTx.net_amount})`);
      const inv = Number(comboTx.amount) - Number(comboTx.discount_amount) +
                  Number(comboTx.service_amount) + Number(comboTx.tax_amount);
      assert(inv === Number(comboTx.net_amount), `(4) invariant: ${inv} == net ${comboTx.net_amount}`);
    }

    // ── Scenario 5: Item+order discount with svc+tax ─────────────────────────
    console.log('\n── Scenario 5: Item+order discount with svc+tax ──');
    // 2 × 100000 = 200000 gross; item discount = 20000 (each line 10000);
    // after item = 180000; order discount = 5000; discounted subtotal = 175000;
    // svc = 10% × 175000 = 17500; tax base = 175000+17500=192500; tax = 11%×192500=21175;
    // total = 175000+17500+21175 = 213675
    const order5R = await pool.query(
      `INSERT INTO pos_orders
         (property_id, order_number, table_number, guest_name, status, total_amount, discount_amount,
          service_amount, tax_amount, service_charge_percent_snapshot, tax_percent_snapshot,
          service_charge_enabled_snapshot, tax_enabled_snapshot, discount_type, discount_value,
          created_at, updated_at)
       VALUES
         ($1, 'POS-B3-S5', 'Meja 5', 'Disc Guest', 'PAID', 213675, 5000,
          17500, 21175, 10.0, 11.0, TRUE, TRUE, 'NOMINAL', 5000, NOW(), NOW())
       RETURNING id`,
      [pid]
    );
    const order5Id = Number(order5R.rows[0].id);
    tracked.posOrders.push(order5Id);
    // 2 items × 100000 = 200000, each line discount 10000 → items_discount = 20000
    await pool.query(
      `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, discount_amount, item_name_snapshot, item_code_snapshot)
       VALUES ($1, $2, 1, 100000, 10000, 'B3 ITEM', 'B3-ITEM'),
              ($1, $2, 1, 100000, 10000, 'B3 ITEM', 'B3-ITEM')`,
      [order5Id, itemId]
    );

    const discTx = await projectPosOrderToTransaction(pool, order5Id, { propertyId: pid });
    assert(discTx !== null, '(5) Discount+svc+tax projection returns tx');
    if (discTx) {
      tracked.transactions.push(discTx.id);
      assert(Number(discTx.amount) === 200000, `(5) amount (gross) = 200000 (got ${discTx.amount})`);
      // total discount = item(20000) + order(5000) = 25000
      assert(Number(discTx.discount_amount) === 25000, `(5) discount = 25000 (got ${discTx.discount_amount})`);
      assert(Number(discTx.service_amount) === 17500, `(5) service = 17500 (got ${discTx.service_amount})`);
      assert(Number(discTx.tax_amount) === 21175, `(5) tax = 21175 (got ${discTx.tax_amount})`);
      assert(Number(discTx.net_amount) === 213675, `(5) net = 213675 (got ${discTx.net_amount})`);
      const inv = Number(discTx.amount) - Number(discTx.discount_amount) +
                  Number(discTx.service_amount) + Number(discTx.tax_amount);
      assert(inv === Number(discTx.net_amount), `(5) invariant: ${inv} == net ${discTx.net_amount}`);
    }

    // ── Scenario 6: Re-projection idempotency ────────────────────────────────
    console.log('\n── Scenario 6: Re-projection (ON CONFLICT / existing UPDATE) ──');
    const reprojTx = await projectPosOrderToTransaction(pool, order4Id, { propertyId: pid });
    assert(reprojTx !== null, '(6) Re-projection returns tx');
    if (reprojTx) {
      assert(String(reprojTx.id) === String(comboTx.id), `(6) same tx id (got ${reprojTx.id} vs ${comboTx.id})`);
      assert(Number(reprojTx.service_amount) === 10000, `(6) service still 10000 (got ${reprojTx.service_amount})`);
      assert(Number(reprojTx.tax_amount) === 12100, `(6) tax still 12100 (got ${reprojTx.tax_amount})`);
    }
    // Verify no duplicate row
    const dupCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM transactions WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2`,
      [pid, String(order4Id)]
    );
    assert(Number(dupCount.rows[0].c) === 1, `(6) no duplicate tx row (got ${dupCount.rows[0].c})`);

    // ── Scenario 7: Cross-property isolation ────────────────────────────────
    console.log('\n── Scenario 7: Cross-property rejection ──');
    const otherPropR = await pool.query(
      `INSERT INTO properties (name, property_code, timezone, currency_code, is_active)
       VALUES ('B3PROP2', 'B3PRP2', 'Asia/Jakarta', 'IDR', TRUE) RETURNING id`
    );
    const pid2 = Number(otherPropR.rows[0].id);
    tracked.properties.push(pid2);
    let crossRejected = false;
    try {
      await projectPosOrderToTransaction(pool, order4Id, { propertyId: pid2 });
    } catch (e) {
      crossRejected = /bukan milik properti/i.test(e.message);
    }
    assert(crossRejected, '(7) cross-property projection rejected with message');

    // ── Scenario 8: Reversal (void) ─────────────────────────────────────────
    console.log('\n── Scenario 8: Reversal (VOID) ──');
    // Void order4 in DB
    await pool.query(
      `UPDATE pos_orders SET status='VOIDED' WHERE id=$1`, [order4Id]
    );
    const revTx = await projectPosOrderToTransaction(pool, order4Id, { propertyId: pid });
    assert(revTx !== null, '(8) Reversal projection returns tx');
    if (revTx) {
      tracked.transactions.push(revTx.id);
      assert(String(revTx.transaction_status) === 'REVERSED', `(8) tx status REVERSED (got ${revTx.transaction_status})`);
      assert(String(revTx.reversal_of_transaction_id) === String(comboTx.id),
        `(8) reversal_of = original tx id (got ${revTx.reversal_of_transaction_id})`);
      assert(Number(revTx.amount) === -100000, `(8) amount = -100000 (got ${revTx.amount})`);
      assert(Number(revTx.discount_amount) === 0, `(8) discount = 0 (got ${revTx.discount_amount})`);
      assert(Number(revTx.service_amount) === -10000, `(8) service = -10000 (got ${revTx.service_amount})`);
      assert(Number(revTx.tax_amount) === -12100, `(8) tax = -12100 (got ${revTx.tax_amount})`);
      assert(Number(revTx.net_amount) === -122100, `(8) net = -122100 (got ${revTx.net_amount})`);
      // Invariant on reversal: net = amount - discount + service + tax
      const inv = Number(revTx.amount) - Number(revTx.discount_amount) +
                  Number(revTx.service_amount) + Number(revTx.tax_amount);
      assert(inv === Number(revTx.net_amount), `(8) reversal invariant: ${inv} == net ${revTx.net_amount}`);
    }

    // Verify original tx status
    const origStatus = await pool.query(
      `SELECT transaction_status FROM transactions WHERE id=$1`, [comboTx.id]
    );
    assert(String(origStatus.rows[0].transaction_status) === 'VOIDED',
      `(8) original tx status = VOIDED (got ${origStatus.rows[0].transaction_status})`);

    // Idempotent reversal: calling again should return existing reversal, not create new
    const revTx2 = await projectPosOrderToTransaction(pool, order4Id, { propertyId: pid });
    assert(revTx2 !== null && String(revTx2.id) === String(revTx.id),
      `(8) idempotent reversal returns same tx id`);
    const revCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM transactions WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2`,
      [pid, String(order4Id)]
    );
    assert(Number(revCount.rows[0].c) === 2, `(8) exactly 2 tx rows for voided order (got ${revCount.rows[0].c})`);

    // ── Scenario 9: Reversal of discount+svc+tax order ─────────────────────
    console.log('\n── Scenario 9: Reversal of discount+svc+tax order ──');
    // Void order5 (has item+order discount + svc+tax)
    await pool.query(`UPDATE pos_orders SET status='VOIDED' WHERE id=$1`, [order5Id]);
    const rev5Tx = await projectPosOrderToTransaction(pool, order5Id, { propertyId: pid });
    assert(rev5Tx !== null, '(9) Reversal of discount order returns tx');
    if (rev5Tx) {
      tracked.transactions.push(rev5Tx.id);
      assert(Number(rev5Tx.amount) === -200000, `(9) amount = -200000 (got ${rev5Tx.amount})`);
      assert(Number(rev5Tx.discount_amount) === -25000, `(9) discount = -25000 (got ${rev5Tx.discount_amount})`);
      assert(Number(rev5Tx.service_amount) === -17500, `(9) service = -17500 (got ${rev5Tx.service_amount})`);
      assert(Number(rev5Tx.tax_amount) === -21175, `(9) tax = -21175 (got ${rev5Tx.tax_amount})`);
      assert(Number(rev5Tx.net_amount) === -213675, `(9) net = -213675 (got ${rev5Tx.net_amount})`);
      const inv = Number(rev5Tx.amount) - Number(rev5Tx.discount_amount) +
                  Number(rev5Tx.service_amount) + Number(rev5Tx.tax_amount);
      assert(inv === Number(rev5Tx.net_amount), `(9) reversal invariant: ${inv} == net ${rev5Tx.net_amount}`);
    }

    // ── Scenario 10: Mismatch rejection ────────────────────────────────────
    console.log('\n── Scenario 10: Mismatch rejection ──');
    // Create an order where total_amount doesn't match invariant
    // gross=100000, discount=0, svc=5000, tax=0, total_amount=99999 (WRONG)
    const badOrderR = await pool.query(
      `INSERT INTO pos_orders
         (property_id, order_number, table_number, guest_name, status, total_amount, discount_amount,
          service_amount, tax_amount, service_charge_percent_snapshot, tax_percent_snapshot,
          service_charge_enabled_snapshot, tax_enabled_snapshot, created_at, updated_at)
       VALUES
         ($1, 'POS-B3-BAD', 'Meja 9', 'Bad Guest', 'PAID', 99999, 0,
          5000, 0, 5.0, 0, TRUE, FALSE, NOW(), NOW())
       RETURNING id`,
      [pid]
    );
    const badOrderId = Number(badOrderR.rows[0].id);
    tracked.posOrders.push(badOrderId);
    await pool.query(
      `INSERT INTO pos_order_items (order_id, menu_item_id, quantity, unit_price, discount_amount, item_name_snapshot, item_code_snapshot)
       VALUES ($1, $2, 1, 100000, 0, 'B3 ITEM', 'B3-ITEM')`,
      [badOrderId, itemId]
    );

    let mismatchRejected = false;
    try {
      await projectPosOrderToTransaction(pool, badOrderId, { propertyId: pid });
    } catch (e) {
      mismatchRejected = /POS_SNAPSHOT_MISMATCH|invariant/i.test(e.code || '') || /invariant/i.test(e.message);
      console.log('  Mismatch error:', e.message?.slice(0, 100));
    }
    assert(mismatchRejected, '(10) mismatched total_amount rejected (POS_SNAPSHOT_MISMATCH)');

    // Verify no tx row was created for the bad order
    const badCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM transactions WHERE property_id=$1 AND source_type='POS_ORDER' AND source_id=$2`,
      [pid, String(badOrderId)]
    );
    assert(Number(badCount.rows[0].c) === 0, `(10) no tx created for bad order (got ${badCount.rows[0].c})`);

    // ── Summary ─────────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`B3 DIRECT TEST: ${passed} PASS, ${failed} FAIL`);
  } finally {
    // Cleanup only IDs created by this run. Use one client/transaction so
    // partial fixture cleanup cannot silently report success.
    let cleanupClient;
    try {
      cleanupClient = await pool.connect();
      await cleanupClient.query('BEGIN');
      if (tracked.posOrders.length) {
        // Reversal transactions must be deleted before original transactions.
        await cleanupClient.query(
          `DELETE FROM transactions WHERE property_id = ANY($1::bigint[])
             AND source_type = 'POS_ORDER' AND source_id = ANY($2::text[])
             AND reversal_of_transaction_id IS NOT NULL`,
          [tracked.properties, tracked.posOrders.map(String)]);
        await cleanupClient.query(
          `DELETE FROM transactions WHERE property_id = ANY($1::bigint[])
             AND source_type = 'POS_ORDER' AND source_id = ANY($2::text[])`,
          [tracked.properties, tracked.posOrders.map(String)]);
      }
      // Handle any additional transaction IDs emitted from the test run.
      if (tracked.transactions.length) {
        await cleanupClient.query('DELETE FROM transactions WHERE id = ANY($1::bigint[])',
          [tracked.transactions]);
      }
      if (tracked.posOrders.length) {
        await cleanupClient.query('DELETE FROM pos_order_items WHERE order_id = ANY($1::bigint[])', [tracked.posOrders]);
        await cleanupClient.query('DELETE FROM pos_orders WHERE id = ANY($1::bigint[])', [tracked.posOrders]);
      }
      if (tracked.menuItems.length) {
        await cleanupClient.query('DELETE FROM pos_menu_items WHERE id = ANY($1::bigint[])', [tracked.menuItems]);
      }
      if (tracked.categories.length) {
        await cleanupClient.query('DELETE FROM pos_menu_categories WHERE id = ANY($1::bigint[])', [tracked.categories]);
      }
      if (tracked.settings.length) {
        await cleanupClient.query('DELETE FROM property_pos_pricing_settings WHERE id = ANY($1::bigint[])', [tracked.settings]);
      }
      if (tracked.properties.length) {
        await cleanupClient.query('DELETE FROM properties WHERE id = ANY($1::bigint[])', [tracked.properties]);
      }
      await cleanupClient.query('COMMIT');
    } catch (e) {
      cleanupFailed = true;
      console.error('CLEANUP ERROR:', e);
      if (cleanupClient) {
        try { await cleanupClient.query('ROLLBACK'); }
        catch (rollbackError) { console.error('ROLLBACK ERROR:', rollbackError); }
      }
    } finally {
      if (cleanupClient) cleanupClient.release();
      try { await pool.end(); }
      catch (poolError) {
        cleanupFailed = true;
        console.error('POOL CLOSE ERROR:', poolError);
      }
      if (cleanupFailed) process.exitCode = 1;
    }
  }

  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
