import { IdentityCandidateData } from './identityTypes';

/**
 * Standard Indonesian KTP deterministic parser
 */

const KTP_LABELS_REGEX = /^(?:NIK|N1K|NlK|NO\.?\s*KTP|Nama|Narna|Narne|Name|Tempat|Tpt|TgLahir|Tgl|Tanggal|Lahir|Jenis|Kelamin|Sex|Gender|Alamat|Ala\s*mat|Alarnat|Aamat|Address|RT|RW|RTAW|RTRW|RIAN|Kel|Desa|Kelurahan|Kecamatan|Kec|Agama|Status|Perkawinan|Perkawinar|Pekerjaan|Kewarganegaraan|Berlaku|Masa|Gol|Darah)/i;

export function normalizeNik(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s\:\.\,\-\/\\]/g, '');
  s = s
    .replace(/[Oo]/g, '0')
    .replace(/[Ili!|L]/g, '1')
    .replace(/[Zz]/g, '2')
    .replace(/[Aa]/g, '4')
    .replace(/[Ss]/g, '5')
    .replace(/[Gg]/g, '6')
    .replace(/[Bb]/g, '8');

  const digits = s.replace(/\D/g, '');
  if (digits.length === 16) {
    return digits;
  }
  if (digits.length > 16) {
    return digits.slice(0, 16);
  }
  return null;
}

export function normalizeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();

  // Pattern 1: DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY or DD MM YYYY
  const m1 = s.match(/\b(\d{1,2})[\s\-\/\.]+(\d{1,2})[\s\-\/\.]+(\d{4})\b/);
  if (m1) {
    const day = m1[1].padStart(2, '0');
    const month = m1[2].padStart(2, '0');
    let year = parseInt(m1[3]);
    if (year < 1920 && year >= 1800) {
      year += 100;
    }
    return `${year}-${month}-${day}`;
  }

  // Pattern 2: DDMM-YYYY or DDMM YYYY (e.g. 1205-1990)
  const m1b = s.match(/\b(\d{2})(\d{2})[\s\-\/\.]+(\d{4})\b/);
  if (m1b) {
    const day = m1b[1];
    const month = m1b[2];
    let year = parseInt(m1b[3]);
    if (year < 1920 && year >= 1800) {
      year += 100;
    }
    return `${year}-${month}-${day}`;
  }

  // Pattern 3: Textual month Indonesian (e.g. 12 Mei 1990)
  const indonesianMonths: Record<string, string> = {
    januari: '01', jan: '01',
    februari: '02', feb: '02',
    maret: '03', mar: '03',
    april: '04', apr: '04',
    mei: '05', may: '05',
    juni: '06', jun: '06',
    juli: '07', jul: '07',
    agustus: '08', agu: '08', ags: '08',
    september: '09', sep: '09',
    oktober: '10', okt: '10',
    november: '11', nopember: '11', nov: '11',
    desember: '12', des: '12'
  };

  const m2 = s.match(/\b(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})\b/);
  if (m2) {
    const day = m2[1].padStart(2, '0');
    const monthStr = m2[2].toLowerCase();
    let year = parseInt(m2[3]);
    if (year < 1920 && year >= 1800) {
      year += 100;
    }
    const month = indonesianMonths[monthStr];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

export function normalizeGender(raw: string | null | undefined): 'MALE' | 'FEMALE' | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/\b(?:LAKI[\-\s]*LAKI|PRIA|LAK1[\-\s]*LAK1|LAK[\s\-\_]*LAK|LAK[I1l!]|MALE)\b/i.test(s) || /LAK\s*LAK/i.test(s)) {
    return 'MALE';
  }
  if (/\b(?:PEREMPUAN|WANITA|PERE[\s\w]*AN|FEMALE|PERENPUAN|PEREMP)\b/i.test(s)) {
    return 'FEMALE';
  }
  return null;
}

export function normalizeReligion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/\b(?:ISLAM|ISLM|ISL|ISLA)\b/i.test(s)) return 'ISLAM';
  if (/\b(?:KRISTEN|PROTESTAN)\b/i.test(s)) return 'KRISTEN';
  if (/\b(?:KATOLIK|CATHOLIC)\b/i.test(s)) return 'KATOLIK';
  if (/\b(?:HINDU)\b/i.test(s)) return 'HINDU';
  if (/\b(?:BUDDHA|BUDHA)\b/i.test(s)) return 'BUDDHA';
  if (/\b(?:KONGHUCU|KHONGHUCU)\b/i.test(s)) return 'KONGHUCU';
  return null;
}

