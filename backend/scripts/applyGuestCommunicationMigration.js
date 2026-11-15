#!/usr/bin/env node
/**
 * One-off targeted migration: Guest Communication / WhatsApp CRM Foundation.
 *
 * Migration version: guest_communication_v1
 *
 * Purpose:
 * - Creates two tables: guest_communication_templates & guest_communication_logs.
 * - Establishes the schema foundation for property-scoped communication templates
 *   and immutable-ish business communication history (WhatsApp deep-link workflow).
 * - Does NOT seed default template rows.
 * - Does NOT create payment transactions or touch financial data.
 *
 * All five DB_* environment variables are REQUIRED.
 *
 * Idempotent: safe to run multiple times.
 * Safety: never drops, truncates, or modifies existing data.
 */
require('dotenv').config();

const { Pool } = require('pg');

const MIGRATION_VERSION = 'guest_communication_v1';

// ─── Hard-fail: require all DB env vars ─────────────────────────────────────
const MISSING_VARS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']
  .filter((key) => !process.env[key] || !process.env[key].trim());

if (MISSING_VARS.length > 0) {
  console.error(`[GUEST COMMUNICATION MIGRATION] Missing required environment variables:`);
  console.error('  ' + MISSING_VARS.join(', '));
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST.trim(),
  port: parseInt(process.env.DB_PORT, 10),
  user: process.env.DB_USER.trim(),
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME.trim(),
  connectionTimeoutMillis: 10000,
});

