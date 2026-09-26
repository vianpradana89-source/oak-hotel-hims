#!/usr/bin/env node
/**
 * READ-ONLY PostgreSQL diagnostic for OTA payment migration permission check.
 *
 * Environment variables required (same as applyRegionMasterMigration.js):
 *   DB_HOST
 *   DB_PORT
 *   DB_USER
 *   DB_PASSWORD
 *   DB_NAME
 *
 * This script performs ONLY SELECT queries. It never executes:
 *   CREATE, ALTER, INSERT, UPDATE, DELETE, GRANT, REVOKE, DROP, TRUNCATE.
 *
 * Exit code 0 after reporting all diagnostics, including when an object does not exist.
 */
require('dotenv').config();

const { Pool } = require('pg');

const REQUIRED_VARS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const MISSING = REQUIRED_VARS.filter(k => !process.env[k] || !process.env[k].trim());

if (MISSING.length > 0) {
  console.error('[OTA PAYMENT MIGRATION DIAGNOSTIC] Missing required environment variables:');
  console.error('  ' + MISSING.join(', '));
  process.exit(1);
}

const pool = new Pool({
  host:     process.env.DB_HOST.trim(),
  port:     parseInt(process.env.DB_PORT, 10),
  user:     process.env.DB_USER.trim(),
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME.trim()
});

