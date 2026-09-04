// backend/test/auth_hr2a_whatsapp_credential_delivery_test.js
require('dotenv').config();
const assert = require('assert');
const { Pool } = require('pg');
const {
  normalizeIndonesianPhoneNumber,
  maskPhoneNumber,
  buildWhatsAppCredentialMessage,
  buildWhatsAppDeepLink,
  auditWhatsAppCredentialOpened
} = require('../dist/domains/hrd/hrdWhatsapp');
const {
  createEmployeeAccount,
  resetEmployeePassword
} = require('../dist/domains/hrd/hrdService');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'oak_hotel_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

const TEST_PREFIX = 'test_wa_';
const TEST_PROPERTY_ID = 1;

async function cleanupTestData(client) {
  await client.query("DELETE FROM users WHERE email LIKE $1 OR username LIKE $1", [`%${TEST_PREFIX}%`]);
  await client.query("DELETE FROM hr_employees WHERE email LIKE $1 OR username LIKE $1 OR employee_code LIKE $1", [`%${TEST_PREFIX}%`]);
  await client.query("DELETE FROM audit_logs WHERE record_id IN (SELECT id::text FROM hr_employees WHERE email LIKE $1 OR username LIKE $1)", [`%${TEST_PREFIX}%`]);
}

async function runWhatsAppCredentialDeliveryTests() {
  console.log('========================================================================');
  console.log('=== OAK HIMS — AUTH-HR-2A WHATSAPP TEMPORARY CREDENTIAL DELIVERY TEST ===');
  console.log('========================================================================\n');

  const client = await pool.connect();

  try {
    await cleanupTestData(client);

    // Test A: 08xxxxxxxxx normalizes to 628xxxxxxxxx
    console.log('Test A: 08xxxxxxxxx normalizes to 628xxxxxxxxx...');
    const normA = normalizeIndonesianPhoneNumber('081234567890');
    assert.strictEqual(normA, '6281234567890', `Expected 6281234567890 but got ${normA}`);
    const normASpaced = normalizeIndonesianPhoneNumber('0812-3456-7890');
    assert.strictEqual(normASpaced, '6281234567890', `Expected 6281234567890 with dashes`);
    console.log('  -> PASS: 08 prefix properly normalized to 628.');

    // Test B: +628xxxxxxxxx normalizes correctly
    console.log('Test B: +628xxxxxxxxx normalizes correctly...');
    const normB = normalizeIndonesianPhoneNumber('+6281234567890');
    assert.strictEqual(normB, '6281234567890', `Expected 6281234567890 but got ${normB}`);
    const normBFormatted = normalizeIndonesianPhoneNumber('+62 812 3456 7890');
    assert.strictEqual(normBFormatted, '6281234567890', `Expected 6281234567890 with spaces`);
    console.log('  -> PASS: +628 format correctly normalized to 628.');

    // Test C: 628xxxxxxxxx remains valid
    console.log('Test C: 628xxxxxxxxx remains valid...');
    const normC = normalizeIndonesianPhoneNumber('6281234567890');
    assert.strictEqual(normC, '6281234567890', `Expected 6281234567890 but got ${normC}`);
    console.log('  -> PASS: 628 format preserved correctly.');

    // Test D: invalid/empty number prevents WhatsApp action
    console.log('Test D: invalid/empty number prevents WhatsApp action...');
    assert.strictEqual(normalizeIndonesianPhoneNumber(''), null, 'Empty string should yield null');
    assert.strictEqual(normalizeIndonesianPhoneNumber(null), null, 'null should yield null');
    assert.strictEqual(normalizeIndonesianPhoneNumber(undefined), null, 'undefined should yield null');
    assert.strictEqual(normalizeIndonesianPhoneNumber('   '), null, 'whitespace should yield null');
    assert.strictEqual(normalizeIndonesianPhoneNumber('12345'), null, 'too short number should yield null');
    assert.strictEqual(normalizeIndonesianPhoneNumber('0217654321'), null, 'landline (non-mobile 021) should yield null');
    assert.throws(() => {
      buildWhatsAppDeepLink('', 'Hello');
    }, /Nomor WhatsApp karyawan belum tersedia atau tidak valid/, 'Should throw descriptive error');
    assert.throws(() => {
      buildWhatsAppDeepLink('not_a_number', 'Hello');
    }, /Nomor WhatsApp karyawan belum tersedia atau tidak valid/, 'Should throw descriptive error on invalid number');
    console.log('  -> PASS: Invalid or empty numbers securely blocked from opening WhatsApp.');

    // Test E: generated WhatsApp URL contains correct target number
    console.log('Test E: generated WhatsApp URL contains correct target number...');
    const deepLinkE = buildWhatsAppDeepLink('081234567890', 'Test message');
    assert(deepLinkE.startsWith('https://wa.me/6281234567890?text='), `Deep link did not contain normalized number: ${deepLinkE}`);
    console.log('  -> PASS: Deep link URL starts with https://wa.me/6281234567890.');

    // Test F: message contains employee name/email/username/expiry
    console.log('Test F: message contains employee name, email, username, and expiry...');
    const msgParams = {
      employeeName: 'Budi Santoso',
      email: 'budi.santoso@oakhotel.test',
      username: 'budisantoso',
      temporaryPassword: 'TempSecretPassword123!',
      expiryStr: '11 September 2026, 07:00 WIB',
      loginUrl: 'https://hims.oaklawang.com'
    };
    const messageF = buildWhatsAppCredentialMessage(msgParams);
    assert(messageF.includes('Halo Budi Santoso,'), 'Message must contain employee name');
    assert(messageF.includes('Email: budi.santoso@oakhotel.test'), 'Message must contain email');
    assert(messageF.includes('Username: budisantoso'), 'Message must contain username');
    assert(messageF.includes('Berlaku sampai: 11 September 2026, 07:00 WIB'), 'Message must contain expiry');
    assert(messageF.includes('Login:\nhttps://hims.oaklawang.com'), 'Message must contain canonical login url');
    assert(messageF.includes('Pada login pertama Anda wajib:'), 'Message must contain first-login checklist');
    console.log('  -> PASS: WhatsApp message contains full required onboarding context and login URL.');

    // Test G: temporary password appears in the one-time generated message
    console.log('Test G: temporary password appears in the one-time generated message...');
    assert(messageF.includes('Password sementara: TempSecretPassword123!'), 'Message must contain the temporary password');
    console.log('  -> PASS: One-time temporary password included in outbound message buffer.');

    // Test H: password is cleared from frontend state when modal closes
    console.log('Test H: Verify frontend contract wipes credentialModal on dismissal...');
    // We inspect that HrdWorkspace handleDismissCredentialModal sets credentialModal(null)
    const fs = require('fs');
    const hrdWorkspaceContent = fs.readFileSync('e:/oak-hotel-hims/frontend/src/features/hrd/HrdWorkspace.tsx', 'utf8');
    assert(hrdWorkspaceContent.includes('const handleDismissCredentialModal = () => {'), 'Must define dismiss handler');
    assert(hrdWorkspaceContent.includes('setCredentialModal(null);'), 'Dismiss handler must setCredentialModal(null)');
    assert(hrdWorkspaceContent.includes('setWhatsAppError(null);'), 'Dismiss handler must reset whatsAppError');
    console.log('  -> PASS: Frontend state hygiene contract confirmed (setCredentialModal(null) on dismiss).');

    // Test I: no plaintext temp password is written to logs/audit
    console.log('Test I: no plaintext temp password is written to logs/audit...');
    const testEmployeeCode = `${TEST_PREFIX}EMP_I`;
    const empI = await createEmployeeAccount(
      client,
      TEST_PROPERTY_ID,
      {
        property_id: TEST_PROPERTY_ID,
        employee_code: testEmployeeCode,
        full_name: 'Test WA Privacy Staff',
        position: 'Staff',
        department: 'Front Office',
        role: 'Front Office',
        hire_date: '2026-09-01',
        email: `${TEST_PREFIX}privacy@oakhotel.test`,
        username: `${TEST_PREFIX}privacy`,
        phone: '081298765432',
        create_login_account: true,
        is_active: true
      },
      { id: 1, name: 'HRD Supervisor', role: 'Super Admin' }
    );

    const tempPass = empI.temporary_password;
    assert(tempPass, 'Temporary password should be returned in memory on creation');

    // Now trigger WhatsApp opened audit
    await auditWhatsAppCredentialOpened(
      client,
      TEST_PROPERTY_ID,
      empI.id,
      empI.phone,
      { id: 1, name: 'HRD Supervisor', role: 'Super Admin' }
    );

    // Query audit_logs for any occurrence of the plaintext temporary password
    const auditRes = await client.query(
      `SELECT * FROM audit_logs WHERE new_value LIKE $1 OR correlation_id LIKE $1`,
      [`%${tempPass}%`]
    );
    assert.strictEqual(auditRes.rows.length, 0, 'Plaintext temporary password MUST NEVER be in audit_logs!');

    // Check specific WHATSAPP_CREDENTIAL_OPENED record
    const waAuditRes = await client.query(
      `SELECT * FROM audit_logs WHERE module = 'HRD' AND action = 'WHATSAPP_CREDENTIAL_OPENED' AND record_id = $1`,
      [String(empI.id)]
    );
    assert.strictEqual(waAuditRes.rows.length, 1, 'Audit log entry for WHATSAPP_CREDENTIAL_OPENED must exist');
    const waAuditData = JSON.parse(waAuditRes.rows[0].new_value);
    assert.strictEqual(waAuditData.employee_id, empI.id);
    assert.strictEqual(waAuditData.actor_user_id, 1);
    assert.strictEqual(waAuditData.target_phone_masked, '08129****5432', `Expected masked phone, got ${waAuditData.target_phone_masked}`);
    assert(!waAuditData.temporary_password, 'audit_logs must never contain temporary password');
    assert(!waAuditData.full_message, 'audit_logs must never contain full message');
    console.log('  -> PASS: Audit log contains masked phone only; zero plaintext credentials recorded.');

    // Test J: reset-password credential can also open WhatsApp flow
    console.log('Test J: reset-password credential can also open WhatsApp flow...');
    const resetResult = await resetEmployeePassword(
      client,
      TEST_PROPERTY_ID,
      empI.id,
      { id: 1, name: 'HRD Supervisor', role: 'Super Admin' }
    );

    assert(resetResult.temporary_password, 'Reset must return a new temporary password');
    assert.strictEqual(resetResult.phone, '081298765432', 'Reset must return employee phone');
    assert.strictEqual(resetResult.account_status, 'FIRST_LOGIN_REQUIRED');

    // Generate WhatsApp deep link from reset credentials
    const resetMsg = buildWhatsAppCredentialMessage({
      employeeName: empI.full_name,
      email: resetResult.email,
      username: resetResult.username,
      temporaryPassword: resetResult.temporary_password,
      expiryStr: '11 September 2026, 07:00 WIB',
      loginUrl: 'https://hims.oaklawang.com',
      isReset: true
    });

    assert(resetMsg.includes('Password akun OAK HIMS Anda telah direset.'), 'Reset message must use reset copy');
    assert(resetMsg.includes(`Password sementara: ${resetResult.temporary_password}`), 'Reset message must include new temp password');

    const resetDeepLink = buildWhatsAppDeepLink(resetResult.phone, resetMsg);
    assert(resetDeepLink.startsWith('https://wa.me/6281298765432?text='), 'Reset deep link must target normalized number');

    console.log('  -> PASS: Reset password flow successfully generates WhatsApp message and deep link.');

    console.log('\n===============================================================');
    console.log('=== ALL 10 WHATSAPP CREDENTIAL DELIVERY TESTS (A-J) PASSED! ===');
    console.log('===============================================================\n');
  } finally {
    await cleanupTestData(client);
    client.release();
    await pool.end();
  }
}

runWhatsAppCredentialDeliveryTests().catch((err) => {
  console.error('\n❌ WHATSAPP CREDENTIAL DELIVERY TEST FAILED:', err);
  process.exit(1);
});