// ─── Integrity verification ─────────────────────────────────────────────────
async function verifyIntegrity(client) {
  const errors = [];

  // ---- Tables exist ----
  const templatesTableCheck = await client.query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'guest_communication_templates'
  `);
  if ((templatesTableCheck.rowCount ?? 0) === 0) {
    errors.push('guest_communication_templates table missing');
  }

  const logsTableCheck = await client.query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'guest_communication_logs'
  `);
  if ((logsTableCheck.rowCount ?? 0) === 0) {
    errors.push('guest_communication_logs table missing');
  }

  if (errors.length > 0) return errors; // stop here if tables are missing

  // ---- Column contract: presence, data_type, nullable, default (templates) ----
  const templatesColDetail = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'guest_communication_templates'
    ORDER BY ordinal_position
  `);
  const tmplColMap = Object.fromEntries(
    templatesColDetail.rows.map((r) => [r.column_name, r])
  );
  const EXPECTED_TPL_COLS = [
    { name: 'id',               dt: 'integer',          nn: 'NO',  def: null },
    { name: 'property_id',      dt: 'integer',          nn: 'NO',  def: null },
    { name: 'code',             dt: 'character varying',nn: 'NO',  def: null },
    { name: 'name',             dt: 'character varying',nn: 'NO',  def: null },
    { name: 'channel',          dt: 'character varying',nn: 'NO',  def: "WHATSAPP'::" },
    { name: 'scope',            dt: 'character varying',nn: 'NO',  def: null },
    { name: 'category',         dt: 'character varying',nn: 'NO',  def: null },
    { name: 'message_body',     dt: 'text',             nn: 'NO',  def: null },
    { name: 'allowed_reservation_statuses', dt: 'jsonb', nn: 'NO', def: "'[]'::jsonb" },
    { name: 'template_variables',            dt: 'jsonb', nn: 'NO', def: "'[]'::jsonb" },
    { name: 'is_active',        dt: 'boolean',          nn: 'NO',  def: 'TRUE' },
    { name: 'display_order',    dt: 'integer',          nn: 'NO',  def: '0' },
    { name: 'created_by_user_id',dt: 'integer',         nn: 'YES', def: null },
    { name: 'updated_by_user_id',dt: 'integer',         nn: 'YES', def: null },
    { name: 'created_at',       dt: 'timestamp with time zone', nn: 'NO', def: null },
    { name: 'updated_at',       dt: 'timestamp with time zone', nn: 'NO', def: null },
  ];
  for (const ec of EXPECTED_TPL_COLS) {
    const c = tmplColMap[ec.name];
    if (!c) {
      errors.push(`guest_communication_templates missing column: ${ec.name}`);
      continue;
    }
    if (c.data_type !== ec.dt) {
      errors.push(`gct.${ec.name}: expected ${ec.dt}, got ${c.data_type}`);
    }
    if (ec.nn === 'NO' && c.is_nullable === 'YES') {
      errors.push(`gct.${ec.name}: expected NOT NULL, found NULLABLE`);
    }
    if (ec.nn === 'YES' && c.is_nullable === 'NO') {
      errors.push(`gct.${ec.name}: expected nullable, found NOT NULL`);
    }
    if (ec.def) {
      // For boolean defaults, compare normalized boolean values
      const expectedUpper = ec.def.toUpperCase();
      if (expectedUpper === 'TRUE' || expectedUpper === 'FALSE') {
        const actualLower = (c.column_default || '').toLowerCase().trim();
        if (actualLower !== expectedUpper.toLowerCase()) {
          errors.push(`gct.${ec.name}: expected default "${expectedUpper}", got "${c.column_default}"`);
        }
      } else {
        // String/json/integer defaults: keep case-sensitive substring match
        if (!c.column_default?.includes(ec.def)) {
          errors.push(`gct.${ec.name}: expected default containing "${ec.def}", got "${c.column_default}"`);
        }
      }
    }
  }

  // ---- Column contract: presence, data_type, nullable, default (logs) ----
  const logsColDetail = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'guest_communication_logs'
    ORDER BY ordinal_position
  `);
  const logColMap = Object.fromEntries(
    logsColDetail.rows.map((r) => [r.column_name, r])
  );
  const EXPECTED_LOG_COLS = [
    { name: 'id',                    dt: 'bigint',               nn: 'NO', def: null },
    { name: 'property_id',           dt: 'integer',              nn: 'NO', def: null },
    { name: 'guest_id',              dt: 'integer',              nn: 'YES',def: null },
    { name: 'guest_name_snapshot',   dt: 'character varying',    nn: 'NO', def: null },
    { name: 'destination_snapshot',  dt: 'character varying',    nn: 'NO', def: null },
    { name: 'reservation_id',        dt: 'integer',              nn: 'YES',def: null },
    { name: 'template_id',           dt: 'integer',              nn: 'YES',def: null },
    { name: 'template_code_snapshot',dt: 'character varying',    nn: 'YES',def: null },
    { name: 'template_name_snapshot',dt: 'character varying',    nn: 'YES',def: null },
    { name: 'channel',               dt: 'character varying',    nn: 'NO', def: "WHATSAPP'::" },
    { name: 'scope',                 dt: 'character varying',    nn: 'NO', def: null },
    { name: 'category',              dt: 'character varying',    nn: 'NO', def: null },
    { name: 'message_snapshot',      dt: 'text',                 nn: 'NO', def: null },
    { name: 'status',                dt: 'character varying',    nn: 'NO', def: "INITIATED'::" },
    { name: 'initiated_by_user_id',  dt: 'integer',              nn: 'YES',def: null },
    { name: 'initiated_by_name_snapshot', dt: 'character varying',nn: 'YES',def: null },
    { name: 'initiated_by_role_snapshot', dt: 'character varying',nn: 'YES',def: null },
    { name: 'correlation_id',        dt: 'character varying',    nn: 'YES',def: null },
    { name: 'metadata',              dt: 'jsonb',                nn: 'NO', def: "'{}'::jsonb" },
    { name: 'initiated_at',          dt: 'timestamp with time zone', nn: 'NO', def: null },
  ];
  for (const ec of EXPECTED_LOG_COLS) {
    const c = logColMap[ec.name];
    if (!c) {
      errors.push(`guest_communication_logs missing column: ${ec.name}`);
      continue;
    }
    if (c.data_type !== ec.dt) {
      errors.push(`gcl.${ec.name}: expected ${ec.dt}, got ${c.data_type}`);
    }
    if (ec.nn === 'NO' && c.is_nullable === 'YES') {
      errors.push(`gcl.${ec.name}: expected NOT NULL, found NULLABLE`);
    }
    if (ec.nn === 'YES' && c.is_nullable === 'NO') {
      errors.push(`gcl.${ec.name}: expected nullable, found NOT NULL`);
    }
    if (ec.def) {
      // For boolean defaults, compare normalized boolean values
      const expectedUpper = ec.def.toUpperCase();
      if (expectedUpper === 'TRUE' || expectedUpper === 'FALSE') {
        const actualLower = (c.column_default || '').toLowerCase().trim();
        if (actualLower !== expectedUpper.toLowerCase()) {
          errors.push(`gcl.${ec.name}: expected default "${expectedUpper}", got "${c.column_default}"`);
        }
      } else {
        // String/json/integer defaults: keep case-sensitive substring match
        if (!c.column_default?.includes(ec.def)) {
          errors.push(`gcl.${ec.name}: expected default containing "${ec.def}", got "${c.column_default}"`);
        }
      }
    }
  }

  // ---- FK definition verification: columns, referenced tables, ON DELETE ----
  const FK_SPEC = [
    { name: 'gct_property_fk',           rel: 'guest_communication_templates', srcCol: 'property_id',     refTable: 'properties',       refCol: 'id',          onDel: 'RESTRICT' },
    { name: 'gct_created_by_user_fk',    rel: 'guest_communication_templates', srcCol: 'created_by_user_id', refTable: 'users',          refCol: 'id',          onDel: 'SET NULL' },
    { name: 'gct_updated_by_user_fk',    rel: 'guest_communication_templates', srcCol: 'updated_by_user_id', refTable: 'users',          refCol: 'id',          onDel: 'SET NULL' },
    { name: 'gcl_property_fk',           rel: 'guest_communication_logs',      srcCol: 'property_id',     refTable: 'properties',       refCol: 'id',          onDel: 'RESTRICT' },
    { name: 'gcl_guest_fk',              rel: 'guest_communication_logs',      srcCol: 'guest_id',        refTable: 'guests',         refCol: 'id',          onDel: 'SET NULL' },
    { name: 'gcl_reservation_fk',        rel: 'guest_communication_logs',      srcCol: 'reservation_id',  refTable: 'reservations',   refCol: 'id',          onDel: 'SET NULL' },
    { name: 'gcl_template_fk',           rel: 'guest_communication_logs',      srcCol: 'template_id',     refTable: 'guest_communication_templates', refCol: 'id', onDel: 'SET NULL' },
    { name: 'gcl_initiated_by_user_fk',  rel: 'guest_communication_logs',      srcCol: 'initiated_by_user_id', refTable: 'users',    refCol: 'id',          onDel: 'SET NULL' },
  ];

  // Map pg_constraint.confdeltype codes to human-readable ON DELETE actions.
  const CONFDELTYPE_MAP = {
    r: 'RESTRICT',
    n: 'SET NULL',
    a: 'NO ACTION',
    c: 'CASCADE',
    d: 'SET DEFAULT',
  };

  for (const f of FK_SPEC) {
    // Use pg_constraint/pg_attribute catalog directly — no information_schema dependency.
    const row = await client.query(`
      SELECT
        src.attname  AS src_col,
        ref.relname  AS ref_table,
        refc.attname AS ref_col,
        cn.conname,
        cn.confdeltype
      FROM pg_constraint cn
      JOIN pg_class cl   ON cl.oid  = cn.conrelid
      JOIN pg_namespace nsp ON nsp.oid = cl.relnamespace
      JOIN pg_attribute src ON src.attrelid = cn.conrelid
                          AND src.attnum   = cn.conkey[1]
      JOIN pg_class ref   ON ref.oid  = cn.confrelid
      JOIN pg_attribute refc ON refc.attrelid = cn.confrelid
                          AND refc.attnum   = cn.confkey[1]
      WHERE cn.contype = 'f'
        AND nsp.nspname = 'public'
        AND cl.relname  = $1
        AND cn.conname  = $2
    `, [f.rel, f.name]);
    if ((row.rowCount ?? 0) === 0) {
      errors.push(`Missing FK: ${f.name}`);
      continue;
    }
    const r = row.rows[0];
    if (r.src_col !== f.srcCol) {
      errors.push(`${f.name}: expected src column ${f.srcCol}, got ${r.src_col}`);
    }
    if (r.ref_table !== f.refTable) {
      errors.push(`${f.name}: expected ref table ${f.refTable}, got ${r.ref_table}`);
    }
    if (r.ref_col !== f.refCol) {
      errors.push(`${f.name}: expected ref column ${f.refCol}, got ${r.ref_col}`);
    }
    // confdeltype is a single char; verify against expected ON DELETE action.
    const actualOnDel = CONFDELTYPE_MAP[r.confdeltype];
    if (!actualOnDel || actualOnDel !== f.onDel) {
      errors.push(
        `${f.name}: expected ON DELETE ${f.onDel}, ` +
        `got confdeltype '${r.confdeltype}' (${actualOnDel ?? 'unknown'})`
      );
    }
  }

  // ---- CHECK constraint semantic verification ----

  /**
   * Normalise a pg_get_constraintdef output for robust substring matching:
   * uppercase, collapse whitespace, strip redundant parens and ::text casts.
   */
  function normDef(def) {
    return String(def || '')
      .toUpperCase()
      .replace(/::TEXT/g, '')
      .replace(/::TEXT\[\]/g, '')
      .replace(/::CHARACTER VARYING/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\(\s*\(/g, '(')
      .replace(/\)\s*\)/g, ')')
      .trim();
  }

  /**
   * Extract ALL single-quoted string literals from a pg_get_constraintdef output.
   * Handles PostgreSQL casts like ::text, ::character varying, ::integer, etc.
   * Does NOT depend on single parenthesis group or simple ::\w+ parsing.
   */
  function extractAllStringLiterals(normed) {
    // Extract all single-quoted string literals regardless of type casts
    const literals = [];
    const regex = /'([^']*)'/g;
    let match;
    while ((match = regex.exec(normed)) !== null) {
      literals.push(match[1]);
    }
    return literals;
  }

  /**
   * Verify enum-style CHECK constraints with exact literal set matching.
   * - Extracts all SQL string literals from normalized definition
   * - Verifies required column name is referenced
   * - Verifies EXACT expected set: no missing, no extra, no duplicates
   * - Order-independent
   */
  function verifyEnumConstraint(normed, columnName, expectedValues) {
    // Check column is referenced
    if (!normed.includes(columnName.toUpperCase())) {
      return false;
    }

    // Extract all string literals
    const found = extractAllStringLiterals(normed);

    // Must have at least 1 literal (enum with values)
    if (found.length === 0) {
      return false;
    }

    // Check for duplicates
    const seen = new Set();
    for (const v of found) {
      if (seen.has(v)) {
        return false; // Duplicate values not allowed
      }
      seen.add(v);
    }

    // Exact set match: same length and all values present
    if (found.length !== expectedValues.length) {
      return false;
    }

    return expectedValues.every((v) => found.includes(v));
  }

  /**
   * Verify non-blank CHECK constraints that use TRIM forms.
   * Accepts semantically equivalent PostgreSQL forms:
   * - TRIM(COLUMN) <> ''
   * - TRIM(BOTH FROM COLUMN) <> ''
   * - BTRIM(COLUMN) <> ''
   */
  function verifyNonBlankConstraint(normed, columnName) {
    const upperCol = columnName.toUpperCase();
    const stripped = normed.replace(/\s+/g, '');
    return (
      stripped.includes(`TRIM(${upperCol})<>''`) ||
      stripped.includes(`TRIM(BOTHFROM${upperCol})<>''`) ||
      stripped.includes(`BTRIM(${upperCol})<>''`)
    );
  }

  const CHECK_SPEC = [
    // templates
    {
      name: 'gct_channel_chk',
      rel: 'guest_communication_templates',
      verify: (n) => verifyEnumConstraint(n, 'CHANNEL', ['WHATSAPP']),
    },
    {
      name: 'gct_scope_chk',
      rel: 'guest_communication_templates',
      verify: (n) =>
        verifyEnumConstraint(n, 'SCOPE', [
          'STAY_OPERATIONAL',
          'CRM_CAMPAIGN',
          'BIRTHDAY',
          'POST_STAY',
          'PROMOTION',
        ]),
    },
    {
      name: 'gct_category_chk',
      rel: 'guest_communication_templates',
      verify: (n) =>
        verifyEnumConstraint(n, 'CATEGORY', [
          'CHECKOUT_REMINDER',
          'DINNER_PROMO',
          'BREAKFAST_INFO',
          'LAUNDRY_PROMO',
          'LATE_CHECKOUT',
          'BIRTHDAY',
          'PROMOTION',
          'POST_STAY',
          'CUSTOM',
        ]),
    },
    {
      name: 'gct_code_not_empty_chk',
      rel: 'guest_communication_templates',
      verify: (n) => verifyNonBlankConstraint(n, 'code'),
    },
    {
      name: 'gct_name_not_empty_chk',
      rel: 'guest_communication_templates',
      verify: (n) => verifyNonBlankConstraint(n, 'name'),
    },
    {
      name: 'gct_message_body_not_empty_chk',
      rel: 'guest_communication_templates',
      verify: (n) => verifyNonBlankConstraint(n, 'message_body'),
    },
    {
      name: 'gct_display_order_gte_0_chk',
      rel: 'guest_communication_templates',
      verify: (n) => n.includes('DISPLAY_ORDER >= 0'),
    },
    {
      name: 'gct_allowed_reservation_statuses_is_array_chk',
      rel: 'guest_communication_templates',
      verify: (n) =>
        n.includes("JSONB_TYPEOF(ALLOWED_RESERVATION_STATUSES) = 'ARRAY'") ||
        n.replace(/\s+/g, '').includes("JSONB_TYPEOF(ALLOWED_RESERVATION_STATUSES)='ARRAY'"),
    },
    {
      name: 'gct_template_variables_is_array_chk',
      rel: 'guest_communication_templates',
      verify: (n) =>
        n.includes("JSONB_TYPEOF(TEMPLATE_VARIABLES) = 'ARRAY'") ||
        n.replace(/\s+/g, '').includes("JSONB_TYPEOF(TEMPLATE_VARIABLES)='ARRAY'"),
    },
    // logs
    {
      name: 'gcl_channel_chk',
      rel: 'guest_communication_logs',
      verify: (n) => verifyEnumConstraint(n, 'CHANNEL', ['WHATSAPP']),
    },
    {
      name: 'gcl_scope_chk',
      rel: 'guest_communication_logs',
      verify: (n) =>
        verifyEnumConstraint(n, 'SCOPE', [
          'STAY_OPERATIONAL',
          'CRM_CAMPAIGN',
          'BIRTHDAY',
          'POST_STAY',
          'PROMOTION',
        ]),
    },
    {
      name: 'gcl_category_chk',
      rel: 'guest_communication_logs',
      verify: (n) =>
        verifyEnumConstraint(n, 'CATEGORY', [
          'CHECKOUT_REMINDER',
          'DINNER_PROMO',
          'BREAKFAST_INFO',
          'LAUNDRY_PROMO',
          'LATE_CHECKOUT',
          'BIRTHDAY',
          'PROMOTION',
          'POST_STAY',
          'CUSTOM',
        ]),
    },
    {
      name: 'gcl_status_chk',
      rel: 'guest_communication_logs',
      verify: (n) =>
        verifyEnumConstraint(n, 'STATUS', [
          'INITIATED',
          'OPENED_WHATSAPP',
        ]),
    },
    {
      name: 'gcl_guest_name_not_empty_chk',
      rel: 'guest_communication_logs',
      verify: (n) => verifyNonBlankConstraint(n, 'guest_name_snapshot'),
    },
    {
      name: 'gcl_destination_not_empty_chk',
      rel: 'guest_communication_logs',
      verify: (n) => verifyNonBlankConstraint(n, 'destination_snapshot'),
    },
    {
      name: 'gcl_message_not_empty_chk',
      rel: 'guest_communication_logs',
      verify: (n) => verifyNonBlankConstraint(n, 'message_snapshot'),
    },
    {
      name: 'gcl_metadata_is_object_chk',
      rel: 'guest_communication_logs',
      verify: (n) =>
        n.includes("JSONB_TYPEOF(METADATA) = 'OBJECT'") ||
        n.replace(/\s+/g, '').includes("JSONB_TYPEOF(METADATA)='OBJECT'"),
    },
  ];
  for (const ch of CHECK_SPEC) {
    const row = await client.query(`
      SELECT 1 FROM pg_constraint cn
      JOIN pg_class cl ON cl.oid = cn.conrelid
      JOIN pg_namespace nsp ON nsp.oid = cl.relnamespace
      WHERE cn.contype = 'c'
        AND nsp.nspname = 'public'
        AND cl.relname = $1
        AND cn.conname = $2
    `, [ch.rel, ch.name]);
    if ((row.rowCount ?? 0) === 0) {
      errors.push(`Missing CHECK constraint: ${ch.name}`);
      continue;
    }
    const defRes = await client.query(
      `SELECT pg_get_constraintdef(cn.oid) FROM pg_constraint cn
       JOIN pg_class cl ON cl.oid = cn.conrelid
       JOIN pg_namespace nsp ON nsp.oid = cl.relnamespace
       WHERE nsp.nspname = 'public'
         AND cl.relname = $1
         AND cn.conname = $2`,
      [ch.rel, ch.name]
    );
    const def = (defRes.rows[0]?.pg_get_constraintdef || '');
    const normed = normDef(def);
    if (!ch.verify(normed)) {
      errors.push(`${ch.name}: definition does not match expected semantics. Found: "${def}"`);
    }
  }

  // ---- UNIQUE constraint definition ----
  const uniqueDef = await client.query(`
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'guest_communication_templates'::regclass
      AND conname = 'gct_property_code_unique'
      AND contype = 'u'
  `);
  if ((uniqueDef.rowCount ?? 0) === 0) {
    errors.push('Missing UNIQUE constraint: gct_property_code_unique');
  } else {
    const def = (uniqueDef.rows[0]?.pg_get_constraintdef || '').toUpperCase();
    if (!def.includes('PROPERTY_ID') || !def.includes('CODE')) {
      errors.push(`gct_property_code_unique: expected columns (property_id, code), found "${def}"`);
    }
  }

  // ---- INDEX definition verification ----
  const INDEX_SPEC = [
    { name: 'idx_gct_property_active_order_id', tbl: 'guest_communication_templates', expect: '(PROPERTY_ID, IS_ACTIVE, DISPLAY_ORDER, ID)' },
    { name: 'idx_gct_property_scope_active', tbl: 'guest_communication_templates', expect: '(PROPERTY_ID, SCOPE, IS_ACTIVE)' },
    { name: 'idx_gct_property_category_active', tbl: 'guest_communication_templates', expect: '(PROPERTY_ID, CATEGORY, IS_ACTIVE)' },
    { name: 'idx_gcl_property_guest_initiated', tbl: 'guest_communication_logs', expect: '(PROPERTY_ID, GUEST_ID, INITIATED_AT DESC)' },
    { name: 'idx_gcl_property_reservation_initiated', tbl: 'guest_communication_logs', expect: '(PROPERTY_ID, RESERVATION_ID, INITIATED_AT DESC)' },
    { name: 'idx_gcl_property_initiated', tbl: 'guest_communication_logs', expect: '(PROPERTY_ID, INITIATED_AT DESC)' },
    { name: 'idx_gcl_property_template_initiated', tbl: 'guest_communication_logs', expect: '(PROPERTY_ID, TEMPLATE_ID, INITIATED_AT DESC)' },
  ];
  for (const ix of INDEX_SPEC) {
    const exact = await client.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = $1
         AND indexname = $2`,
      [ix.tbl, ix.name]
    );
    if ((exact.rowCount ?? 0) === 0) {
      errors.push(`Missing index: ${ix.name}`);
      continue;
    }
    const idxDef = exact.rows[0]?.indexdef || '';
    if (!idxDef.toUpperCase().includes(ix.expect)) {
      errors.push(`${ix.name}: expected columns ${ix.expect}, found "${idxDef}"`);
    }
  }

  // ---- Row-level integrity: no constraint violations ----
  const invalidChannelTemplates = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_templates
    WHERE channel <> 'WHATSAPP'
  `);
  if (Number(invalidChannelTemplates.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidChannelTemplates.rows[0].cnt} template rows violate channel CHECK`);
  }

  const invalidScopeTemplates = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_templates
    WHERE scope NOT IN (
      'STAY_OPERATIONAL', 'CRM_CAMPAIGN', 'BIRTHDAY', 'POST_STAY', 'PROMOTION'
    )
  `);
  if (Number(invalidScopeTemplates.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidScopeTemplates.rows[0].cnt} template rows violate scope CHECK`);
  }

  const invalidCategoryTemplates = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_templates
    WHERE category NOT IN (
      'CHECKOUT_REMINDER', 'DINNER_PROMO', 'BREAKFAST_INFO', 'LAUNDRY_PROMO',
      'LATE_CHECKOUT', 'BIRTHDAY', 'PROMOTION', 'POST_STAY', 'CUSTOM'
    )
  `);
  if (Number(invalidCategoryTemplates.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidCategoryTemplates.rows[0].cnt} template rows violate category CHECK`);
  }

  // ---- Row-level enum checks for logs (channel, scope, category, status) ----
  const invalidChannelLogs = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_logs
    WHERE channel <> 'WHATSAPP'
  `);
  if (Number(invalidChannelLogs.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidChannelLogs.rows[0].cnt} log rows violate channel CHECK`);
  }

  const invalidScopeLogs = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_logs
    WHERE scope NOT IN (
      'STAY_OPERATIONAL', 'CRM_CAMPAIGN', 'BIRTHDAY', 'POST_STAY', 'PROMOTION'
    )
  `);
  if (Number(invalidScopeLogs.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidScopeLogs.rows[0].cnt} log rows violate scope CHECK`);
  }

  const invalidCategoryLogs = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_logs
    WHERE category NOT IN (
      'CHECKOUT_REMINDER', 'DINNER_PROMO', 'BREAKFAST_INFO', 'LAUNDRY_PROMO',
      'LATE_CHECKOUT', 'BIRTHDAY', 'PROMOTION', 'POST_STAY', 'CUSTOM'
    )
  `);
  if (Number(invalidCategoryLogs.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidCategoryLogs.rows[0].cnt} log rows violate category CHECK`);
  }

  const invalidStatusLogs = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_logs
    WHERE status NOT IN ('INITIATED', 'OPENED_WHATSAPP')
  `);
  if (Number(invalidStatusLogs.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidStatusLogs.rows[0].cnt} log rows violate status CHECK`);
  }

  const invalidDisplayOrder = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_templates
    WHERE display_order < 0
  `);
  if (Number(invalidDisplayOrder.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidDisplayOrder.rows[0].cnt} template rows have negative display_order`);
  }

  const blankCodeRows = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_templates
    WHERE TRIM(code) = ''
  `);
  if (Number(blankCodeRows.rows[0]?.cnt || 0) > 0) {
    errors.push(`${blankCodeRows.rows[0].cnt} template rows have empty trimmed code`);
  }

  const blankNameRows = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_templates
    WHERE TRIM(name) = ''
  `);
  if (Number(blankNameRows.rows[0]?.cnt || 0) > 0) {
    errors.push(`${blankNameRows.rows[0].cnt} template rows have empty trimmed name`);
  }

  const blankMessageRows = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_templates
    WHERE TRIM(message_body) = ''
  `);
  if (Number(blankMessageRows.rows[0]?.cnt || 0) > 0) {
    errors.push(`${blankMessageRows.rows[0].cnt} template rows have empty trimmed message_body`);
  }

  const blankGuestNameRows = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_logs
    WHERE TRIM(guest_name_snapshot) = ''
  `);
  if (Number(blankGuestNameRows.rows[0]?.cnt || 0) > 0) {
    errors.push(`${blankGuestNameRows.rows[0].cnt} log rows have empty trimmed guest_name_snapshot`);
  }

  const blankDestRows = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_logs
    WHERE TRIM(destination_snapshot) = ''
  `);
  if (Number(blankDestRows.rows[0]?.cnt || 0) > 0) {
    errors.push(`${blankDestRows.rows[0].cnt} log rows have empty trimmed destination_snapshot`);
  }

  const blankMessageLogRows = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_logs
    WHERE TRIM(message_snapshot) = ''
  `);
  if (Number(blankMessageLogRows.rows[0]?.cnt || 0) > 0) {
    errors.push(`${blankMessageLogRows.rows[0].cnt} log rows have empty trimmed message_snapshot`);
  }

  // ---- JSON shape validation (templates) ----
  // NULL treated as invalid even though DDL says NOT NULL — detect malformed pre-existing state
  const invalidJsonArrayCols = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_templates
    WHERE allowed_reservation_statuses IS NULL
       OR template_variables IS NULL
       OR jsonb_typeof(allowed_reservation_statuses) <> 'array'
       OR jsonb_typeof(template_variables) <> 'array'
  `);
  if (Number(invalidJsonArrayCols.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidJsonArrayCols.rows[0].cnt} template rows have invalid or NULL JSON array shapes`);
  }

  // ---- JSON shape validation (logs) ----
  // NULL treated as invalid even though DDL says NOT NULL — detect malformed pre-existing state
  const invalidJsonObject = await client.query(`
    SELECT COUNT(*)::int AS cnt FROM guest_communication_logs
    WHERE metadata IS NULL
       OR jsonb_typeof(metadata) <> 'object'
  `);
  if (Number(invalidJsonObject.rows[0]?.cnt || 0) > 0) {
    errors.push(`${invalidJsonObject.rows[0].cnt} log rows have invalid or NULL JSON object shape for metadata`);
  }

  // ---- PRIMARY KEY & SEQUENCE verification ----
  const tplPkCheck = await client.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'guest_communication_templates'::regclass
      AND contype = 'p'
      AND conname = 'guest_communication_templates_pkey'
  `);
  if ((tplPkCheck.rowCount ?? 0) === 0) {
    errors.push('Missing PRIMARY KEY constraint on guest_communication_templates');
  }

  const logPkCheck = await client.query(`
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'guest_communication_logs'::regclass
      AND contype = 'p'
      AND conname = 'guest_communication_logs_pkey'
  `);
  if ((logPkCheck.rowCount ?? 0) === 0) {
    errors.push('Missing PRIMARY KEY constraint on guest_communication_logs');
  }

  const tplSeqCheck = await client.query(`
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname = 'public'
      AND c.relname = 'guest_communication_templates_id_seq'
  `);
  if ((tplSeqCheck.rowCount ?? 0) === 0) {
    errors.push('Missing sequence: guest_communication_templates_id_seq');
  }

  const logSeqCheck = await client.query(`
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname = 'public'
      AND c.relname = 'guest_communication_logs_id_seq'
  `);
  if ((logSeqCheck.rowCount ?? 0) === 0) {
    errors.push('Missing sequence: guest_communication_logs_id_seq');
  }

  return errors;
}