export function normalizeMaritalStatus(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/\b(?:BELUM|SELuM|BLM|BELM)\s*KAW[I1l!A-Za-z]*/i.test(s) || /\bBELUM\s*MENIKAH\b/i.test(s)) return 'BELUM KAWIN';
  if (/\b(?:CERAI\s*HIDUP)\b/i.test(s)) return 'CERAI HIDUP';
  if (/\b(?:CERAI\s*MATI)\b/i.test(s)) return 'CERAI MATI';
  if (/\b(?:KAWIN|KAwIN|KAWI|MENIKAH)\b/i.test(s)) return 'KAWIN';
  return null;
}

export function normalizeCitizenship(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/\b(?:WNI|INDONESIA|\/NI|WII|W1N|W11)\b/i.test(s) || /Kewargane[a-z]*N?I/i.test(s)) return 'WNI';
  if (/\b(?:WNA|ASING)\b/i.test(s)) return 'WNA';
  return null;
}

export function normalizeValidUntil(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/SEUMUR\s*HIDUP|SEUMURHIDUP|SEUMUR\s*H[I1l!]DUP|LSEUMUR\s*HIDUP/i.test(s)) {
    return 'SEUMUR HIDUP';
  }
  const dateIso = normalizeDate(s);
  if (dateIso) {
    return dateIso;
  }
  return null;
}

export function normalizeRtRw(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const m1 = s.match(/\b(\d{1,3})\s*[\/\.\-\s]\s*(\d{1,3})\b/);
  if (m1) {
    return `${m1[1].padStart(3, '0')}/${m1[2].padStart(3, '0')}`;
  }
  const m2 = s.match(/\b(\d{3})(\d{2,3})\b/);
  if (m2) {
    return `${m2[1]}/${m2[2].padStart(3, '0')}`;
  }
  return null;
}

function cleanValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^[:;=\-\s]+/, '').replace(/[:;=\-\s]+$/, '');
  return s.length > 0 ? s : null;
}

/**
 * Parses raw OCR lines into structured candidate data
 */
