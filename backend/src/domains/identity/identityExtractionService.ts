import { Pool } from 'pg';
import {
  NormalizedIdentityExtractionResponse,
  ConfirmIdentityInput,
  DuplicateIdentityCandidate,
  NameMismatchInfo,
  IdentityCandidateData
} from './identityTypes';
import { getOcrProvider } from './identityOcrProvider';
import { parseKtpRawLines, normalizeNik } from './ktpParser';

/**
 * Calculate simple string token / character similarity (0.0 to 1.0)
 */
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const words1 = s1.split(/\s+/);
  const words2 = s2.split(/\s+/);
  const set2 = new Set(words2);
  let intersection = 0;
  for (const w of words1) {
    if (set2.has(w)) intersection++;
  }
  const tokenSim = (2 * intersection) / (words1.length + words2.length);

  // Levenshtein distance for character level
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  const maxLen = Math.max(m, n);
  const levSim = maxLen === 0 ? 1.0 : 1.0 - dp[m][n] / maxLen;

  return Math.round(Math.max(tokenSim, levSim) * 100) / 100;
}

export interface ExtractIdentityOptions {
  property_id?: number;
  guest_name?: string | null;
  guest_id?: number | null;
  timeout_ms?: number;
}

/**
 * Service to extract structured identity candidate data from uploaded KTP/document.
 * Provider-agnostic: executes configured OCR provider, runs deterministic KTP label parser,
 * checks duplicate NIK against canonical CRM, and checks for name mismatch.
 */
export async function extractIdentityFromDocument(
  pool: Pool | null,
  localFilePath: string,
  storedFilePath: string,
  options: ExtractIdentityOptions = {}
): Promise<NormalizedIdentityExtractionResponse> {
  const provider = getOcrProvider();
  const rawResult = await provider.extractRawLines(localFilePath, { timeoutMs: options.timeout_ms });

  // Fallback candidate with null fields
  const emptyCandidate: IdentityCandidateData = {
    full_name: null,
    identity_number: null,
    birth_place: null,
    birth_date: null,
    gender: null,
    address: null,
    rt_rw: null,
    village_kelurahan: null,
    district_kecamatan: null,
    religion: null,
    marital_status: null,
    occupation: null,
    citizenship: null,
    valid_until: null,
    confidence: 0.0
  };

  if (!rawResult || !rawResult.raw_lines || rawResult.raw_lines.length === 0) {
    const isManual = provider.providerName === 'MANUAL';
    const warningMsg = rawResult?.error || (isManual ? 'OCR_PROVIDER_MANUAL' : 'OCR_EXTRACTION_EMPTY');
    
    return {
      success: true,
      status: 'MANUAL_REVIEW_REQUIRED',
      provider: provider.providerName,
      data: emptyCandidate,
      candidate: emptyCandidate,
      raw_lines: [],
      raw_text: '',
      file_path: storedFilePath,
      warnings: [warningMsg],
      message: 'OCR lokal belum tersedia atau tidak mendeteksi teks. Silakan isi data identitas secara manual.',
      duplicate_candidate: null,
      name_mismatch: null
    };
  }

  // Parse raw OCR lines deterministically
  const candidate = parseKtpRawLines(rawResult.raw_lines, rawResult.confidence);
  const warnings: string[] = [];
  if (rawResult.error) {
    warnings.push(rawResult.error);
  }

  let duplicateCandidate: DuplicateIdentityCandidate | null = null;
  let nameMismatch: NameMismatchInfo | null = null;

  // Check Duplicate NIK in CRM database
  if (pool && candidate.identity_number) {
    try {
      const normNik = normalizeNik(candidate.identity_number);
      if (normNik) {
        const dupRes = await pool.query(
          `SELECT id, guest_code, full_name, phone, email, is_archived
           FROM guests
           WHERE normalized_identity_number = $1
             AND ($2::INTEGER IS NULL OR id != $2::INTEGER)
           LIMIT 1`,
          [normNik, options.guest_id || null]
        );

        if (dupRes.rowCount && dupRes.rowCount > 0) {
          const row = dupRes.rows[0];
          duplicateCandidate = {
            guest_id: row.id,
            guest_code: row.guest_code,
            full_name: row.full_name,
            phone: row.phone,
            email: row.email,
            match_reason: 'STRONG_NIK'
          };
          warnings.push('DUPLICATE_NIK_FOUND');
        }
      }
    } catch (dbErr: any) {
      console.warn('[extractIdentityFromDocument] Duplicate NIK check warning:', dbErr.message);
    }
  }

  // Check Name Mismatch
  if (options.guest_name && candidate.full_name) {
    const entered = options.guest_name.trim();
    const extracted = candidate.full_name.trim();
    if (entered.toLowerCase() !== extracted.toLowerCase()) {
      const sim = calculateSimilarity(entered, extracted);
      if (sim < 0.85) {
        nameMismatch = {
          is_mismatch: true,
          entered_name: entered,
          extracted_name: extracted,
          similarity: sim
        };
        warnings.push('NAME_MISMATCH_DETECTED');
      }
    }
  }

  const isZeroRecognized = (candidate.recognized_fields_count ?? 0) === 0;
  if (isZeroRecognized) {
    warnings.push('NO_KTP_FIELDS_RECOGNIZED');
  }

  const status = isZeroRecognized ? 'MANUAL_REVIEW_REQUIRED' : 'REVIEW_REQUIRED';
  const message = isZeroRecognized
    ? 'Dokumen berhasil dibaca, tetapi beberapa data belum dapat dikenali secara otomatis. Silakan lengkapi data yang kosong atau periksa kualitas foto.'
    : 'Data identitas berhasil diekstraksi. Silakan tinjau dan konfirmasi data sebelum disimpan.';

  return {
    success: true,
    status,
    provider: provider.providerName,
    data: candidate,
    candidate: candidate, // Backward compatibility
    raw_lines: rawResult.raw_lines,
    raw_text: rawResult.raw_lines.join('\n'),
    file_path: storedFilePath,
    warnings,
    duplicate_candidate: duplicateCandidate,
    name_mismatch: nameMismatch,
    message
  };
}