// ─── Runtime privilege assurance ────────────────────────────────────────────
async function ensureRuntimePrivileges(client) {
  await client.query(`
    GRANT SELECT, INSERT, UPDATE
    ON TABLE guest_communication_templates
    TO oak_app
  `);

  await client.query(`
    GRANT SELECT, INSERT, UPDATE
    ON TABLE guest_communication_logs
    TO oak_app
  `);

  await client.query(`
    GRANT USAGE, SELECT
    ON SEQUENCE guest_communication_templates_id_seq
    TO oak_app
  `);

  await client.query(`
    GRANT USAGE, SELECT
    ON SEQUENCE guest_communication_logs_id_seq
    TO oak_app
  `);

  console.log('[GUEST COMMUNICATION] Runtime privileges ensured for oak_app.');
}

// ─── Privilege verification ─────────────────────────────────────────────────
async function verifyPrivileges(client) {
  const errors = [];

  const requiredTablePrivs = [
    { table: 'guest_communication_templates', privs: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: 'guest_communication_logs', privs: ['SELECT', 'INSERT', 'UPDATE'] },
  ];
  const requiredSeqPrivs = [
    { seq: 'guest_communication_templates_id_seq', privs: ['USAGE', 'SELECT'] },
    { seq: 'guest_communication_logs_id_seq', privs: ['USAGE', 'SELECT'] },
  ];

  for (const t of requiredTablePrivs) {
    for (const priv of t.privs) {
      const res = await client.query(
        `SELECT has_table_privilege('oak_app', $1, $2) AS has_priv`,
        [t.table, priv]
      );
      if (!res.rows[0]?.has_priv) {
        errors.push(`oak_app missing ${priv} on ${t.table}`);
      }
    }
  }

  for (const s of requiredSeqPrivs) {
    for (const priv of s.privs) {
      const res = await client.query(
        `SELECT has_sequence_privilege('oak_app', $1, $2) AS has_priv`,
        [s.seq, priv]
      );
      if (!res.rows[0]?.has_priv) {
        errors.push(`oak_app missing ${priv} on ${s.seq}`);
      }
    }
  }

  return errors;
}

