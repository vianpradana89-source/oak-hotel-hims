#!/usr/bin/env node
/**
 * Optional one-off backfill: copy surviving LOCAL identity files into private storage
 * and write guests.identity_storage_key metadata.
 *
 * Safety:
 * - dry-run by default (pass --apply to write)
 * - idempotent (skips guests that already have identity_storage_key)
 * - copies only files that physically exist
 * - never deletes the source file
 * - never rewrites identity_path / reservations.ktp_path
 * - writes storage metadata only after successful upload + hash verify
 *
 * Do NOT run automatically. Do NOT run against staging from this implementation.
 *
 * Usage:
 *   node scripts/backfill_identity_documents.js
 *   node scripts/backfill_identity_documents.js --apply
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const apply = process.argv.includes('--apply');
const uploadDir = process.env.IDENTITY_BACKFILL_UPLOAD_DIR
  ? path.resolve(process.env.IDENTITY_BACKFILL_UPLOAD_DIR)
  : path.resolve(__dirname, '..', 'uploads');

function report(title, rows) {
  console.log(`\n${title}: ${rows.length}`);
  for (const row of rows.slice(0, 25)) {
    console.log(`  - ${JSON.stringify(row)}`);
  }
  if (rows.length > 25) {
    console.log(`  ... ${rows.length - 25} more`);
  }
}

async function main() {
  const {
    persistIdentityDocument,
    parseIdentityDocumentBasename
  } = require('../dist/domains/identity/identityDocumentStorageService');
  const { calculatePhotoHash } = require('../dist/domains/auth/faceEnrollmentStorageService');

  const pool = new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'secretpassword',
    database: process.env.DB_NAME || 'oak_hotel_db'
  });

  const migrated = [];
  const skipped = [];
  const missing = [];
  const failed = [];

  try {
    const guests = await pool.query(`
      SELECT id, created_property_id, identity_path, identity_storage_key,
             identity_original_filename, identity_mime_type
      FROM guests
      WHERE identity_path IS NOT NULL
        AND BTRIM(identity_path) <> ''
        AND identity_storage_key IS NULL
      ORDER BY id
    `);

    console.log(`IDENTITY DOCUMENT BACKFILL (${apply ? 'APPLY' : 'DRY-RUN'})`);
    console.log(`Candidates: ${guests.rowCount}`);
    console.log(`Local source dir: ${uploadDir}`);

    for (const guest of guests.rows) {
      const guestId = Number(guest.id);
      const propertyId = Number(guest.created_property_id);
      const basename = parseIdentityDocumentBasename(guest.identity_path);
      if (!basename) {
        skipped.push({ guestId, reason: 'UNPARSEABLE_PATH', identity_path: guest.identity_path });
        continue;
      }
      if (!Number.isInteger(propertyId) || propertyId <= 0) {
        skipped.push({ guestId, reason: 'MISSING_PROPERTY_ID' });
        continue;
      }

      const candidates = [
        path.resolve(uploadDir, 'identity', basename),
        path.resolve(uploadDir, basename)
      ];
      const sourcePath = candidates.find((p) => p.startsWith(path.resolve(uploadDir)) && fs.existsSync(p));
      if (!sourcePath) {
        missing.push({ guestId, basename, identity_path: guest.identity_path });
        continue;
      }

      try {
        const buffer = fs.readFileSync(sourcePath);
        const mimeType = guest.identity_mime_type || (
          basename.toLowerCase().endsWith('.pdf') ? 'application/pdf'
            : basename.toLowerCase().endsWith('.png') ? 'image/png'
              : basename.toLowerCase().endsWith('.webp') ? 'image/webp'
                : 'image/jpeg'
        );
        const expectedHash = calculatePhotoHash(buffer);

        if (!apply) {
          skipped.push({ guestId, reason: 'DRY_RUN', basename, bytes: buffer.length, hash: expectedHash });
          continue;
        }

        const persisted = await persistIdentityDocument({
          propertyId,
          buffer,
          mimeType,
          originalFilename: guest.identity_original_filename || basename,
          size: buffer.length
        });

        if (persisted.hash !== expectedHash) {
          failed.push({ guestId, reason: 'HASH_MISMATCH', expectedHash, actualHash: persisted.hash });
          continue;
        }

        await pool.query(
          `UPDATE guests
           SET identity_storage_key = $1,
               identity_mime_type = COALESCE(identity_mime_type, $2),
               identity_file_hash = COALESCE(identity_file_hash, $3),
               identity_original_filename = COALESCE(identity_original_filename, $4),
               identity_uploaded_at = COALESCE(identity_uploaded_at, NOW())
           WHERE id = $5
             AND identity_storage_key IS NULL`,
          [
            persisted.storageKey,
            persisted.mimeType,
            persisted.hash,
            persisted.originalFilename,
            guestId
          ]
        );

        migrated.push({
          guestId,
          storageKey: persisted.storageKey,
          hash: persisted.hash,
          sourcePath
        });
      } catch (err) {
        failed.push({ guestId, reason: err.message || String(err) });
      }
    }

    report('migrated', migrated);
    report('skipped', skipped);
    report('missing', missing);
    report('failed', failed);
    console.log('\nSource files were never deleted. identity_path values were never rewritten.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
