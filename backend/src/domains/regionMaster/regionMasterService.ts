import { Pool } from 'pg';

export interface Province {
  id: number;
  bps_code: string;
  name: string;
  capital?: string | null;
}

export interface Regency {
  id: number;
  bps_code: string;
  province_bps_code: string;
  name: string;
  capital?: string | null;
}

export async function listProvinces(pool: Pool): Promise<Province[]> {
  const res = await pool.query<Province>('SELECT id, bps_code, name, capital FROM provinces ORDER BY name');
  return res.rows;
}

export async function listRegencies(pool: Pool, provinceBpsCode?: string): Promise<Regency[]> {
  if (provinceBpsCode) {
    const res = await pool.query<Regency>(
      'SELECT id, bps_code, province_bps_code, name, capital FROM regencies WHERE province_bps_code = $1 ORDER BY name',
      [provinceBpsCode]
    );
    return res.rows;
  }
  const res = await pool.query<Regency>(
    'SELECT id, bps_code, province_bps_code, name, capital FROM regencies ORDER BY name'
  );
  return res.rows;
}

export async function getRegencyById(pool: Pool, id: number): Promise<Regency | null> {
  const res = await pool.query<Regency>('SELECT id, bps_code, province_bps_code, name, capital FROM regencies WHERE id = $1', [id]);
  return res.rows[0] || null;
}

export async function searchRegencies(pool: Pool, q: string, limit = 20): Promise<Regency[]> {
  const res = await pool.query<Regency>(
    `SELECT r.id, r.bps_code, r.province_bps_code, r.name, r.capital
     FROM regencies r
     WHERE r.name ILIKE $1
     ORDER BY r.name
     LIMIT $2`,
    [`%${q}%`, limit]
  );
  return res.rows;
}
