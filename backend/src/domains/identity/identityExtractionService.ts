import { Pool } from 'pg';
import {
  NormalizedIdentityExtractionResponse,
  DuplicateIdentityCandidate,
  NameMismatchInfo,
  IdentityCandidateData
} from './identityTypes';
import { getOcrProvider } from './identityOcrProvider';
import { parseKtpRawLines, normalizeNik } from './ktpParser';

export { confirmVerifiedIdentity } from './identityDocumentUploadService';

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
             AND created_property_id = $3
             AND ($2::INTEGER IS NULL OR id != $2::INTEGER)
           LIMIT 1`,
          [normNik, options.guest_id || null, options.property_id || null]
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