// ─── Main entry point ───────────────────────────────────────────────────────
async function run() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Ensure schema_migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Check if already applied
    const already = await client.query(
      'SELECT 1 FROM schema_migrations WHERE version = $1',
      [MIGRATION_VERSION]
    );

    if ((already.rowCount ?? 0) > 0) {
      console.log(`[GUEST COMMUNICATION MIGRATION] ${MIGRATION_VERSION} already applied — re-verifying integrity...`);
      await ensureRuntimePrivileges(client);
      const intErrors = await verifyIntegrity(client);
      const privErrors = await verifyPrivileges(client);
      const allErrors = [...intErrors, ...privErrors];
      if (allErrors.length > 0) {
        throw new Error(`Integrity re-verification failed:\n  ${allErrors.join('\n  ')}`);
      }
      await client.query('COMMIT');
      console.log('[GUEST COMMUNICATION MIGRATION] Re-verification passed. Nothing to do.');
      return;
    }

    // ─── Create guest_communication_templates ───────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS guest_communication_templates (
        id SERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL,
        code VARCHAR(64) NOT NULL,
        name VARCHAR(150) NOT NULL,
        channel VARCHAR(20) NOT NULL DEFAULT 'WHATSAPP',
        scope VARCHAR(32) NOT NULL,
        category VARCHAR(50) NOT NULL,
        message_body TEXT NOT NULL,
        allowed_reservation_statuses JSONB NOT NULL DEFAULT '[]'::jsonb,
        template_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_by_user_id INTEGER NULL,
        updated_by_user_id INTEGER NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT gct_property_fk
          FOREIGN KEY (property_id)
          REFERENCES properties(id)
          ON DELETE RESTRICT,

        CONSTRAINT gct_created_by_user_fk
          FOREIGN KEY (created_by_user_id)
          REFERENCES users(id)
          ON DELETE SET NULL,

        CONSTRAINT gct_updated_by_user_fk
          FOREIGN KEY (updated_by_user_id)
          REFERENCES users(id)
          ON DELETE SET NULL,

        CONSTRAINT gct_property_code_unique
          UNIQUE (property_id, code),

        CONSTRAINT gct_channel_chk
          CHECK (channel = 'WHATSAPP'),

        CONSTRAINT gct_scope_chk
          CHECK (scope IN (
            'STAY_OPERATIONAL', 'CRM_CAMPAIGN', 'BIRTHDAY', 'POST_STAY', 'PROMOTION'
          )),

        CONSTRAINT gct_category_chk
          CHECK (category IN (
            'CHECKOUT_REMINDER', 'DINNER_PROMO', 'BREAKFAST_INFO', 'LAUNDRY_PROMO',
            'LATE_CHECKOUT', 'BIRTHDAY', 'PROMOTION', 'POST_STAY', 'CUSTOM'
          )),

        CONSTRAINT gct_code_not_empty_chk
          CHECK (TRIM(code) <> ''),

        CONSTRAINT gct_name_not_empty_chk
          CHECK (TRIM(name) <> ''),

        CONSTRAINT gct_message_body_not_empty_chk
          CHECK (TRIM(message_body) <> ''),

        CONSTRAINT gct_display_order_gte_0_chk
          CHECK (display_order >= 0),

        CONSTRAINT gct_allowed_reservation_statuses_is_array_chk
          CHECK (jsonb_typeof(allowed_reservation_statuses) = 'array'),

        CONSTRAINT gct_template_variables_is_array_chk
          CHECK (jsonb_typeof(template_variables) = 'array')
      )
    `);
    console.log('[GUEST COMMUNICATION] guest_communication_templates table ensured.');

    // ─── Create guest_communication_logs ────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS guest_communication_logs (
        id BIGSERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL,
        guest_id INTEGER NULL,
        guest_name_snapshot VARCHAR(150) NOT NULL,
        destination_snapshot VARCHAR(50) NOT NULL,
        reservation_id INTEGER NULL,
        template_id INTEGER NULL,
        template_code_snapshot VARCHAR(64) NULL,
        template_name_snapshot VARCHAR(150) NULL,
        channel VARCHAR(20) NOT NULL DEFAULT 'WHATSAPP',
        scope VARCHAR(32) NOT NULL,
        category VARCHAR(50) NOT NULL,
        message_snapshot TEXT NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'INITIATED',
        initiated_by_user_id INTEGER NULL,
        initiated_by_name_snapshot VARCHAR(150) NULL,
        initiated_by_role_snapshot VARCHAR(100) NULL,
        correlation_id VARCHAR(100) NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT gcl_property_fk
          FOREIGN KEY (property_id)
          REFERENCES properties(id)
          ON DELETE RESTRICT,

        CONSTRAINT gcl_guest_fk
          FOREIGN KEY (guest_id)
          REFERENCES guests(id)
          ON DELETE SET NULL,

        CONSTRAINT gcl_reservation_fk
          FOREIGN KEY (reservation_id)
          REFERENCES reservations(id)
          ON DELETE SET NULL,

        CONSTRAINT gcl_template_fk
          FOREIGN KEY (template_id)
          REFERENCES guest_communication_templates(id)
          ON DELETE SET NULL,

        CONSTRAINT gcl_initiated_by_user_fk
          FOREIGN KEY (initiated_by_user_id)
          REFERENCES users(id)
          ON DELETE SET NULL,

        CONSTRAINT gcl_channel_chk
          CHECK (channel = 'WHATSAPP'),

        CONSTRAINT gcl_scope_chk
          CHECK (scope IN (
            'STAY_OPERATIONAL', 'CRM_CAMPAIGN', 'BIRTHDAY', 'POST_STAY', 'PROMOTION'
          )),

        CONSTRAINT gcl_category_chk
          CHECK (category IN (
            'CHECKOUT_REMINDER', 'DINNER_PROMO', 'BREAKFAST_INFO', 'LAUNDRY_PROMO',
            'LATE_CHECKOUT', 'BIRTHDAY', 'PROMOTION', 'POST_STAY', 'CUSTOM'
          )),

        CONSTRAINT gcl_status_chk
          CHECK (status IN ('INITIATED', 'OPENED_WHATSAPP')),

        CONSTRAINT gcl_guest_name_not_empty_chk
          CHECK (TRIM(guest_name_snapshot) <> ''),

        CONSTRAINT gcl_destination_not_empty_chk
          CHECK (TRIM(destination_snapshot) <> ''),

        CONSTRAINT gcl_message_not_empty_chk
          CHECK (TRIM(message_snapshot) <> ''),

        CONSTRAINT gcl_metadata_is_object_chk
          CHECK (jsonb_typeof(metadata) = 'object')
      )
    `);
    console.log('[GUEST COMMUNICATION] guest_communication_logs table ensured.');

    // ─── Indexes ────────────────────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gct_property_active_order_id
        ON guest_communication_templates (property_id, is_active, display_order, id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gct_property_scope_active
        ON guest_communication_templates (property_id, scope, is_active)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gct_property_category_active
        ON guest_communication_templates (property_id, category, is_active)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gcl_property_guest_initiated
        ON guest_communication_logs (property_id, guest_id, initiated_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gcl_property_reservation_initiated
        ON guest_communication_logs (property_id, reservation_id, initiated_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gcl_property_initiated
        ON guest_communication_logs (property_id, initiated_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_gcl_property_template_initiated
        ON guest_communication_logs (property_id, template_id, initiated_at DESC)
    `);
    console.log('[GUEST COMMUNICATION] Indexes ensured.');

    // ─── Privileges & integrity ─────────────────────────────────────────
    await ensureRuntimePrivileges(client);
    const intErrors = await verifyIntegrity(client);
    const privErrors = await verifyPrivileges(client);
    const allErrors = [...intErrors, ...privErrors];
    if (allErrors.length > 0) {
      throw new Error(`Integrity check failed:\n  ${allErrors.join('\n  ')}`);
    }
    console.log('[GUEST COMMUNICATION] Integrity checks passed.');

    // ─── Mark migration as applied ──────────────────────────────────────
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1)',
      [MIGRATION_VERSION]
    );

    await client.query('COMMIT');
    console.log(`[GUEST COMMUNICATION MIGRATION] Marked ${MIGRATION_VERSION} as applied.`);
    console.log('[GUEST COMMUNICATION MIGRATION] Committed successfully.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[GUEST COMMUNICATION MIGRATION] Failed: ${err?.message || err}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
