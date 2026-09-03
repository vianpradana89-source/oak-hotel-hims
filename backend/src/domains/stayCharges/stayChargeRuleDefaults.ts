import type { Pool, PoolClient } from 'pg';

// Baseline rules are created per real property and never overwrite local edits.
export async function seedBaselineStayChargeRules(
  client: Pool | PoolClient,
  propertyId?: number
): Promise<number> {
  const result = await client.query(`
    INSERT INTO stay_charge_rules (
      property_id, charge_type, code, name, description, charge_method,
      default_amount, percentage_rate, taxable, service_chargeable, requires_note,
      sort_order, created_by
    )
    SELECT
      p.id, rule_defaults.charge_type, rule_defaults.code, rule_defaults.name, rule_defaults.description,
      rule_defaults.charge_method, rule_defaults.default_amount, rule_defaults.percentage_rate,
      rule_defaults.taxable, rule_defaults.service_chargeable, rule_defaults.requires_note,
      rule_defaults.sort_order, 'SYSTEM_SEED'
    FROM properties p
    CROSS JOIN (
      VALUES
        ('EXTRA_BED', 'EXTRA_BED_STD', 'Extra Bed Standar', 'Kasur tambahan dewasa standar dengan sprei dan bantal', 'FIXED_AMOUNT', 150000::numeric, 0::numeric, TRUE, TRUE, FALSE, 1),
        ('EXTRA_PERSON', 'EXTRA_PERSON_ADULT', 'Extra Person Dewasa', 'Tamu tambahan dewasa tanpa kasur tambahan', 'FIXED_AMOUNT', 100000::numeric, 0::numeric, TRUE, TRUE, FALSE, 2),
        ('EARLY_CHECKIN', 'EARLY_CHECKIN_STD', 'Early Check-in Standar', 'Biaya masuk lebih awal (sebelum 14:00)', 'PERCENTAGE_OF_NIGHTLY_RATE', 0::numeric, 50.00::numeric, TRUE, TRUE, FALSE, 3),
        ('LATE_CHECKOUT', 'LATE_CHECKOUT_STD', 'Late Check-out Standar', 'Biaya perpanjangan jam keluar (setelah 12:00)', 'PERCENTAGE_OF_NIGHTLY_RATE', 0::numeric, 50.00::numeric, TRUE, TRUE, FALSE, 4),
        ('PENALTY', 'PENALTY_LOST_KEY', 'Kartu Kunci Hilang', 'Penggantian kartu kunci RFID hilang / rusak', 'FIXED_AMOUNT', 50000::numeric, 0::numeric, FALSE, FALSE, FALSE, 5),
        ('PENALTY', 'PENALTY_SMOKING', 'Denda Merokok (Smoking Charge)', 'Denda merokok di dalam kamar non-smoking', 'FIXED_AMOUNT', 500000::numeric, 0::numeric, FALSE, FALSE, TRUE, 6),
        ('PENALTY', 'PENALTY_DAMAGE', 'Kerusakan Kamar / Properti', 'Penggantian / perbaikan kerusakan fasilitas kamar', 'MANUAL', 0::numeric, 0::numeric, FALSE, FALSE, TRUE, 7)
    ) AS rule_defaults (
      charge_type, code, name, description, charge_method, default_amount,
      percentage_rate, taxable, service_chargeable, requires_note, sort_order
    )
    WHERE ($1::integer IS NULL OR p.id = $1)
      AND NOT EXISTS (
        SELECT 1
        FROM stay_charge_rules existing
        WHERE existing.property_id = p.id
          AND UPPER(TRIM(existing.code)) = UPPER(TRIM(rule_defaults.code))
      )
    ON CONFLICT DO NOTHING;
  `, [propertyId ?? null]);

  return result.rowCount ?? 0;
}
