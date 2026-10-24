import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const MIGRATION_VERSION = 'pos_whatsapp_receipt_v1';

export type MigrationStep = {
  id: string;
  description: string;
  sql: string;
};

export const POS_WHATSAPP_RECEIPT_STEPS: MigrationStep[] = [
  {
    id: '01_create_pos_whatsapp_receipt_logs_table',
    description: 'Create pos_whatsapp_receipt_logs table for digital WhatsApp receipt dispatch audit (MP-05A)',
    sql: `
      CREATE TABLE IF NOT EXISTS pos_whatsapp_receipt_logs (
        id BIGSERIAL PRIMARY KEY,
        property_id INTEGER NOT NULL REFERENCES properties(id),
        order_id INTEGER NOT NULL REFERENCES pos_orders(id),
        recipient_phone VARCHAR(50) NOT NULL,
        recipient_phone_masked VARCHAR(50) NOT NULL,
        message_content TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'SENT',
        gateway_response JSONB NULL,
        error_message TEXT NULL,
        sent_by_user_id INTEGER NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_pos_wa_receipt_status CHECK (status IN ('SENT', 'FAILED'))
      );

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chk_pos_wa_receipt_status'
            AND conrelid = 'pos_whatsapp_receipt_logs'::regclass
        ) THEN
          ALTER TABLE pos_whatsapp_receipt_logs
            ADD CONSTRAINT chk_pos_wa_receipt_status CHECK (status IN ('SENT', 'FAILED'));
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_pos_wa_receipt_logs_order
        ON pos_whatsapp_receipt_logs(order_id);

      CREATE INDEX IF NOT EXISTS idx_pos_wa_receipt_logs_property
        ON pos_whatsapp_receipt_logs(property_id, created_at DESC);
    `,
  },
  {
    id: '02_record_schema_migrations_version',
    description: 'Record pos_whatsapp_receipt_v1 in schema_migrations table',
    sql: `
      INSERT INTO schema_migrations (version)
      VALUES ('${MIGRATION_VERSION}')
      ON CONFLICT (version) DO NOTHING;
    `,
  },
];

export async function runPosWhatsappReceiptMigration(poolOrClient: Pool | PoolClient): Promise<void> {
  const isPool = 'totalCount' in poolOrClient;
  const client: PoolClient = isPool ? await (poolOrClient as Pool).connect() : (poolOrClient as PoolClient);

  try {
    if (isPool) {
      await client.query('BEGIN');
    }

    const checkRes = await client.query(
      `SELECT version FROM schema_migrations WHERE version = $1`,
      [MIGRATION_VERSION]
    );

    if (checkRes.rows.length > 0) {
      console.log(`[pos_whatsapp_receipt_v1] Migration already recorded in schema_migrations. Skipping steps.`);
      if (isPool) {
        await client.query('COMMIT');
      }
      return;
    }

    for (const step of POS_WHATSAPP_RECEIPT_STEPS) {
      console.log(`[pos_whatsapp_receipt_v1] Applying ${step.id}: ${step.description}`);
      await client.query(step.sql);
    }

    if (isPool) {
      await client.query('COMMIT');
    }
    console.log(`[pos_whatsapp_receipt_v1] Migration completed successfully.`);
  } catch (error) {
    if (isPool) {
      await client.query('ROLLBACK');
    }
    console.error(`[pos_whatsapp_receipt_v1] Migration failed:`, error);
    throw error;
  } finally {
    if (isPool) {
      client.release();
    }
  }
}
