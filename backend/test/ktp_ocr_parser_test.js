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
  const { persistIdentityDocument, deleteIdentityDocument } = require('../dist/domains/identity/identityDocumentStorageService');
  const { createPendingIdentityDocumentUpload } = require('../dist/domains/identity/identityDocumentUploadService');

  // Force local filesystem storage adapter so identity files are deletable
  const { setStorageAdapterForTesting, LocalStorageAdapter } = require('../dist/domains/auth/faceEnrollmentStorageService');
  setStorageAdapterForTesting(new LocalStorageAdapter());

  // ── Minimal 1×1 valid JPEG (SOI + APP0 + SOS/EOI without DHT/SOF data) ──
  // Accepted by isValidIdentityDocumentContent: starts 0xFF 0xD8 0xFF
  const JPEG_1X1 = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x08, 0x09,
    0x0A, 0x0A, 0x09, 0x0A, 0x0A, 0x0C, 0x0F, 0x0E, 0x0A, 0x0D, 0x10, 0x0F,
    0x0E, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A,
    0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
    0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02,
    0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00,
    0xB5, 0x10, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02,
    0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x10, 0x00, 0x02,
    0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00,
    0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x02, 0x12, 0x31,
    0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x21, 0x71, 0x14, 0x32, 0x81, 0x91,
    0x08, 0x22, 0xA1, 0xB1, 0xC1, 0x15, 0x42, 0xDA, 0x52, 0xE1, 0x23, 0x33,
    0xF1, 0x09, 0x24, 0x16, 0x43, 0x53, 0xFA, 0x25, 0x34, 0x63, 0x73, 0x0A,
    0x17, 0x83, 0x93, 0x44, 0x54, 0xFB, 0x64, 0x74, 0xE3, 0x26, 0x35, 0xF3,
    0x84, 0xD3, 0x45, 0x94, 0x75, 0x54, 0xF4, 0x65, 0x75, 0x76, 0x77, 0x78,
    0x79, 0x7A, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x95, 0x96, 0x97, 0x98,
    0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2,
    0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5,
    0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8,
    0xD9, 0xDA, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF2,
    0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA,
    0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x08, 0x00, 0x3D, 0x00, 0x7F,
    0xFF, 0xD9
  ]);
  const JPEG_SIZE = JPEG_1X1.length;

  // ── Tracks so cleanup can remove everything created by this test ──
  const track = {
    fixtureGuestId: null,
    actorUserId: null,
    uploadFixtures: [],   // { documentUploadId, storageKey }
  };

  // ── PART 1: DETERMINISTIC KTP PARSER UNIT TESTS ---
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

  // Regression test for merged-line OCR: PaddleOCR merges birth_place + date + full_name + Gol.Darah
  // into a single line. The parser must use the date as structural anchor to extract fields correctly.
  test('parseKtpRawLines handles merged-line OCR with date anchor for birth_place + full_name extraction', () => {
    const lines = [
      'akan properti hotel ice, laundry, dll.)',
      '/QRIS',
      'KABUPATEN PURBALINGGA PROVINSI JAWA TENGAH',
      'n sepenuhny M13 3303050104860001',
      'ayanan kam rusakan,jun Tempat/Tgl Lahir Nama SURABAYA.01-04-1986 INDRAJAYA APRILIANTO Gol.Darah',
      'Jenis kelamin LAKI-LAKI PURBALINGGALOR',
      'Alamat RT/RW 004/006 PURBALINGGALOR',
      'gunakan kart Kecamatan PURBALINGGA Kel/Desa ISLAM',
      'Status Perkawinan:BELUM KAWiN Agama KARYAWAN SWASTA PURBALINGGA 08-07-2025',
      'npir. Kewarganegaraan:WNI Pekerjaan SEUMUR HIDUP',
      'Berlaku Hingga',
      'enyatakan tel',
      'uan memahami syarat dan ketentuan hotel'
    ];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.identity_number, '3303050104860001', 'NIK must be extracted from noisy line');
    assert.strictEqual(result.full_name, 'INDRAJAYA APRILIANTO', 'full_name must use date anchor, not header city');
    assert.strictEqual(result.birth_place, 'SURABAYA', 'birth_place must be extracted before date');
    assert.strictEqual(result.birth_date, '1986-04-01', 'birth_date must be parsed correctly');
    assert.strictEqual(result.gender, 'MALE', 'gender must be detected from merged line');
  });

  // Regression test for multi-word birth place with merged-line OCR
  test('parseKtpRawLines handles multi-word birth place in merged-line OCR', () => {
    // "Tempat/Tgl Lahir" label should preserve multi-word places like "JAKARTA SELATAN"
    // The parser must not reduce to the last word ("SELATAN")
    const lines = ['noise junk Tempat/Tgl Lahir Nama JAKARTA SELATAN.01-04-1986 BUDI SANTOSO Gol.Darah'];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.identity_number, null, 'No NIK in this test');
    assert.strictEqual(result.full_name, 'BUDI SANTOSO', 'full_name must use date anchor');
    assert.strictEqual(result.birth_place, 'JAKARTA SELATAN', 'birth_place must preserve multi-word');
    assert.strictEqual(result.birth_date, '1986-04-01', 'birth_date must be parsed correctly');
  });

  // Safety regression: two shorter digit runs that concatenate to >=16 digits must NOT
  // produce a false NIK. Only exact 16-digit runs (or exact 16-digit candidates) are valid.
  test('parseKtpRawLines rejects concatenated short digit runs as false NIK', () => {
    // Two 10-digit runs: "1234567890" + "1234567890" = 20 digits concatenated,
    // but neither run is exactly 16 digits. The parser must return null.
    const lines = ['1234567890 1234567890'];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.identity_number, null, 'Must not extract false NIK from concatenated short digit runs');
  });

  // Safety regression: two 8-digit runs separated by text produce 16 concatenated digits,
  // but OCR boundaries are two separate runs. Must NOT extract a false NIK.
  test('parseKtpRawLines rejects mixed short digit runs even when concatenation is 16 digits', () => {
    // "12345678" + "87654321" → "1234567887654321" (16 digits total) but two separate OCR runs.
    // A sliding-window or strip-non-digits approach would falsely accept this.
    const lines = ['12345678 abc 87654321'];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.identity_number, null, 'Must not extract false NIK from separate digit runs concatenated to 16 digits');
  });

  // Positive noisy-line regression: an exact 16-digit run embedded in noise must still be found.
  test('parseKtpRawLines extracts 16-digit NIK embedded in noisy text with separate digit runs', () => {
    // "3303050104860001" is a contiguous 16-digit run; "13" and "xyz" are separate runs.
    // This proves the digit-run boundary check does not break legitimate noisy-line extraction.
    const lines = ['13 abc 3303050104860001 xyz'];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.identity_number, '3303050104860001', 'Must extract exact 16-digit run embedded in noise');
  });

  // Regression test: merged-line parsing of full_name/birth_place/birth_date/gender
  // must not prevent legacy fallback from populating other fields like address.
  test('parseKtpRawLines fills legacy-readable fields (e.g. address) after merged-line success', () => {
    const lines = [
      'noise junk Tempat/Tgl Lahir Nama JAKARTA SELATAN.01-04-1986 BUDI SANTOSO Gol.Darah',
      'Alamat : JL MERDEKA 10'
    ];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.full_name, 'BUDI SANTOSO', 'full_name from merged-line');
    assert.strictEqual(result.birth_place, 'JAKARTA SELATAN', 'birth_place from merged-line');
    assert.strictEqual(result.birth_date, '1986-04-01', 'birth_date from merged-line');
    assert.strictEqual(result.address, 'JL MERDEKA 10', 'address must still be filled by legacy fallback');
  });

  // Regression test: unrelated status/date line must not hijack birth fields.
  test('parseKtpRawLines does not hijack birth fields from unrelated status/date lines', () => {
    // "Status Perkawinan:BELUM KAWIN PURBALINGGA 08-07-2025" contains a date but no birth label.
    // It must NOT populate birth_place or birth_date.
    const lines = [
      'Nama BUDI SANTOSO',
      'Status Perkawinan:BELUM KAWIN PURBALINGGA 08-07-2025'
    ];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.full_name, 'BUDI SANTOSO');
    assert.strictEqual(result.birth_place, null, 'birth_place must not come from status line');
    assert.strictEqual(result.birth_date, null, 'birth_date must not come from status line');
  });

  // Regression test: valid-until line must not fabricate birth data.
  test('parseKtpRawLines does not treat valid-until line as birth data', () => {
    const lines = ['Berlaku Hingga : 08-07-2025'];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.birth_place, null, 'birth_place must be null');
    assert.strictEqual(result.birth_date, null, 'birth_date must be null');
    assert.strictEqual(result.full_name, null, 'full_name must be null');
    assert.strictEqual(result.valid_until, '2025-07-08', 'valid_until should still be parsed');
  });

  // Regression test A: date BEFORE label must not produce birth data.
  test('parseKtpRawLines rejects date-before-label as birth data (A)', () => {
    const lines = ['08-07-2025 Tempat/Tgl Lahir'];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.birth_date, null, 'birth_date must be null when date precedes label');
    assert.strictEqual(result.birth_place, null, 'birth_place must be null when date precedes label');
    assert.strictEqual(result.full_name, null, 'full_name must be null');
  });

  // Regression test B: "Tempat Tinggal" (residence, not birth) must not become birth data.
  test('parseKtpRawLines rejects "Tempat Tinggal" as birth data (B)', () => {
    const lines = ['Tempat Tinggal : MALANG 08-07-2025'];
    const result = parseKtpRawLines(lines, 0.9);
    assert.strictEqual(result.birth_date, null, 'birth_date must be null for residence line');
    assert.strictEqual(result.birth_place, null, 'birth_place must be null for residence line');
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
    track.fixtureGuestId = res.rows[0].id;
    assert.ok(track.fixtureGuestId > 0);
  });

  // Preserve and force MANUAL OCR provider for the two extraction-service tests below.
  // getOcrProvider() reads these env vars on every call; setting IDENTITY_OCR_ENABLED=false
  // makes it return ManualOcrProvider regardless of whether synthetic_test_ktp.png exists.
  const originalOcrEnabled = process.env.IDENTITY_OCR_ENABLED;
  const originalOcrProvider = process.env.IDENTITY_OCR_PROVIDER;
  process.env.IDENTITY_OCR_ENABLED = 'false';
  delete process.env.IDENTITY_OCR_PROVIDER;

  try {

  // Test 1 — ManualOcrProvider always returns empty raw_lines.
  // extractIdentityFromDocument takes the early-return branch: status = MANUAL_REVIEW_REQUIRED,
  // candidate fields are all null.  The duplicate-NIK check runs only when candidate.identity_number
  // is truthy, so with no OCR data it is skipped — no DUPLICATE_NIK_FOUND warning is emitted.
  await testAsync('extractIdentityFromDocument returns MANUAL_REVIEW_REQUIRED when manual provider produces no OCR data', async () => {
    const syntheticImg = path.resolve(__dirname, '../ocr/synthetic_test_ktp.png');
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
    assert.strictEqual(res.provider, 'MANUAL');
    assert.strictEqual(res.status, 'MANUAL_REVIEW_REQUIRED');
    assert.deepStrictEqual(res.raw_lines, []);
    // No identity_number → duplicate-NIK check is skipped entirely.
    assert.ok(!res.warnings.includes('DUPLICATE_NIK_FOUND'));
    assert.strictEqual(res.duplicate_candidate, null);
    // All identity fields remain null — the service must not fabricate data.
    assert.strictEqual(res.data.identity_number, null);
    assert.strictEqual(res.data.full_name, null);
  });

  // Test 2 — With the manual provider candidate.full_name is always null, so the
  // name-mismatch branch (which requires both options.guest_name AND candidate.full_name
  // to be truthy) never fires.  No NAME_MISMATCH_DETECTED warning is produced.
  await testAsync('extractIdentityFromDocument does not fabricate NAME_MISMATCH when manual provider returns no OCR name', async () => {
    const syntheticImg = path.resolve(__dirname, '../ocr/synthetic_test_ktp.png');
    const res = await extractIdentityFromDocument(
      pool,
      syntheticImg,
      '/api/identity/document/test.png',
      {
        property_id: 1,
        guest_name: 'HENDRA WIJAYA', // intentionally different — but OCR is empty
        guest_id: null
      }
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.provider, 'MANUAL');
    assert.strictEqual(res.status, 'MANUAL_REVIEW_REQUIRED');
    assert.deepStrictEqual(res.raw_lines, []);
    // No OCR name means no mismatch can be computed.
    assert.strictEqual(res.name_mismatch, null);
    assert.ok(!res.warnings.includes('NAME_MISMATCH_DETECTED'));
    assert.ok(!res.warnings.includes('NO_KTP_FIELDS_RECOGNIZED'));
  });

  } finally {
    // Restore original env values so subsequent tests and callers see the original state.
    if (originalOcrEnabled === undefined) {
      delete process.env.IDENTITY_OCR_ENABLED;
    } else {
      process.env.IDENTITY_OCR_ENABLED = originalOcrEnabled;
    }
    if (originalOcrProvider === undefined) {
      delete process.env.IDENTITY_OCR_PROVIDER;
    } else {
      process.env.IDENTITY_OCR_PROVIDER = originalOcrProvider;
    }
  }

  // --- PART 4: CONFIRMATION & CANONICAL CRM UPDATE ---
  console.log('\n[4. Identity Confirmation & CRM Update]');

  // Seed a valid regency id for the new-guest ktp_regency_id regression assertion.
  await testAsync('Load a valid regency id from the regencies table', async () => {
    const res = await pool.query('SELECT id FROM regencies ORDER BY id LIMIT 1');
    assert.ok(res.rows.length > 0, 'regencies table must have at least one row');
    track.regencyId = Number(res.rows[0].id);
    assert.ok(track.regencyId > 0, 'regency id must be a positive integer');
  });

  // Create a dedicated actor user (Front Office role_id=2) scoped to property 1.
  // Uses Date.now() to avoid collisions between test runs.
  await testAsync('Create test actor user in property 1 with role_id 2', async () => {
    const ts = Date.now();
    const username = `oak_test_actor_${ts}`;
    const email = `${username}@test.oak`;
    // Reset password_hash to empty — confirmVerifiedIdentity does not use it.
    const res = await pool.query(
      `INSERT INTO users (username, email, full_name, password_hash, role_id, property_id, is_active, is_test_data)
       VALUES ($1, $2, $3, '', 2, 1, true, true)
       RETURNING id`,
      [username, email, username]
    );
    track.actorUserId = res.rows[0].id;
    assert.ok(track.actorUserId > 0);
  });

  // Helper: create one identity upload fixture and persist the physical file.
  // Returns { documentUploadId, storageKey } so the caller can feed it into confirmVerifiedIdentity.
  async function createIdentityUploadFixture(pool, actorUserId, propertyId) {
    const persistResult = await persistIdentityDocument({
      propertyId,
      buffer: JPEG_1X1,
      mimeType: 'image/jpeg',
      originalFilename: 'test-ktp-confirm.jpg',
      size: JPEG_SIZE
    });
    const upload = await createPendingIdentityDocumentUpload(pool, {
      propertyId,
      uploadedByUserId: actorUserId,
      persistResult
    });
    track.uploadFixtures.push({
      documentUploadId: upload.documentUploadId,
      storageKey: persistResult.storageKey
    });
    return { documentUploadId: upload.documentUploadId, storageKey: persistResult.storageKey };
  }

  await testAsync('confirmVerifiedIdentity updates existing guest and sets has_valid_identity = TRUE', async () => {
    assert.ok(track.fixtureGuestId, 'Fixture guest must exist');
    assert.ok(track.actorUserId, 'Actor user must exist');

    const { documentUploadId } = await createIdentityUploadFixture(pool, track.actorUserId, 1);

    const confirmed = await confirmVerifiedIdentity(pool, {
      document_upload_id: documentUploadId,
      actor_user_id: track.actorUserId,
      property_id: 1,
      guest_id: track.fixtureGuestId,
      name: 'AGUS SETIAWAN PERDANA',
      phone: '081299998888',
      nik: testNik,
      birth_place: 'JAKARTA',
      birth_date: '1988-10-15',
      gender: 'MALE',
      address: 'JL KEMANG RAYA NO 10',
      identity_type: 'KTP'
    });

    assert.strictEqual(confirmed.id, track.fixtureGuestId);
    assert.strictEqual(confirmed.full_name, 'AGUS SETIAWAN PERDANA');
    assert.strictEqual(confirmed.has_valid_identity, true);
    assert.strictEqual(confirmed.birth_place, 'JAKARTA');

    // Verify in DB directly
    const dbCheck = await pool.query('SELECT * FROM guests WHERE id = $1', [track.fixtureGuestId]);
    assert.strictEqual(dbCheck.rows[0].has_valid_identity, true);
    assert.strictEqual(dbCheck.rows[0].normalized_name, 'agus setiawan perdana');
    assert.strictEqual(dbCheck.rows[0].normalized_identity_number, testNik);
  });

  await testAsync('confirmVerifiedIdentity creates new guest with unique guest_code if not existing', async () => {
    assert.ok(track.actorUserId, 'Actor user must exist');
    const newNik = '3578001122330005';
    // Clean any prior
    await pool.query('DELETE FROM guests WHERE normalized_identity_number = $1', [newNik]);

    const { documentUploadId } = await createIdentityUploadFixture(pool, track.actorUserId, 1);

    const created = await confirmVerifiedIdentity(pool, {
      document_upload_id: documentUploadId,
      actor_user_id: track.actorUserId,
      property_id: 1,
      name: 'RATNA SARUMPET',
      phone: '081377778888',
      nik: newNik,
      birth_place: 'SURABAYA',
      birth_date: '1991-03-20',
      gender: 'FEMALE',
      address: 'JL DARMO NO 5',
      identity_type: 'KTP',
      ktp_regency_id: track.regencyId
    });

    assert.ok(created.id > 0);
    assert.ok(created.guest_code.startsWith('GST-'));
    assert.strictEqual(created.has_valid_identity, true);
    assert.strictEqual(created.gender, 'FEMALE');
    // Regression: ktp_regency_id must be persisted for the newly created guest.
    assert.strictEqual(created.ktp_regency_id, track.regencyId);

    // Verify in DB directly
    const dbCheck = await pool.query('SELECT ktp_regency_id FROM guests WHERE id = $1', [created.id]);
    assert.strictEqual(dbCheck.rows[0].ktp_regency_id, track.regencyId);

    // Clean up created test row
    await pool.query('DELETE FROM guests WHERE id = $1', [created.id]);
  });

  // --- CLEANUP ---
  console.log('\n[5. Teardown]');
  await testAsync('Clean up all test fixtures (guests, uploads, actor user, storage files)', async () => {
    // 1. Remove guest fixtures
    if (track.fixtureGuestId) {
      await pool.query('DELETE FROM guests WHERE id = $1', [track.fixtureGuestId]);
    }
    await pool.query('DELETE FROM guests WHERE normalized_identity_number = $1', [testNik]);
    const newNik = '3578001122330005';
    await pool.query('DELETE FROM guests WHERE normalized_identity_number = $1', [newNik]);

    // 2. Remove identity document uploads (FK order: uploads → guests, so delete uploads first)
    for (const fixture of track.uploadFixtures) {
      await pool.query('DELETE FROM identity_document_uploads WHERE id = $1', [fixture.documentUploadId]);
      // Delete the physical storage file
      try { await deleteIdentityDocument(fixture.storageKey); } catch (_) { /* may already be gone */ }
    }

    // 3. Remove actor user
    if (track.actorUserId) {
      await pool.query('DELETE FROM users WHERE id = $1', [track.actorUserId]);
    }
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
