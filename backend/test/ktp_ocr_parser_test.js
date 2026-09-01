const { Pool } = require('pg');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Connect to test database using standard test env config
const connectionString = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || ('postgresql://' + (process.env.DB_USER || 'postgres') + ':' + (process.env.DB_PASSWORD || 'secretpassword') + '@' + (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 5432) + '/oak_hotel_db');

const pool = new Pool({ connectionString });

async function runTests() {
  console.log('--- STARTING CRM-1A LOCAL KTP OCR & IDENTITY SERVICE TESTS ---');
  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(err);
    }
  }

  async function testAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(err);
    }
  }

  // Load built TypeScript modules from dist
  const { parseKtpRawLines, normalizeNik, normalizeDate, normalizeGender, isPureLabel } = require('../dist/domains/identity/ktpParser');
  const { extractIdentityFromDocument, confirmVerifiedIdentity } = require('../dist/domains/identity/identityExtractionService');
  const { LocalPaddleOcrProvider, ManualOcrProvider, getOcrProvider } = require('../dist/domains/identity/identityOcrProvider');

  // --- PART 1: DETERMINISTIC KTP PARSER UNIT TESTS ---
  console.log('\n[1. Deterministic KTP Parser]');

  test('normalizeNik corrects common OCR character substitutions in 16-char sequence', () => {
    assert.strictEqual(normalizeNik('3174O5l2O59OO0Ol'), '3174051205900001');
    assert.strictEqual(normalizeNik(' : 3174 0512 0590 0001 '), '3174051205900001');
    assert.strictEqual(normalizeNik(null), null);
    assert.strictEqual(normalizeNik('ABC'), null); // too short
  });

  test('normalizeDate parses numeric and textual Indonesian dates to ISO YYYY-MM-DD', () => {
    assert.strictEqual(normalizeDate('12-05-1990'), '1990-05-12');
    assert.strictEqual(normalizeDate('JAKARTA 12-05-1990'), '1990-05-12');
    assert.strictEqual(normalizeDate('BANDUNG, 05/11/1985'), '1985-11-05');
    assert.strictEqual(normalizeDate('SURABAYA, 21 Agustus 1995'), '1995-08-21');
    assert.strictEqual(normalizeDate('invalid date text'), null);
  });

  test('normalizeGender parses Indonesian gender strings', () => {
    assert.strictEqual(normalizeGender('LAKI-LAKI'), 'MALE');
    assert.strictEqual(normalizeGender('PRIA'), 'MALE');
    assert.strictEqual(normalizeGender(': LAKI-LAKI'), 'MALE');
    assert.strictEqual(normalizeGender('PEREMPUAN'), 'FEMALE');
    assert.strictEqual(normalizeGender('WANITA'), 'FEMALE');
    assert.strictEqual(normalizeGender('TIDAK DIKETAHUI'), null);
  });

  test('parseKtpRawLines correctly parses complete single-line label/value pairs', () => {
    const lines = [
      'PROVINSI DKI JAKARTA',
      'JAKARTA SELATAN',
      'NIK : 3174051205900001',
      'Nama : BUDI SANTOSO',
      'Tempat/Tgl Lahir : JAKARTA, 12-05-1990',
      'Jenis Kelamin : LAKI-LAKI',
      'Alamat : JL SUDIRMAN NO. 45',
      'RT/RW : 005/002',
      'Kel/Desa : SENAYAN',
      'Kecamatan : KEBAYORAN BARU',
      'Agama : ISLAM',
      'Status Perkawinan : KAWIN',
      'Pekerjaan : KARYAWAN SWASTA',
      'Kewarganegaraan : WNI',
      'Berlaku Hingga : SEUMUR HIDUP'
    ];

    const result = parseKtpRawLines(lines, 0.98);
    assert.strictEqual(result.identity_number, '3174051205900001');
    assert.strictEqual(result.full_name, 'BUDI SANTOSO');
    assert.strictEqual(result.birth_place, 'JAKARTA');
    assert.strictEqual(result.birth_date, '1990-05-12');
    assert.strictEqual(result.gender, 'MALE');
    assert.strictEqual(result.address, 'JL SUDIRMAN NO. 45');
    assert.strictEqual(result.rt_rw, '005/002');
    assert.strictEqual(result.village_kelurahan, 'SENAYAN');
    assert.strictEqual(result.district_kecamatan, 'KEBAYORAN BARU');
    assert.strictEqual(result.religion, 'ISLAM');
    assert.strictEqual(result.marital_status, 'KAWIN');
    assert.strictEqual(result.occupation, 'KARYAWAN SWASTA');
    assert.strictEqual(result.citizenship, 'WNI');
    assert.strictEqual(result.valid_until, 'SEUMUR HIDUP');
    assert.ok(result.confidence >= 0.95, `Confidence ${result.confidence} should be >= 0.95`);
  });

  test('parseKtpRawLines handles multi-column / adjacent-line bounding box ordering', () => {
    const lines = [
      'PROVINSI DKI JAKARTA',
      'JAKARTA SELATAN',
      ': 3174051205900001',
      'NIK',
      'Nama',
      ': SITI AMINAH',
      'Tempat/Tgl Lahir',
      ': SURABAYA 25-12-1992',
      'Jenis Kelamin',
      ': PEREMPUAN',
      'Alamat',
      ': JL GATOT SUBROTO 12',
      'RT/RW',
      ': 001/003',
      'Kel/Desa',
      ': KUNINGAN BARAT',
      'Kecamatan',
      ': MAMPANG PRAPATAN',
      'Agama',
      ': ISLAM',
      'Status Perkawinan',
      ': BELUM KAWIN',
      'Pekerjaan',
      ': PEGAWAI NEGERI SIPIL',
      'Kewarganegaraan',
      ': WNI',
      'Berlaku Hingga',
      ': SEUMUR HIDUP'
    ];

    const result = parseKtpRawLines(lines, 0.95);
    assert.strictEqual(result.identity_number, '3174051205900001');
    assert.strictEqual(result.full_name, 'SITI AMINAH');
    assert.strictEqual(result.birth_place, 'SURABAYA');
    assert.strictEqual(result.birth_date, '1992-12-25');
    assert.strictEqual(result.gender, 'FEMALE');
    assert.strictEqual(result.address, 'JL GATOT SUBROTO 12');
    assert.strictEqual(result.village_kelurahan, 'KUNINGAN BARAT');
    assert.strictEqual(result.district_kecamatan, 'MAMPANG PRAPATAN');
    assert.strictEqual(result.marital_status, 'BELUM KAWIN');
  });

  test('parseKtpRawLines strictly returns null for missing or unparseable fields (never fabricates)', () => {
    const lines = ['BEBERAPA TEKS ACAK', 'TIDAK ADA LABEL KTP'];
    const result = parseKtpRawLines(lines, 0.5);
    assert.strictEqual(result.identity_number, null);
    assert.strictEqual(result.full_name, null);
    assert.strictEqual(result.birth_place, null);
    assert.strictEqual(result.birth_date, null);
    assert.strictEqual(result.gender, null);
    assert.strictEqual(result.address, null);
    assert.strictEqual(result.recognized_fields_count, 0);
    assert.strictEqual(result.confidence, 0.0);
  });

  test('parseKtpRawLines handles OCR typos like Narna, N1K, Te mpat, Ala mat, Kel.Desa', () => {
    const lines = [
      'PROVINSI JAWA BARAT',
      'N1K : 3201011205900002',
      'Narna : AHMAD FAUZI',
      'Te mpat/Tgl Lahir : BOGOR 15-08-1988',
      'Jenis Kelamln : LAK1-LAK1',
      'Ala mat : JL PAJAJARAN NO. 12',
      'RT/ RW : 002/004',
      'Kel.Desa : BABAKAN',
      'Kecamatan : BOGOR TENGAH',
      'Agama : ISLAM',
      'Status Perkawlnan : BELUM KAWIN',
      'Pekerjaan : WIRASWASTA',
      'Kewarganegaraar : WNI',
      'Berlaku : SEUMUR H!DUP'
    ];

    const result = parseKtpRawLines(lines, 0.92);
    assert.strictEqual(result.identity_number, '3201011205900002');
    assert.strictEqual(result.full_name, 'AHMAD FAUZI');
    assert.strictEqual(result.birth_place, 'BOGOR');
    assert.strictEqual(result.birth_date, '1988-08-15');
    assert.strictEqual(result.gender, 'MALE');
    assert.strictEqual(result.address, 'JL PAJAJARAN NO. 12');
    assert.strictEqual(result.rt_rw, '002/004');
    assert.strictEqual(result.village_kelurahan, 'BABAKAN');
    assert.strictEqual(result.district_kecamatan, 'BOGOR TENGAH');
    assert.strictEqual(result.religion, 'ISLAM');
    assert.strictEqual(result.marital_status, 'BELUM KAWIN');
    assert.strictEqual(result.occupation, 'WIRASWASTA');
    assert.strictEqual(result.citizenship, 'WNI');
    assert.strictEqual(result.valid_until, 'SEUMUR HIDUP');
    assert.strictEqual(result.recognized_fields_count, 13);
    assert.ok(result.confidence > 0.85);
  });

  test('parseKtpRawLines handles label block output correctly (Issue CRM-1A regression)', () => {
    const lines = [
      'NIK',
      'Nama',
      'Tempat/Tgl Lahir',
      'Jenis kelamin',
      'Alamat',
      'RT/RW',
      'Kel/Desa',
      'Kecamatan',
      'Agama',
      'PROVINSI JAWA TIMUR',
      'KABUPATEN LUMAJANG',
      ': 3508016702910001',
      'EKA FEBRIANTI WULANDARI',
      'LUMAJANG, 27-02-1991',
      ': PEREMPUAN',
      'KARANG MENJANGAN',
      '012/005',
      'BULUREJO',
      'TEMPURSARI',
      'ISLAM',
      'Status Perkawinan: KAWIN',
      'Pekerjaan',
      ': KARYAWAN SWASTA',
      'Kewarganegaraan: WNI',
      'Berlaku Hingga : SEUMUR HIDUP'
    ];

    const result = parseKtpRawLines(lines, 0.95);
    assert.strictEqual(result.identity_number, '3508016702910001');
    assert.strictEqual(result.full_name, 'EKA FEBRIANTI WULANDARI');
    assert.strictEqual(result.birth_place, 'LUMAJANG');
    assert.strictEqual(result.birth_date, '1991-02-27');
    assert.strictEqual(result.gender, 'FEMALE');
    assert.strictEqual(result.address, 'KARANG MENJANGAN');
    assert.strictEqual(result.rt_rw, '012/005');
    assert.strictEqual(result.village_kelurahan, 'BULUREJO');
    assert.strictEqual(result.district_kecamatan, 'TEMPURSARI');
    assert.strictEqual(result.religion, 'ISLAM');
    assert.strictEqual(result.marital_status, 'KAWIN');
    assert.strictEqual(result.occupation, 'KARYAWAN SWASTA');
    assert.strictEqual(result.citizenship, 'WNI');
    assert.strictEqual(result.valid_until, 'SEUMUR HIDUP');
  });

  
  test('parseKtpRawLines correctly falls back to legacy inline parser for noisy labels (Case C)', () => {
    const lines = ['ING Nama : BUDI SANTOSO'];
    const result = parseKtpRawLines(lines);
    assert.strictEqual(result.full_name, 'BUDI SANTOSO');
  });

  test('parseKtpRawLines correctly parses complete inline with generic text without shifting (Case B)', () => {
    const lines = ['Nama : BUDI SANTOSO', 'Alamat : JL MERDEKA', 'RT/RW : 001/002', 'Kel/Desa : SUKAMAJU', 'Kecamatan : LOWOKWARU'];
    const result = parseKtpRawLines(lines);
    assert.strictEqual(result.full_name, 'BUDI SANTOSO');
    assert.strictEqual(result.address, 'JL MERDEKA');
    assert.strictEqual(result.rt_rw, '001/002');
    assert.strictEqual(result.village_kelurahan, 'SUKAMAJU');
    assert.strictEqual(result.district_kecamatan, 'LOWOKWARU');
  });

  test('parseKtpRawLines supports valid_until block layouts (Case D)', () => {
    const lines = ['Berlaku Hingga', 'SEUMUR HIDUP'];
    const result = parseKtpRawLines(lines);
    assert.strictEqual(result.valid_until, 'SEUMUR HIDUP');
  });

  test('parseKtpRawLines does not blindly shift values if validators fail (Case E)', () => {
    const lines = ['NIK', 'Nama', 'Alamat', 'Kel/Desa', 'Kecamatan', ': 1234567890123456', 'BUDI', 'JL PUSAT', 'SUKAMAJU', 'LOWOKWARU'];
    const result = parseKtpRawLines(lines);
    assert.strictEqual(result.identity_number, '1234567890123456');
    assert.strictEqual(result.full_name, 'BUDI');
    assert.strictEqual(result.address, 'JL PUSAT');
    assert.strictEqual(result.rt_rw, null); // Shouldn't shift SUKAMAJU here
    assert.strictEqual(result.village_kelurahan, 'SUKAMAJU');
  });

  test('parseKtpRawLines supports standalone legacy occupation (Case F)', () => {
    const lines = ['Pekerjaan', 'KARYAWAN SWASTA'];
    const result = parseKtpRawLines(lines);
    assert.strictEqual(result.occupation, 'KARYAWAN SWASTA');
  });

  test('parseKtpRawLines filters header noise after NIK and correctly extracts name and fields (Requirement 5)', () => {
    const lines = [
      'NIK',
      'Nama',
      'Tempat/Tgl Lahir',
      'Jenis Kelamin',
      'Alamat',
      'RT/RW',
      'Kel/Desa',
      'Kecamatan',
      ': 3508016702910001',
      'KABUPATEN LUMAJANG',
      'BUDI SANTOSO',
      'LUMAJANG, 01-01-1990',
      'LAKI-LAKI',
      'JL MERDEKA',
      '001/002',
      'SUKAMAJU',
      'LOWOKWARU'
    ];
    const result = parseKtpRawLines(lines);
    assert.strictEqual(result.identity_number, '3508016702910001');
    assert.strictEqual(result.full_name, 'BUDI SANTOSO');
    assert.strictEqual(result.birth_place, 'LUMAJANG');
    assert.strictEqual(result.birth_date, '1990-01-01');
    assert.strictEqual(result.gender, 'MALE');
    assert.strictEqual(result.address, 'JL MERDEKA');
    assert.strictEqual(result.rt_rw, '001/002');
    assert.strictEqual(result.village_kelurahan, 'SUKAMAJU');
    assert.strictEqual(result.district_kecamatan, 'LOWOKWARU');
  });

  test('isPureLabel correctly distinguishes pure labels from inline values (Requirement 6)', () => {
    // Pure labels
    assert.strictEqual(isPureLabel('Nama'), true);
    assert.strictEqual(isPureLabel('NIK'), true);
    assert.strictEqual(isPureLabel('Alamat'), true);
    assert.strictEqual(isPureLabel('RT/RW'), true);
    assert.strictEqual(isPureLabel('Kel/Desa'), true);
    assert.strictEqual(isPureLabel('Kecamatan'), true);
    assert.strictEqual(isPureLabel('Agama'), true);
    assert.strictEqual(isPureLabel('Pekerjaan'), true);
    assert.strictEqual(isPureLabel('Berlaku Hingga'), true);
    assert.strictEqual(isPureLabel('Berlaku Hingga :'), true);

    // Inline values (MUST be false)
    assert.strictEqual(isPureLabel('Nama : BUDI SANTOSO'), false);
    assert.strictEqual(isPureLabel('Alamat : JL MERDEKA'), false);
    assert.strictEqual(isPureLabel('Desa Sukamaju'), false);
    assert.strictEqual(isPureLabel('Kecamatan LOWOKWARU'), false);
    assert.strictEqual(isPureLabel('Status Perkawinan: KAWIN'), false);
    assert.strictEqual(isPureLabel('Berlaku Hingga : SEUMUR HIDUP'), false);
  });

  // --- PART 2: OCR PROVIDER ADAPTERS ---
  console.log('\n[2. OCR Provider Adapters]');

  await testAsync('ManualOcrProvider returns empty raw lines and does not throw', async () => {
    const manual = new ManualOcrProvider();
    const available = await manual.isAvailable();
    assert.strictEqual(available, true);
    assert.strictEqual(manual.providerName, 'MANUAL');

    const res = await manual.extractRawLines('dummy.png');
    assert.strictEqual(res.provider, 'MANUAL');
    assert.deepStrictEqual(res.raw_lines, []);
  });

  await testAsync('LocalPaddleOcrProvider executes python worker and extracts synthetic KTP text', async () => {
    const syntheticImg = path.resolve(__dirname, '../ocr/synthetic_test_ktp.png');
    if (!fs.existsSync(syntheticImg)) {
      console.log('    [Skip] synthetic_test_ktp.png not present, skipping live worker run');
      return;
    }

    const localProvider = new LocalPaddleOcrProvider();
    const available = await localProvider.isAvailable();
    assert.strictEqual(available, true);

    const out = await localProvider.extractRawLines(syntheticImg, { timeoutMs: 25000 });
    assert.strictEqual(out.provider, 'LOCAL_PADDLE_OCR');
    assert.ok(out.raw_lines.length > 5, 'Should have extracted multiple text lines');
    assert.ok(out.confidence > 0.8, 'Confidence should be high on synthetic image');
  });

  // --- PART 3: IDENTITY EXTRACTION SERVICE & DUPLICATE NIK DETECTION ---
  console.log('\n[3. Identity Extraction Service & Duplicate Detection]');

  let fixtureGuestId = null;
  const testNik = '3174998877660001';

  await testAsync('Setup fixture guest in CRM database with known NIK', async () => {
    // Teardown any leftover
    await pool.query('DELETE FROM guests WHERE normalized_identity_number = $1', [testNik]);

    const res = await pool.query(
      `INSERT INTO guests (
         full_name, normalized_name, phone, normalized_phone, identity_number, normalized_identity_number,
         identity_type, has_valid_identity, created_property_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'KTP', TRUE, 1)
       RETURNING id, guest_code`,
      ['AGUS SETIAWAN', 'agus setiawan', '081299998888', '081299998888', testNik, testNik]
    );
    fixtureGuestId = res.rows[0].id;
    assert.ok(fixtureGuestId > 0);
  });

  await testAsync('extractIdentityFromDocument flags DUPLICATE_NIK_FOUND when NIK matches existing guest', async () => {
    const syntheticImg = path.resolve(__dirname, '../ocr/synthetic_test_ktp.png');
    // We simulate by passing a synthetic image or mocked file
    // To test service integration with DB duplicate detection:
    const res = await extractIdentityFromDocument(
      pool,
      syntheticImg,
      '/api/identity/document/test.png',
      {
        property_id: 1,
        guest_name: 'Budi Santoso',
        guest_id: null // new guest
      }
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'REVIEW_REQUIRED');
    assert.ok(res.data.identity_number !== null);
  });

  await testAsync('extractIdentityFromDocument flags NAME_MISMATCH_DETECTED when guest_name differs from OCR name', async () => {
    const syntheticImg = path.resolve(__dirname, '../ocr/synthetic_test_ktp.png');
    const res = await extractIdentityFromDocument(
      pool,
      syntheticImg,
      '/api/identity/document/test.png',
      {
        property_id: 1,
        guest_name: 'HENDRA WIJAYA', // Mismatched name
        guest_id: null
      }
    );

    assert.strictEqual(res.success, true);
    assert.ok(res.name_mismatch !== null, 'Should detect name mismatch');
    assert.strictEqual(res.name_mismatch.is_mismatch, true);
    assert.strictEqual(res.name_mismatch.entered_name, 'HENDRA WIJAYA');
    assert.ok(res.warnings.includes('NAME_MISMATCH_DETECTED'));
  });

  // --- PART 4: CONFIRMATION & CANONICAL CRM UPDATE ---
  console.log('\n[4. Identity Confirmation & CRM Update]');

  await testAsync('confirmVerifiedIdentity updates existing guest and sets has_valid_identity = TRUE', async () => {
    assert.ok(fixtureGuestId, 'Fixture guest must exist');

    const confirmed = await confirmVerifiedIdentity(pool, {
      guest_id: fixtureGuestId,
      property_id: 1,
      name: 'AGUS SETIAWAN PERDANA',
      phone: '081299998888',
      nik: testNik,
      birth_place: 'JAKARTA',
      birth_date: '1988-10-15',
      gender: 'MALE',
      address: 'JL KEMANG RAYA NO 10',
      identity_path: '/api/identity/document/ktp-test-01.png',
      identity_type: 'KTP'
    });

    assert.strictEqual(confirmed.id, fixtureGuestId);
    assert.strictEqual(confirmed.full_name, 'AGUS SETIAWAN PERDANA');
    assert.strictEqual(confirmed.has_valid_identity, true);
    assert.strictEqual(confirmed.birth_place, 'JAKARTA');
    assert.strictEqual(confirmed.identity_path, '/api/identity/document/ktp-test-01.png');

    // Verify in DB directly
    const dbCheck = await pool.query('SELECT * FROM guests WHERE id = $1', [fixtureGuestId]);
    assert.strictEqual(dbCheck.rows[0].has_valid_identity, true);
    assert.strictEqual(dbCheck.rows[0].normalized_name, 'agus setiawan perdana');
    assert.strictEqual(dbCheck.rows[0].normalized_identity_number, testNik);
  });

  await testAsync('confirmVerifiedIdentity creates new guest with unique guest_code if not existing', async () => {
    const newNik = '3578001122330005';
    // Clean any prior
    await pool.query('DELETE FROM guests WHERE normalized_identity_number = $1', [newNik]);

    const created = await confirmVerifiedIdentity(pool, {
      property_id: 1,
      name: 'RATNA SARUMPET',
      phone: '081377778888',
      nik: newNik,
      birth_place: 'SURABAYA',
      birth_date: '1991-03-20',
      gender: 'FEMALE',
      address: 'JL DARMO NO 5',
      identity_path: '/api/identity/document/ktp-test-02.png',
      identity_type: 'KTP'
    });

    assert.ok(created.id > 0);
    assert.ok(created.guest_code.startsWith('GST-'));
    assert.strictEqual(created.has_valid_identity, true);
    assert.strictEqual(created.gender, 'FEMALE');

    // Clean up created test row
    await pool.query('DELETE FROM guests WHERE id = $1', [created.id]);
  });

  // --- CLEANUP ---
  console.log('\n[5. Teardown]');
  await testAsync('Clean up test fixture guests and restore invariant state', async () => {
    if (fixtureGuestId) {
      await pool.query('DELETE FROM guests WHERE id = $1', [fixtureGuestId]);
    }
    await pool.query('DELETE FROM guests WHERE normalized_identity_number = $1', [testNik]);
  });

  console.log(`\n========================================`);
  console.log(`TEST SUMMARY: ${passed} / ${total} PASSED (${total - passed} FAILED)`);
  console.log(`========================================\n`);

  if (passed !== total) {
    process.exit(1);
  }
}

runTests()
  .catch((err) => {
    console.error('Test runner fatal error:', err);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
