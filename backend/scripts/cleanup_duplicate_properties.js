/**
 * OAK HIMS — Safe Targeted Property Cleanup Script
 * 
 * Target IDs verified from detailed dependency audit:
 * - 796 ('Property 2 Isolasi', 'P75953') -> contains 1 test transaction #113 ('Penjualan di Properti Lain'), 1 test audit #31897, 1 test daily sequence, 27 property features
 * - 797 ('Property 2 Isolasi', 'P57298') -> contains 27 property features, 0 operational records
 * - 799 ('Property 2 Isolasi', 'P13202') -> contains 1 test audit #31907, 1 test daily sequence, 0 operational records
 * - 800 ('Property 2 Isolasi', 'P81811') -> contains 1 test audit #31911, 1 test daily sequence, 0 operational records
 * - 805 ('Property 2 Isolasi', 'P87901') -> contains 1 test audit #32079, 1 test daily sequence, 0 operational records
 * - 827 ('Property 2 Isolasi', 'P56622') -> contains 1 test audit #32300, 1 test daily sequence, 0 operational records
 * - 828 ('Unit Test Explicit Property', 'T99365') -> 0 operational records, test settings metadata only
 * - 829 ('Unit Test Explicit Property', 'T14949') -> 0 operational records, test settings metadata only
 * 
 * Safety invariants:
 * - Canonical OAK Lawang (ID: 1, Code: 'LWG') is STRICTLY EXCLUDED and PROTECTED.
 * - Targeted by exact primary key IDs only.
 * - Dry-run mode by default unless --execute is explicitly supplied.
 */

const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const TARGET_DUPLICATE_IDS = [796, 797, 799, 800, 805, 827, 828, 829];
const CANONICAL_PROTECTED_ID = 1;

async function executeCleanup(execute = false) {
  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'oak_hotel_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres'
  });

  const client = await pool.connect();

  try {
    console.log('=================================================================');
    console.log(`PROPERTY CLEANUP AUDIT & EXECUTION (Mode: ${execute ? 'EXECUTE' : 'DRY-RUN / AUDIT'})`);
    console.log('=================================================================\n');

    await client.query('BEGIN');

    // 1. Guard check: Ensure target IDs do not contain Canonical Property ID
    if (TARGET_DUPLICATE_IDS.includes(CANONICAL_PROTECTED_ID)) {
      throw new Error(`CRITICAL ABORT: Protected Property ID ${CANONICAL_PROTECTED_ID} cannot be targeted!`);
    }

    // 2. Verify target properties in database
    const targetCheck = await client.query(
      'SELECT id, name, property_code FROM properties WHERE id = ANY($1) ORDER BY id ASC',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`Found ${targetCheck.rows.length} duplicate properties matching target IDs:`);
    targetCheck.rows.forEach(p => console.log(`  - [ID #${p.id}] ${p.name} (Code: ${p.property_code})`));

    // 3. Foreign key cascading dependency removal in safe dependency order
    console.log('\nProcessing child dependencies for target IDs:');

    // 3a. Transaction attachments
    const delAttachments = await client.query(
      'DELETE FROM transaction_attachments WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delAttachments.rowCount} transaction_attachments`);

    // 3b. Transactions
    const delTransactions = await client.query(
      'DELETE FROM transactions WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delTransactions.rowCount} transactions`);

    // 3c. Transaction Daily Sequences
    const delSequences = await client.query(
      'DELETE FROM transaction_daily_sequences WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delSequences.rowCount} transaction_daily_sequences`);

    // 3d. Audit logs
    const delAudits = await client.query(
      'DELETE FROM audit_logs WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delAudits.rowCount} audit_logs`);

    // 3e. Property features
    const delFeatures = await client.query(
      'DELETE FROM property_features WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delFeatures.rowCount} property_features`);

    // 3f. Property brandings
    const delBrandings = await client.query(
      'DELETE FROM property_brandings WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delBrandings.rowCount} property_brandings`);

    // 3g. Property pricing settings
    const delPricing = await client.query(
      'DELETE FROM property_pricing_settings WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delPricing.rowCount} property_pricing_settings`);

    // 3h. Property housekeeping settings
    const delHk = await client.query(
      'DELETE FROM property_housekeeping_settings WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delHk.rowCount} property_housekeeping_settings`);

    // 3i. Property attendance settings
    const delAtt = await client.query(
      'DELETE FROM property_attendance_settings WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delAtt.rowCount} property_attendance_settings`);

    // 3j. Rate plans & Meal plans
    const delRatePlans = await client.query(
      'DELETE FROM rate_plans WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delRatePlans.rowCount} rate_plans`);

    const delMealPlans = await client.query(
      'DELETE FROM meal_plans WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delMealPlans.rowCount} meal_plans`);

    // 3k. Quick booking rules & day use durations
    const delQb = await client.query(
      'DELETE FROM property_quick_booking_rules WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delQb.rowCount} property_quick_booking_rules`);

    const delDu = await client.query(
      'DELETE FROM property_day_use_durations WHERE property_id = ANY($1)',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`  - Deleted ${delDu.rowCount} property_day_use_durations`);

    // 4. Delete target properties
    const delProperties = await client.query(
      'DELETE FROM properties WHERE id = ANY($1) RETURNING id, name, property_code',
      [TARGET_DUPLICATE_IDS]
    );
    console.log(`\n  -> Successfully removed ${delProperties.rowCount} duplicate property records.`);

    // 5. Verify Canonical OAK Lawang
    const oakCheck = await client.query('SELECT id, name, property_code, is_active FROM properties WHERE id = 1');
    if (oakCheck.rows.length !== 1 || oakCheck.rows[0].property_code !== 'LWG') {
      throw new Error('CRITICAL INTEGRITY FAILURE: OAK Lawang was corrupted or missing!');
    }
    console.log(`\nVerified Canonical Property [ID #${oakCheck.rows[0].id}] ${oakCheck.rows[0].name} (Code: ${oakCheck.rows[0].property_code}) is INTACT.`);

    if (execute) {
      await client.query('COMMIT');
      console.log('\n>>> TRANSACTION COMMITTED: Cleanup successfully applied! <<<');
    } else {
      await client.query('ROLLBACK');
      console.log('\n>>> TRANSACTION ROLLED BACK: Dry-run complete. Zero database modifications made. <<<');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nCleanup error encountered, transaction rolled back:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

const isExecute = process.argv.includes('--execute');
executeCleanup(isExecute).catch(() => process.exit(1));