function legacyParseKtpRawLines(lines: string[], ocrConfidence: number = 0.9): IdentityCandidateData {
  const result: IdentityCandidateData = {
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
    confidence: 0.0,
    recognized_fields_count: 0,
    total_fields_count: 13
  };

  if (!lines || lines.length === 0) {
    return result;
  }

  const cleanLines = lines
    .map((l) => (l ? l.trim() : ''))
    .filter((l) => l.length > 0);

  const isLabelHeader = (s: string): boolean => {
    return KTP_LABELS_REGEX.test(s.trim());
  };

  // 1. NIK (16 Digits)
  for (const l of cleanLines) {
    const m = l.match(/\b(?:NIK|N1K|NlK|NO\.?\s*KTP)?\s*[:;=\-\s]*([0-9OIli!BZASGb]{16,18})\b/i);
    if (m) {
      const parsedNik = normalizeNik(m[1]);
      if (parsedNik && parsedNik.length === 16) {
        result.identity_number = parsedNik;
        break;
      }
    }
  }

  // Fallback standalone 16 digit scan
  if (!result.identity_number) {
    for (const l of cleanLines) {
      const digits = l.replace(/[^0-9]/g, '');
      if (digits.length === 16) {
        result.identity_number = digits;
        break;
      }
    }
  }

  // 2. Nama Lengkap (Allow OCR prefix noise like 'ING Nama ...')
  for (const l of cleanLines) {
    const m = l.match(/(?:^|.*?\b)(?:N[aA4](?:[mM]|rn|rm|nn)[aA4eE]|Name)\s*[:;=\-\s]+\s*([A-Za-z\s\.\,\'\-]+)/i);
    if (m) {
      let val = m[1].trim();
      const parts = val.split(/\s+(?=(?:Tempat|Tpt|Tgl|TgLahir|Jenis|Kelamin|Alamat|RT|Kel|Kecamatan|Agama|Gol)\b)/i);
      val = parts[0].trim();
      if (val.length > 2 && !isLabelHeader(val)) {
        result.full_name = val.toUpperCase();
        break;
      }
    }
  }

  // Fallback adjacent line for Nama
  if (!result.full_name) {
    for (let i = 0; i < cleanLines.length; i++) {
      if (/(?:^|\b)(?:Nama|Name|Narna)(?:\s*[\/\\]\s*Name)?$/i.test(cleanLines[i])) {
        if (i + 1 < cleanLines.length) {
          const next = cleanLines[i + 1].trim();
          if (!isLabelHeader(next)) {
            result.full_name = next.replace(/^[:;=\-\s]+/, '').toUpperCase();
            break;
          }
        }
      }
    }
  }

  // 3. Tempat / Tanggal Lahir
  for (let i = 0; i < cleanLines.length; i++) {
    const l = cleanLines[i];
    const m = l.match(/(?:Te\s*mpat|Tempat|Tpt|Tgl|TgLahir|TgLahi|Lahir)[A-Za-z0-9\s\/\.\-]*?[:;=\-\s]+([A-Za-z0-9\s\.\,\-\/]+)/i);
    let val: string | null = null;
    if (m) {
      val = m[1].trim();
    } else if (/(?:^|\b)(?:Te\s*mpat|Tempat|Tpt)[\s\/\\]*(?:Tgl|Tanggal)?\s*Lahir$/i.test(l)) {
      if (i + 1 < cleanLines.length && !isLabelHeader(cleanLines[i + 1])) {
        val = cleanLines[i + 1].trim();
      }
    }

    if (val) {
      // Date pattern
      const dateMatch = val.match(/(\d{1,2}[\s\-\/\.]+\d{1,2}[\s\-\/\.]+\d{4})/) || val.match(/(\d{2})(\d{2})[\s\-\/\.]+(\d{4})/);
      if (dateMatch) {
        result.birth_date = normalizeDate(dateMatch[0]);
      }
      // Place pattern
      const placeMatch = val.match(/^([A-Za-z\s]+?)(?:[,\.\:\-]|\d{1,2})/);
      if (placeMatch && placeMatch[1]) {
        let p = placeMatch[1].replace(/^(?:TEMPAT|TGL|LAHIR|LAHI|LAHIL|TPT|\:|\-)+/i, '').trim().toUpperCase();
        p = p.replace(/^[A-Z]\s+(?=[A-Z]{3,})/i, '').trim();
        if (p.length >= 2 && !isLabelHeader(p)) {
          result.birth_place = p;
        }
      }
      if (result.birth_date || result.birth_place) break;
    }
  }

  // Fallback standalone date & place if birth_date or birth_place missing
  if (!result.birth_date || !result.birth_place) {
    for (const l of cleanLines) {
      if (!/Berlaku|16-10|Kewarganegaraan|Kewarganecaran/i.test(l)) {
        const dateMatch = l.match(/\b(\d{1,2}[\s\-\/\.]+\d{1,2}[\s\-\/\.]+\d{4})\b/) || l.match(/\b(\d{2})(\d{2})[\s\-\/\.]+(\d{4})\b/);
        if (dateMatch) {
          if (!result.birth_date) {
            result.birth_date = normalizeDate(dateMatch[0]);
          }
          if (!result.birth_place) {
            const cityMatch = l.match(/(?:^|.*?)\b([A-Za-z]+)\s*[\.\,\s]\s*\d{1,2}[\s\-\/\.]/);
            if (cityMatch && cityMatch[1]) {
              const p = cityMatch[1].toUpperCase();
              if (p.length >= 3 && !isLabelHeader(p)) {
                result.birth_place = p;
              }
            }
          }
        }
      }
    }
  }

  // 4. Jenis Kelamin
  for (const l of cleanLines) {
    const g = normalizeGender(l);
    if (g) {
      result.gender = g;
      break;
    }
  }

  // 5. RT/RW & Address from same line
  for (const l of cleanLines) {
    const m = l.match(/\b(?:RT[\s\/\.\-]*[A-Z0-9]*[\/\.\-]*RW|RT|RTAW|RTRW|RIAN)\s*[:;=\-\s]*([0-9\/\.\-\s]{3,10})/i);
    if (m) {
      const parsedRtRw = normalizeRtRw(m[1]);
      if (parsedRtRw) {
        result.rt_rw = parsedRtRw;
        const afterRtRw = l.slice(l.indexOf(m[0]) + m[0].length).trim();
        if (afterRtRw && !isLabelHeader(afterRtRw)) {
          result.address = afterRtRw.replace(/^[:;=\-\s]+/, '').toUpperCase();
        }
        break;
      }
    }
  }

  // Fallback standalone RT/RW digits
  if (!result.rt_rw) {
    for (const l of cleanLines) {
      const r = normalizeRtRw(l);
      if (r && !/^\d{4}/.test(l) && !/SEUMUR/i.test(l)) {
        result.rt_rw = r;
        break;
      }
    }
  }

  // If address still null, extract from Alamat / Aamat line
  if (!result.address) {
    for (let i = 0; i < cleanLines.length; i++) {
      const l = cleanLines[i];
      if (/(?:Al[aA4]m[aA4]t|Ala\s*mat|Alarnat|Aamat|Address)/i.test(l)) {
        const m = l.match(/(?:Al[aA4]m[aA4]t|Ala\s*mat|Alarnat|Aamat|Address)\s*[:;=\-\s]+\s*([A-Za-z0-9\s\.\,\-]+)/i);
        if (m) {
          const val = m[1].split(/\s+(?=(?:Jenis|Kelamin|RT|Kel|Desa|Kecamatan|Agama|Gol)\b)/i)[0].trim();
          if (val && !isLabelHeader(val)) {
            result.address = val.replace(/^[:;=\-\s]+/, '').toUpperCase();
          }
        }
        if (!result.address && i + 1 < cleanLines.length) {
          const next = cleanLines[i + 1].trim();
          if (!isLabelHeader(next) && !next.match(/\b(?:RT|Kel|Kecamatan|Agama)\b/i)) {
            result.address = next.replace(/^[:;=\-\s]+/, '').toUpperCase();
          }
        }
        break;
      }
    }
  }

  // Standalone address heuristic (e.g. JL SUDIRMAN NO 45)
  if (!result.address) {
    for (const l of cleanLines) {
      const m = l.match(/\b((?:JL|JLN|JALAN|GG|GANG|DUSUN|KP|KAMPUNG|KOMPLEK|BLOK)\s+[A-Za-z0-9\s\.\,\-]+)/i);
      if (m && m[1].length > 4 && !isLabelHeader(m[1])) {
        result.address = m[1].trim().toUpperCase();
        break;
      }
    }
  }

  // 6. Kelurahan / Desa
  for (let i = 0; i < cleanLines.length; i++) {
    const l = cleanLines[i];
    const m = l.match(/(?:^|.*?\b)(?:Kel(?:urahan)?[\s\/\.\-]+Desa|Kel(?:urahan)?(?!\s*Kelamin)|Desa|Kellbesa)\s*[:;=\-\s]+([A-Za-z\s]+)/i);
    if (m) {
      const val = m[1].split(/\s+(?=(?:Kecamatan|Agama|RT|Status)\b)/i)[0].trim();
      if (val && !isLabelHeader(val) && !/Kelamin/i.test(val)) {
        result.village_kelurahan = val.replace(/^[:;=\-\s]+/, '').toUpperCase();
        break;
      }
    } else if (/(?:^|\b)(?:Kel(?:urahan)?[\s\/\.\-]*Desa|Kel(?:urahan)?(?!\s*Kelamin)|Desa|Kellbesa)$/i.test(l)) {
      if (i + 1 < cleanLines.length && !isLabelHeader(cleanLines[i + 1])) {
        const val = cleanLines[i + 1].trim().replace(/^[:;=\-\s]+/, '');
        if (val && !isLabelHeader(val) && !/Kelamin/i.test(val)) {
          result.village_kelurahan = val.toUpperCase();
          break;
        }
      }
    }
  }

  // 7. Kecamatan
  for (let i = 0; i < cleanLines.length; i++) {
    const l = cleanLines[i];
    const m = l.match(/(?:^|.*?\b)(?:Kecamatan|Kecaniatan|Kecarnatan|Kec\.)\s*[:;=\-\s]*([A-Za-z\s]+)/i);
    if (m) {
      const val = m[1].split(/\s+(?=(?:Agama|Status|Pekerjaan|Kabupaten)\b)/i)[0].trim();
      if (val && !isLabelHeader(val)) {
        result.district_kecamatan = val.replace(/^[:;=\-\s]+/, '').toUpperCase();
        break;
      }
    } else if (/(?:^|\b)(?:Kecamatan|Kecaniatan|Kecarnatan|Kec\.)$/i.test(l)) {
      if (i + 1 < cleanLines.length && !isLabelHeader(cleanLines[i + 1])) {
        const val = cleanLines[i + 1].trim().replace(/^[:;=\-\s]+/, '');
        if (val && !isLabelHeader(val)) {
          result.district_kecamatan = val.toUpperCase();
          break;
        }
      }
    }
  }

  // 8. Agama
  for (const l of cleanLines) {
    const r = normalizeReligion(l);
    if (r) {
      result.religion = r;
      break;
    }
  }

  // 9. Status Perkawinan
  for (const l of cleanLines) {
    const s = normalizeMaritalStatus(l);
    if (s) {
      result.marital_status = s;
      break;
    }
  }

  // 10. Pekerjaan
  for (const l of cleanLines) {
    const m = l.match(/(?:^|.*?\b)(?:Pekerjaan|Pekerlaan|Pekeriaan|Occupation)\s*[:;=\-\s]*([A-Za-z0-9\s\/\-]+)/i);
    if (m) {
      const val = m[1].split(/\s+(?=(?:Kewarganegaraan|Berlaku|Agama)\b)/i)[0].trim();
      if (val && !isLabelHeader(val)) {
        result.occupation = val.toUpperCase();
        break;
      }
    }
    // Keyword scanner for common Indonesian occupations
    const occMatch = l.match(/\b(P?ELAJAR\s*[\/\\]\s*MAHASISWA|MAHASISWA|PELAJAR|WIRASWASTA|PNS|TNI|POLRI|KARYAWAN\s*SWASTA|KARYAWAN|IBU\s*RUMAH\s*TANGGA|BELUM[\s\/]*TIDAK\s*BEKERJA)\b/i);
    if (occMatch) {
      result.occupation = occMatch[1].toUpperCase().replace(/^ELAJAR/, 'PELAJAR');
      break;
    }
  }

  // 11. Kewarganegaraan
  for (const l of cleanLines) {
    const c = normalizeCitizenship(l);
    if (c) {
      result.citizenship = c;
      break;
    }
  }

  // 12. Berlaku Hingga
  for (const l of cleanLines) {
    if (/Berlaku|Masa|Valid|Borlako/i.test(l)) {
      const v = normalizeValidUntil(l);
      if (v) {
        result.valid_until = v;
        break;
      }
    }
  }
  if (!result.valid_until) {
    for (const l of cleanLines) {
      if (/SEUMUR\s*HIDUP|SEUMURHIDUP|LSEUMUR/i.test(l)) {
        result.valid_until = 'SEUMUR HIDUP';
        break;
      }
    }
  }

  // Calculate recognized field count (out of 13 fields)
  const fieldsToCheck = [
    result.full_name,
    result.identity_number,
    result.birth_place,
    result.birth_date,
    result.gender,
    result.address,
    result.rt_rw,
    result.village_kelurahan,
    result.district_kecamatan,
    result.religion,
    result.marital_status,
    result.occupation,
    result.citizenship
  ];
  const recognizedCount = fieldsToCheck.filter((f) => f !== null && f !== undefined && f !== '').length;
  result.recognized_fields_count = recognizedCount;
  result.total_fields_count = 13;

  if (recognizedCount === 0) {
    result.confidence = 0.0;
  } else {
    const completeness = recognizedCount / 13;
    const combined = ocrConfidence * 0.4 + completeness * 0.6;
    result.confidence = Math.round(combined * 100) / 100;
  }

  return result;
}

export interface FormattedKtpData extends IdentityCandidateData {
  nik: string | null;
  nama: string | null;
  tempat_lahir: string | null;
  tanggal_lahir: string | null;
  jenis_kelamin: 'LAKI-LAKI' | 'PEREMPUAN' | null;
  alamat: string | null;
  kelurahan: string | null;
  kecamatan: string | null;
  agama: string | null;
  status_perkawinan: string | null;
  pekerjaan: string | null;
  kewarganegaraan: string | null;
  berlaku_hingga: string | null;
}

export function formatParsedKtpData(candidate: IdentityCandidateData): FormattedKtpData {
  const jkIndo = candidate.gender === 'MALE' ? 'LAKI-LAKI' : (candidate.gender === 'FEMALE' ? 'PEREMPUAN' : null);
  return {
    ...candidate,
    nik: candidate.identity_number,
    nama: candidate.full_name,
    tempat_lahir: candidate.birth_place,
    tanggal_lahir: candidate.birth_date,
    jenis_kelamin: jkIndo,
    alamat: candidate.address,
    kelurahan: candidate.village_kelurahan,
    kecamatan: candidate.district_kecamatan,
    agama: candidate.religion,
    status_perkawinan: candidate.marital_status,
    pekerjaan: candidate.occupation,
    kewarganegaraan: candidate.citizenship,
    berlaku_hingga: candidate.valid_until
  };
}



const PURE_LABEL_PATTERN = /^(?:NIK|N1K|NlK|NO\.?\s*KTP|Nama(?:\s*Lengkap)?|Narna|Name|Tempat[\s\/\\]*(?:Tgl|Tanggal)?\s*Lahir|Tempat|Tpt|Tgl\s*Lahir|Tanggal\s*Lahir|Lahir|Jenis\s*Kelamin|Sex|Gender|Alamat|Ala\s*mat|Address|RT[\s\/\.\-]*RW|RT|RW|RTAW|RTRW|Kel(?:urahan)?[\s\/\.\-]*Desa|Kel(?:urahan)?(?!\s*Kelamin)|Desa|Kellbesa|Kecamatan|Kecaniatan|Kecarnatan|Kec\.|Kec|Agama|Religion|Status(?:\s*Perkawin[a-z]*n)?|Perkawinan|Pekerjaan|Pekerlaan|Pekeriaan|Occupation|Kewarganegaraan|Citizenship|Berlaku(?:\s*Hingga|\s*s\/?d)?|Masa\s*Berlaku|Gol(?:ongan)?\.?\s*Darah)[:;=\-\s]*$/i;

export function isPureLabel(line: string): boolean {
  if (!line) return false;
  const s = line.trim();
  if (s.length === 0) return false;
  return PURE_LABEL_PATTERN.test(s);
}

export function isHeaderOrNoise(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const s = raw.trim().toUpperCase();
  if (s.length <= 1) return true;
  if (/^(?:PROVINSI|KABUPATEN|KOTA|KARTU\s*TANDA\s*PENDUDUK|REPUBLIK\s*INDONESIA|PEMERINTAH|FORMULIR|NIK)\b/i.test(s)) {
    return true;
  }
  return false;
}

export function isLikelyPersonName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (s.length < 2) return false;
  if (isPureLabel(s) || isHeaderOrNoise(s)) return false;
  if (normalizeDate(s) !== null) return false;
  if (normalizeGender(s) !== null) return false;
  if (normalizeReligion(s) !== null) return false;
  if (normalizeMaritalStatus(s) !== null) return false;
  if (normalizeCitizenship(s) !== null) return false;
  if (normalizeRtRw(s) !== null && s.includes('/')) return false;
  if (normalizeNik(s) !== null && s.replace(/\D/g, '').length === 16) return false;
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  return true;
}

export function isLikelyAddress(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (s.length < 2) return false;
  if (isPureLabel(s) || isHeaderOrNoise(s)) return false;
  if (normalizeDate(s) !== null) return false;
  if (normalizeGender(s) !== null) return false;
  if (normalizeReligion(s) !== null) return false;
  if (normalizeMaritalStatus(s) !== null) return false;
  if (normalizeCitizenship(s) !== null) return false;
  if (normalizeNik(s) !== null && s.replace(/\D/g, '').length === 16) return false;
  return true;
}

export function isLikelyAdministrativeName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (s.length < 2) return false;
  if (isPureLabel(s) || isHeaderOrNoise(s)) return false;
  if (normalizeDate(s) !== null) return false;
  if (normalizeGender(s) !== null) return false;
  if (normalizeReligion(s) !== null) return false;
  if (normalizeMaritalStatus(s) !== null) return false;
  if (normalizeCitizenship(s) !== null) return false;
  if (normalizeRtRw(s) !== null && s.includes('/')) return false;
  if (normalizeNik(s) !== null && s.replace(/\D/g, '').length === 16) return false;
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  return true;
}

export function isLikelyOccupation(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim();
  if (s.length < 2) return false;
  if (isPureLabel(s) || isHeaderOrNoise(s)) return false;
  if (normalizeDate(s) !== null) return false;
  if (normalizeGender(s) !== null) return false;
  if (normalizeReligion(s) !== null) return false;
  if (normalizeMaritalStatus(s) !== null) return false;
  if (normalizeCitizenship(s) !== null) return false;
  if (normalizeRtRw(s) !== null && s.includes('/')) return false;
  if (normalizeNik(s) !== null && s.replace(/\D/g, '').length === 16) return false;
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  return true;
}

const LEADING_LABEL_REGEX = /^(?:NIK|N1K|NlK|NO\.?\s*KTP|Nama(?:\s*Lengkap)?|Narna|Name|Tempat[\s\/\\]*(?:Tgl|Tanggal)?\s*Lahir|Tempat|Tpt|Tgl\s*Lahir|Tanggal\s*Lahir|Lahir|Jenis\s*Kelamin|Sex|Gender|Alamat|Ala\s*mat|Address|RT[\s\/\.\-]*RW|RT|RW|RTAW|RTRW|Kel(?:urahan)?[\s\/\.\-]*Desa|Kel(?:urahan)?(?!\s*Kelamin)|Desa|Kellbesa|Kecamatan|Kecaniatan|Kecarnatan|Kec\.|Kec|Agama|Religion|Status(?:\s*Perkawin[a-z]*n)?|Perkawinan|Pekerjaan|Pekerlaan|Pekeriaan|Occupation|Kewarganegaraan|Citizenship|Berlaku(?:\s*Hingga|\s*s\/?d)?|Masa\s*Berlaku|Gol(?:ongan)?\.?\s*Darah)\s*[:;=\-\s]+/i;

export function stripLeadingLabel(line: string): string {
  if (!line) return '';
  let s = line.trim();
  s = s.replace(LEADING_LABEL_REGEX, '');
  return s.replace(/^[:;=\-\s]+/, '').trim();
}

export function parseKtpRawLines(lines: string[], ocrConfidence: number = 0.9): IdentityCandidateData {
  const result: IdentityCandidateData = {
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
    confidence: 0.0,
    recognized_fields_count: 0,
    total_fields_count: 13
  };

  if (!lines || lines.length === 0) return result;

  const cleanLines = lines.map(l => l ? l.trim() : '').filter(l => l.length > 0);

  // PASS 1 & 2: Anchor Sequence Block Parsing
  const valueCandidates: string[] = [];
  for (const l of cleanLines) {
    if (isPureLabel(l)) {
      continue;
    }
    const val = stripLeadingLabel(l);
    if (val.length > 0) {
      valueCandidates.push(val);
    }
  }

  let nikIdx = -1;
  for (let i = 0; i < valueCandidates.length; i++) {
    const digits = valueCandidates[i].replace(/[^0-9]/g, '');
    if (digits.length === 16) {
      const parsed = normalizeNik(digits);
      if (parsed) {
        result.identity_number = parsed;
        nikIdx = i;
        break;
      }
    }
  }

  if (nikIdx !== -1) {
    let curr = nikIdx + 1;
    const peek = () => curr < valueCandidates.length ? valueCandidates[curr] : null;
    const consume = () => { const v = peek(); curr++; return v; };
    const skipNoise = () => {
      while (curr < valueCandidates.length && isHeaderOrNoise(valueCandidates[curr])) {
        curr++;
      }
    };

    // 1. Nama
    skipNoise();
    if (peek() && isLikelyPersonName(peek())) {
      result.full_name = consume()!.toUpperCase();
    }

    // 2. Tempat/Tgl Lahir
    skipNoise();
    if (peek()) {
      let val = peek()!;
      const dateMatch = val.match(/(\d{1,2}[\s\-\/\.]+\d{1,2}[\s\-\/\.]+\d{4})/) || val.match(/(\d{2})(\d{2})[\s\-\/\.]+(\d{4})/);
      if (dateMatch) {
        result.birth_date = normalizeDate(dateMatch[0]);
        const placeMatch = val.match(/^([A-Za-z\s]+?)(?:[,\.\:\-]|\d{1,2})/);
        if (placeMatch && placeMatch[1]) {
          let p = placeMatch[1].replace(/^(?:TEMPAT|TGL|LAHIR|LAHI|LAHIL|TPT|\:|\-)+/i, '').trim().toUpperCase();
          if (p.length >= 2 && !isHeaderOrNoise(p)) result.birth_place = p;
        }
        consume();
      }
    }

    // 3. Jenis Kelamin
    skipNoise();
    if (peek()) {
      const g = normalizeGender(peek());
      if (g) {
        result.gender = g;
        consume();
      }
    }

    // 4. Alamat
    skipNoise();
    if (peek() && isLikelyAddress(peek())) {
      result.address = consume()!.toUpperCase();
    }

    // 5. RT/RW
    skipNoise();
    if (peek()) {
      let val = peek()!;
      if (val.includes('/')) {
        const r = normalizeRtRw(val);
        if (r) {
          result.rt_rw = r;
          consume();
        }
      }
    }

    // 6. Kelurahan
    skipNoise();
    if (peek() && isLikelyAdministrativeName(peek())) {
      result.village_kelurahan = consume()!.toUpperCase();
    }

    // 7. Kecamatan
    skipNoise();
    if (peek() && isLikelyAdministrativeName(peek())) {
      result.district_kecamatan = consume()!.toUpperCase();
    }

    // 8. Agama
    skipNoise();
    if (peek()) {
      const r = normalizeReligion(peek());
      if (r) {
        result.religion = r;
        consume();
      }
    }

    // 9. Status Perkawinan
    skipNoise();
    if (peek()) {
      const s = normalizeMaritalStatus(peek());
      if (s) {
        result.marital_status = s;
        consume();
      }
    }

    // 10. Pekerjaan
    skipNoise();
    if (peek() && isLikelyOccupation(peek())) {
      result.occupation = consume()!.toUpperCase();
    }

    // 11. Kewarganegaraan
    skipNoise();
    if (peek()) {
      const c = normalizeCitizenship(peek());
      if (c) {
        result.citizenship = c;
        consume();
      }
    }
    
    // 12. Berlaku Hingga
    skipNoise();
    if (peek()) {
      const v = normalizeValidUntil(peek());
      if (v) {
        result.valid_until = v;
        consume();
      }
    }
  }

  // PASS 3: Legacy Fallback
  const legacyResult = legacyParseKtpRawLines(lines, ocrConfidence);
  
  for (const key of Object.keys(result) as Array<keyof IdentityCandidateData>) {
    if (key === 'confidence' || key === 'recognized_fields_count' || key === 'total_fields_count') continue;
    if (result[key] === null || result[key] === undefined || result[key] === '') {
      if (legacyResult[key] !== null && legacyResult[key] !== undefined && legacyResult[key] !== '') {
        (result as any)[key] = legacyResult[key];
      }
    }
  }

  // Recalculate confidence
  const fieldsToCheck = [
    result.full_name, result.identity_number, result.birth_place, result.birth_date,
    result.gender, result.address, result.rt_rw, result.village_kelurahan,
    result.district_kecamatan, result.religion, result.marital_status, result.occupation, result.citizenship
  ];
  const recognizedCount = fieldsToCheck.filter((f) => f !== null && f !== undefined && f !== '').length;
  result.recognized_fields_count = recognizedCount;
  result.total_fields_count = 13;

  if (recognizedCount === 0) result.confidence = 0.0;
  else {
    const completeness = recognizedCount / 13;
    const combined = ocrConfidence * 0.4 + completeness * 0.6;
    result.confidence = Math.round(combined * 100) / 100;
  }

  return result;
}
