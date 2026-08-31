export type IdentityExtractionStatus =
  | 'REVIEW_REQUIRED'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'EXTRACTED'
  | 'PROVIDER_HOOK'
  | 'MANUAL_FALLBACK'
  | 'FAILED';

export type IdentityOcrProviderType =
  | 'LOCAL_PADDLE_OCR'
  | 'GOOGLE_VISION'
  | 'GEMINI'
  | 'MANUAL';

export interface IdentityCandidateData {
  full_name: string | null;
  identity_number: string | null;
  birth_place: string | null;
  birth_date: string | null;
  gender: 'MALE' | 'FEMALE' | null;
  address: string | null;
  rt_rw: string | null;
  village_kelurahan: string | null;
  district_kecamatan: string | null;
  religion: string | null;
  marital_status: string | null;
  occupation: string | null;
  citizenship: string | null;
  valid_until: string | null;
  confidence: number;
  recognized_fields_count?: number;
  total_fields_count?: number;
}

export interface DuplicateIdentityCandidate {
  guest_id: number;
  guest_code: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  match_reason: string;
}

export interface NameMismatchInfo {
  is_mismatch: boolean;
  entered_name: string;
  extracted_name: string;
  similarity?: number;
}

export interface NormalizedIdentityExtractionResponse {
  success: boolean;
  status: IdentityExtractionStatus;
  provider: IdentityOcrProviderType | string;
  data: IdentityCandidateData;
  candidate?: IdentityCandidateData; // Backward compatibility alias
  raw_lines: string[];
  raw_text?: string | null;
  file_path: string;
  warnings: string[];
  duplicate_candidate?: DuplicateIdentityCandidate | null;
  name_mismatch?: NameMismatchInfo | null;
  message?: string;
}

// Backward compatibility interfaces
export interface IdentityCandidate extends Partial<IdentityCandidateData> {
  name?: string | null;
  nik?: string | null;
  city?: string | null;
  province?: string | null;
}

export interface IdentityExtractionResult extends NormalizedIdentityExtractionResponse {}

export interface ConfirmIdentityInput {
  guest_id?: number | null;
  property_id: number;
  name: string;
  phone?: string | null;
  nik: string;
  birth_place?: string | null;
  birth_date?: string | null;
  gender?: string | null;
  address?: string | null;
  rt_rw?: string | null;
  village_kelurahan?: string | null;
  district_kecamatan?: string | null;
  religion?: string | null;
  marital_status?: string | null;
  occupation?: string | null;
  citizenship?: string | null;
  valid_until?: string | null;
  identity_path?: string | null;
  identity_type?: string;
  confidence?: number;
  ocr_provider?: string;
}