/**
 * Confirm verified identity and persist to canonical CRM guests table
 */
export async function confirmVerifiedIdentity(
  pool: Pool,
  input: ConfirmIdentityInput
): Promise<any> {
  const {
    guest_id,
    property_id = 1,
    name,
    phone,
    nik,
    birth_place,
    birth_date,
    gender,
    address,
    rt_rw,
    village_kelurahan,
    district_kecamatan,
    religion,
    marital_status,
    occupation,
    citizenship,
    valid_until,
    identity_path,
    identity_type = 'KTP',
    confidence,
    ocr_provider
  } = input;

  const cleanName = (name || '').trim();
  const cleanNik = (nik || '').trim();
  const cleanPhone = (phone || '').trim();
  const normPhone = cleanPhone ? cleanPhone.replace(/\D/g, '') || null : null;
  const normNik = cleanNik ? normalizeNik(cleanNik) : null;
  const normGender = gender === 'MALE' || gender === 'FEMALE' ? gender : null;
  const numConfidence = Number.isFinite(confidence) ? confidence : 1.0;

  if (!cleanName) {
    throw { statusCode: 400, code: 'VALIDATION_ERROR', message: 'Nama pada identitas wajib diisi' };
  }

  const updateFieldsSql = `
    UPDATE guests
    SET full_name = COALESCE(NULLIF($1, ''), full_name),
        normalized_name = LOWER(COALESCE(NULLIF($1, ''), full_name)),
        phone = COALESCE(NULLIF($2, ''), phone),
        normalized_phone = COALESCE($3, normalized_phone),
        identity_number = COALESCE(NULLIF($4, ''), identity_number),
        normalized_identity_number = COALESCE($5, normalized_identity_number),
        identity_type = $6,
        identity_path = COALESCE(NULLIF($7, ''), identity_path),
        has_valid_identity = TRUE,
        birth_place = COALESCE(NULLIF($8, ''), birth_place),
        birth_date = COALESCE(NULLIF($9, '')::DATE, birth_date),
        gender = COALESCE($10, gender),
        address = COALESCE(NULLIF($11, ''), address),
        rt_rw = COALESCE(NULLIF($12, ''), rt_rw),
        village_kelurahan = COALESCE(NULLIF($13, ''), village_kelurahan),
        district_kecamatan = COALESCE(NULLIF($14, ''), district_kecamatan),
        religion = COALESCE(NULLIF($15, ''), religion),
        marital_status = COALESCE(NULLIF($16, ''), marital_status),
        occupation = COALESCE(NULLIF($17, ''), occupation),
        citizenship = COALESCE(NULLIF($18, ''), citizenship),
        valid_until = COALESCE(NULLIF($19, ''), valid_until),
        ktp_ocr_confidence = COALESCE($20, ktp_ocr_confidence),
        ktp_ocr_provider = COALESCE(NULLIF($21, ''), ktp_ocr_provider),
        ktp_extracted_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $22
    RETURNING *
  `;

  const updateParams = (targetId: number) => [
    cleanName,
    cleanPhone,
    normPhone,
    cleanNik,
    normNik,
    identity_type,
    identity_path || null,
    birth_place || null,
    birth_date || null,
    normGender,
    address || null,
    rt_rw || null,
    village_kelurahan || null,
    district_kecamatan || null,
    religion || null,
    marital_status || null,
    occupation || null,
    citizenship || null,
    valid_until || null,
    numConfidence,
    ocr_provider || null,
    targetId
  ];

  if (guest_id) {
    // Update existing guest record
    const res = await pool.query(updateFieldsSql, updateParams(guest_id));
    if (res.rowCount === 0) {
      throw { statusCode: 404, code: 'NOT_FOUND', message: 'Data tamu tidak ditemukan' };
    }
    return res.rows[0];
  } else {
    // Check if guest already exists by NIK or Phone
    if (normNik) {
      const existingNik = await pool.query(
        'SELECT * FROM guests WHERE normalized_identity_number = $1 LIMIT 1',
        [normNik]
      );
      if (existingNik.rowCount && existingNik.rowCount > 0) {
        const existing = existingNik.rows[0];
        const res = await pool.query(updateFieldsSql, updateParams(existing.id));
        return res.rows[0];
      }
    }

    if (cleanPhone) {
      const existingPhone = await pool.query(
        'SELECT * FROM guests WHERE phone = $1 OR (normalized_phone IS NOT NULL AND normalized_phone = $2) LIMIT 1',
        [cleanPhone, normPhone]
      );
      if (existingPhone.rowCount && existingPhone.rowCount > 0) {
        const existing = existingPhone.rows[0];
        const res = await pool.query(updateFieldsSql, updateParams(existing.id));
        return res.rows[0];
      }
    }

    // Insert new canonical guest with complete KTP fields
    const normName = cleanName.toLowerCase();
    const res = await pool.query(
      `INSERT INTO guests (
         full_name, normalized_name, phone, normalized_phone, identity_number, normalized_identity_number,
         identity_type, identity_path, has_valid_identity, birth_place, birth_date, gender, address,
         rt_rw, village_kelurahan, district_kecamatan, religion, marital_status, occupation, citizenship, valid_until,
         ktp_ocr_confidence, ktp_ocr_provider, ktp_extracted_at, created_property_id
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, TRUE, $9, NULLIF($10, '')::DATE, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22, CURRENT_TIMESTAMP, $23
       )
       RETURNING *`,
      [
        cleanName,
        normName,
        cleanPhone || null,
        normPhone,
        cleanNik || null,
        normNik,
        identity_type,
        identity_path || null,
        birth_place || null,
        birth_date || null,
        normGender,
        address || null,
        rt_rw || null,
        village_kelurahan || null,
        district_kecamatan || null,
        religion || null,
        marital_status || null,
        occupation || null,
        citizenship || null,
        valid_until || null,
        numConfidence,
        ocr_provider || null,
        property_id
      ]
    );
    const newGuest = res.rows[0];
    const guestCode = `GST-${String(newGuest.id).padStart(5, '0')}`;
    const codeUpdateRes = await pool.query(
      `UPDATE guests SET guest_code = $1 WHERE id = $2 RETURNING *`,
      [guestCode, newGuest.id]
    );
    return codeUpdateRes.rows[0];
  }
}