async function run() {
  const client = await pool.connect();
  try {
    // ── 1. Identity: current_database, current_user, current_schema ──
    const identityRes = await client.query(
      'SELECT current_database() AS db, current_user AS "user", current_schema() AS schema'
    );
    const { db, user, schema } = identityRes.rows[0];
    console.log('=== IDENTITAS ===');
    console.log(`  current_database : ${db}`);
    console.log(`  current_user     : ${user}`);
    console.log(`  current_schema   : ${schema}`);
    console.log('');

    // ── 2. Object existence + owner for schema_migrations and bookings ──
    const objectInfoSql = `
      SELECT
        n.nspname AS table_schema,
        c.relname AS table_name,
        pg_catalog.pg_get_userbyid(c.relowner) AS table_owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND c.relname IN ('schema_migrations', 'bookings')
      ORDER BY c.relname
    `;
    const objectInfoRes = await client.query(objectInfoSql);
    const objects = objectInfoRes.rows;

    if (objects.length === 0) {
      console.log('=== OBJEK TABEL (schema_migrations / bookings) ===');
      console.log('  Tidak ditemukan tabel schema_migrations atau bookings.');
      console.log('');
    } else {
      console.log('=== OBJEK TABEL ===');
      for (const row of objects) {
        console.log(`  [${row.table_schema}].${row.table_name}`);
        console.log(`    owner : ${row.table_owner}`);
      }
      console.log('');
    }

    // ── 3. Table-level privileges for each object ──
    const privSql = `
      SELECT
        n.nspname AS table_schema,
        c.relname AS table_name,
        has_table_privilege(current_user, n.nspname || '.' || c.relname, 'SELECT')  AS can_select,
        has_table_privilege(current_user, n.nspname || '.' || c.relname, 'INSERT')  AS can_insert,
        has_table_privilege(current_user, n.nspname || '.' || c.relname, 'UPDATE')  AS can_update,
        has_table_privilege(current_user, n.nspname || '.' || c.relname, 'DELETE')  AS can_delete,
        has_table_privilege(current_user, n.nspname || '.' || c.relname, 'TRUNCATE') AS can_truncate,
        has_table_privilege(current_user, n.nspname || '.' || c.relname, 'REFERENCES') AS can_references,
        has_table_privilege(current_user, n.nspname || '.' || c.relname, 'TRIGGER') AS can_trigger
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND c.relname IN ('schema_migrations', 'bookings')
      ORDER BY c.relname
    `;
    const privRes = await client.query(privSql);

    if (privRes.rows.length === 0) {
      console.log('=== HAK AKSES TABEL ===');
      console.log('  (tabel tidak ada — tidak dapat memeriksa hak akses)');
      console.log('');
    } else {
      console.log('=== HAK AKSES TABEL ===');
      for (const row of privRes.rows) {
        console.log(`  [${row.table_schema}].${row.table_name}`);
        const privs = [
          ['SELECT',       row.can_select],
          ['INSERT',       row.can_insert],
          ['UPDATE',       row.can_update],
          ['DELETE',       row.can_delete],
          ['TRUNCATE',     row.can_truncate],
          ['REFERENCES',   row.can_references],
          ['TRIGGER',      row.can_trigger],
        ];
        for (const [label, granted] of privs) {
          console.log(`    ${label.padEnd(10)} : ${granted ? 'GRANTED' : 'DENIED'}`);
        }
        console.log('');
      }
    }

    // ── 4. Schema-level privileges for public ──
    const schemaPrivSql = `
      SELECT
        current_user AS user,
        'public' AS schema_name,
        has_schema_privilege(current_user, 'public', 'USAGE')  AS can_usage,
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create
    `;
    const schemaPrivRes = await client.query(schemaPrivSql);
    const sp = schemaPrivRes.rows[0];
    console.log('=== HAK AKSES SCHEMA public ===');
    console.log(`  USAGE  : ${sp.can_usage ? 'GRANTED' : 'DENIED'}`);
    console.log(`  CREATE : ${sp.can_create ? 'GRANTED' : 'DENIED'}`);
    console.log('');

    // ── 5. Guest table ownership check ──
    const guestOwnerSql = `
      SELECT
        n.nspname AS table_schema,
        c.relname AS table_name,
        pg_catalog.pg_get_userbyid(c.relowner) AS table_owner,
        CASE WHEN pg_catalog.pg_get_userbyid(c.relowner) = current_user THEN true ELSE false END AS is_current_user_owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND c.relname = 'bookings'
    `;
    const guestOwnerRes = await client.query(guestOwnerSql);
    console.log('=== KEPEMILIKAN TABEL bookings ===');
    if (guestOwnerRes.rows.length === 0) {
      console.log('  Tabel bookings tidak ditemukan.');
    } else {
      const row = guestOwnerRes.rows[0];
      console.log(`  [${row.table_schema}].${row.table_name}`);
      console.log(`  owner     : ${row.table_owner}`);
      console.log(`  current_user pemilik: ${row.is_current_user_owner ? 'YA' : 'TIDAK'}`);
    }
    console.log('');

    // ── 6. Role attributes for postgres and oak_app ──
    const roleAttrSql = `
      SELECT
        rolname,
        rolsuper   AS can_superuser,
        rolcreaterole AS can_create_role,
        rolcreatedb AS can_create_db,
        rolcanlogin AS can_login,
        rolinherit  AS can_inherit
      FROM pg_roles
      WHERE rolname IN ('postgres', 'oak_app')
      ORDER BY rolname
    `;
    const roleAttrRes = await client.query(roleAttrSql);
    console.log('=== ATRIBUT PERAN (role attributes) ===');
    if (roleAttrRes.rows.length === 0) {
      console.log('  Peran postgres atau oak_app tidak ditemukan di pg_roles.');
    } else {
      for (const row of roleAttrRes.rows) {
        console.log(`  [${row.rolname}]`);
        console.log(`    superuser     : ${row.can_superuser ? 'YA' : 'TIDAK'}`);
        console.log(`    create role   : ${row.can_create_role ? 'YA' : 'TIDAK'}`);
        console.log(`    create db     : ${row.can_create_db ? 'YA' : 'TIDAK'}`);
        console.log(`    can login     : ${row.can_login ? 'YA' : 'TIDAK'}`);
        console.log(`    inherit       : ${row.can_inherit ? 'YA' : 'TIDAK'}`);
        console.log('');
      }
    }

    // ── 7. Role memberships for postgres and oak_app ──
    const roleMemberSql = `
      SELECT
        m.roleid                    AS member_id,
        r_member.rolname            AS member_name,
        m.member                    AS member_oid,
        r_group.oid                 AS group_id,
        r_group.rolname             AS group_name,
        CASE WHEN r_group.rolname = 'cloudsqlsuperuser' THEN true ELSE false END AS is_cloudsqlsuperuser
      FROM pg_auth_members m
      JOIN pg_roles r_member ON r_member.oid = m.member
      JOIN pg_roles r_group  ON r_group.oid  = m.roleid
      WHERE r_member.rolname IN ('postgres', 'oak_app')
      ORDER BY r_member.rolname, r_group.rolname
    `;
    const roleMemberRes = await client.query(roleMemberSql);
    console.log('=== KEANGGOTAAN PERAN (role memberships) ===');
    if (roleMemberRes.rows.length === 0) {
      console.log('  postgres dan oak_app tidak menjadi anggota peran manapun (hanya superuser implicit).');
    } else {
      for (const row of roleMemberRes.rows) {
        console.log(`  [${row.member_name}] -> [${row.group_name}]${row.is_cloudsqlsuperuser ? ' *** cloudsqlsuperuser ***' : ''}`);
      }
    }
    console.log('');

    // ── 8. Specific cloudsqlsuperuser membership check ──
    const cloudSqlCheckSql = `
      SELECT
        r.rolname                                    AS role_name,
        CASE WHEN mg.rolname = 'cloudsqlsuperuser' THEN true ELSE false END AS is_cloudsqlsuperuser_member
      FROM pg_roles r
      LEFT JOIN pg_auth_members m ON m.member = r.oid
        LEFT JOIN pg_roles mg ON mg.oid = m.roleid AND mg.rolname = 'cloudsqlsuperuser'
      WHERE r.rolname IN ('postgres', 'oak_app')
      ORDER BY r.rolname
    `;
    const cloudSqlCheckRes = await client.query(cloudSqlCheckSql);
    console.log('=== CEK KEANGGOTAAN cloudsqlsuperuser ===');
    for (const row of cloudSqlCheckRes.rows) {
      console.log(`  [${row.role_name}] is cloudsqlsuperuser member: ${row.is_cloudsqlsuperuser_member ? 'YA' : 'TIDAK'}`);
    }
    console.log('');

    // ── 9. Role inheritance check (SELECT-only) ──
    const roleInheritSql = `
      SELECT
        current_user                                        AS current_user,
        pg_has_role(current_user, 'postgres', 'MEMBER')     AS is_postgres_member,
        pg_has_role(current_user, 'postgres', 'USAGE')      AS can_use_postgres_role
    `;
    const roleInheritRes = await client.query(roleInheritSql);
    const ri = roleInheritRes.rows[0];
    console.log('=== WARISAN PERAN (current_user) ===');
    console.log(`  current_user                   : ${ri.current_user}`);
    console.log(`  pg_has_role('postgres', MEMBER): ${ri.is_postgres_member ? 'YA' : 'TIDAK'}`);
    console.log(`  pg_has_role('postgres', USAGE) : ${ri.can_use_postgres_role ? 'YA' : 'TIDAK'}`);
    console.log('');

    const oakAppCheckSql = `
      SELECT
        'oak_app'                                  AS role_name,
        pg_has_role('oak_app', 'postgres', 'MEMBER') AS is_postgres_member,
        pg_has_role('oak_app', 'postgres', 'USAGE')  AS can_use_postgres_role
    `;
    const oakAppRes = await client.query(oakAppCheckSql);
    console.log('=== WARISAN PERAN (oak_app) ===');
    for (const row of oakAppRes.rows) {
      console.log(`  pg_has_role('oak_app', 'postgres', MEMBER): ${row.is_postgres_member ? 'YA' : 'TIDAK'}`);
      console.log(`  pg_has_role('oak_app', 'postgres', USAGE) : ${row.can_use_postgres_role ? 'YA' : 'TIDAK'}`);
    }
    console.log('');

    // ── 10. Active sessions for the built-in postgres role ──
    const pgActivitySql = `
      SELECT
        usename,
        application_name,
        client_addr,
        state,
        backend_type,
        COUNT(*) AS connection_count
      FROM pg_stat_activity
      WHERE usename = 'postgres'
      GROUP BY usename, application_name, client_addr, state, backend_type
      ORDER BY connection_count DESC
    `;
    const pgActivityRes = await client.query(pgActivitySql);
    console.log('=== SESI AKTIF (pg_stat_activity) ROLE "postgres" ===');
    if (pgActivityRes.rows.length === 0) {
      console.log('  Tidak ada sesi aktif untuk role postgres.');
    } else {
      for (const row of pgActivityRes.rows) {
        console.log(`  user       : ${row.usename}`);
        console.log(`  app_name   : ${row.application_name}`);
        console.log(`  client_addr: ${row.client_addr || '(local/undefined)'}`);
        console.log(`  state      : ${row.state}`);
        console.log(`  backend_type: ${row.backend_type}`);
        console.log(`  count      : ${row.connection_count}`);
        console.log('');
      }
    }
    console.log('');

    // ── Summary ──
    console.log('=== RINGKASAN ===');
    const schemaCreateAllowed = sp && sp.can_create && sp.can_usage;
    console.log(`  Hak akses schema public (USAGE + CREATE): ${schemaCreateAllowed ? 'GRANTED' : 'DENIED'}`);

    if (privRes.rows.length > 0) {
      const hasSchemaMigrationsPriv = privRes.rows.find(r =>
        r.table_name === 'schema_migrations' && r.can_select && r.can_insert
      );
      console.log(`  Hak akses schema_migrations (SELECT + INSERT): ${hasSchemaMigrationsPriv ? 'Cukup untuk marker migration' : 'BELUM CUKUP'}`);
    }

    const bookingsOwner = objects.find(r => r.table_name === 'bookings');
    console.log(`  Otoritas ALTER TABLE bookings: ${bookingsOwner && bookingsOwner.table_owner === user ? 'current_user adalah owner' : 'PERLU REVIEW OWNER / MIGRATION ROLE'}`);
    console.log('');
    console.log('CATATAN: Skrip ini hanya membaca. Tidak ada perubahan data atau struktur yang dilakukan.');

  } catch (err) {
    console.error('[REGION MIGRATION DIAGNOSTIC] Error:', err.message);
    process.exit(1);
  } finally {
    await client.release();
    await pool.end();
  }
}

run();
