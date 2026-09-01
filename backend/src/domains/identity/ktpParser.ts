import { IdentityCandidateData } from './identityTypes';

/**
 * Standard Indonesian KTP deterministic parser
 */

const KTP_LABELS_REGEX = /^(?:NIK|N1K|NlK|NO\.?\s*KTP|Nama|Narna|Narne|Name|Tempat|Tpt|TgLahir|Tgl|Tanggal|Lahir|Jenis|Kelamin|Sex|Gender|Alamat|Ala\s*mat|Alarnat|Address|RT|RW|RTAW|RTRW|Kel|Desa|Kelurahan|Kecamatan|Kec|Agama|Status|Perkawinan|Perkawinar|Pekerjaan|Kewarganegaraan|Berlaku|Masa|Gol|Darah)/i;

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

  // Pattern 1: DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY or DD MM YYYY (with mixed separators)
  const m1 = s.match(/\b(\d{1,2})[\s\-\/\.]+(\d{1,2})[\s\-\/\.]+(\d{4})\b/);
  if (m1) {
    const day = m1[1].padStart(2, '0');
    const month = m1[2].padStart(2, '0');
    const year = m1[3];
    return `${year}-${month}-${day}`;
  }

  // Pattern 2: Textual month Indonesian (e.g. 12 Mei 1990)
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
    const year = m2[3];
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
  if (/\b(?:LAKI[\-\s]*LAKI|PRIA|LAK1[\-\s]*LAK1|LAK[I1l!])\b/i.test(s)) {
    return 'MALE';
  }
  if (/\b(?:PEREMPUAN|WANITA|PERE[\s\w]*AN)\b/i.test(s)) {
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
  if (/\b(?:KAWIN|KAwIN|MENIKAH)\b/i.test(s)) return 'KAWIN';
  return null;
}

export function normalizeCitizenship(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (/\b(?:WNI|INDONESIA|\/NI)\b/i.test(s) || /Kewargane[a-z]*N?I/i.test(s)) return 'WNI';
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

function cleanValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^[:;=\-\s]+/, '').replace(/[:;=\-\s]+$/, '');
  return s.length > 0 ? s : null;
}

/**
 * Parses raw OCR lines into structured candidate data
 */
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
      const dateMatch = val.match(/(\d{1,2}[\s\-\/\.]+\d{1,2}[\s\-\/\.]+\d{4})/);
      if (dateMatch) {
        result.birth_date = normalizeDate(dateMatch[1]);
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
        const dateMatch = l.match(/\b(\d{1,2}[\s\-\/\.]+\d{1,2}[\s\-\/\.]+\d{4})\b/);
        if (dateMatch) {
          if (!result.birth_date) {
            result.birth_date = normalizeDate(dateMatch[1]);
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
    const m = l.match(/\b(?:RT[\s\/\.\-]*[A-Z0-9]*[\/\.\-]*RW|RT|RTAW|RTRW)\s*[:;=\-\s]*(\d{2,3}\s*[\/\.\-]\s*\d{2,3})/i);
    if (m) {
      result.rt_rw = m[1].replace(/\s+/g, '');
      const afterRtRw = l.slice(l.indexOf(m[0]) + m[0].length).trim();
      if (afterRtRw && !isLabelHeader(afterRtRw)) {
        result.address = afterRtRw.replace(/^[:;=\-\s]+/, '').toUpperCase();
      }
      break;
    }
  }

  // If address still null, extract from Alamat line
  if (!result.address) {
    for (let i = 0; i < cleanLines.length; i++) {
      const l = cleanLines[i];
      if (/(?:Al[aA4]m[aA4]t|Ala\s*mat|Alarnat|Address)/i.test(l)) {
        const m = l.match(/(?:Al[aA4]m[aA4]t|Ala\s*mat|Alarnat|Address)\s*[:;=\-\s]+\s*([A-Za-z0-9\s\.\,\-]+)/i);
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

  // 6. Kelurahan / Desa
  for (let i = 0; i < cleanLines.length; i++) {
    const l = cleanLines[i];
    const m = l.match(/(?:^|.*?\b)(?:Kel(?:urahan)?[\s\/\.\-]+Desa|Kel(?:urahan)?(?!\s*Kelamin)|Desa)\s*[:;=\-\s]+([A-Za-z\s]+)/i);
    if (m) {
      const val = m[1].split(/\s+(?=(?:Kecamatan|Agama|RT|Status)\b)/i)[0].trim();
      if (val && !isLabelHeader(val) && !/Kelamin/i.test(val)) {
        result.village_kelurahan = val.replace(/^[:;=\-\s]+/, '').toUpperCase();
        break;
      }
    } else if (/(?:^|\b)(?:Kel(?:urahan)?[\s\/\.\-]*Desa|Kel(?:urahan)?(?!\s*Kelamin)|Desa)$/i.test(l)) {
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

