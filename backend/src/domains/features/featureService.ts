import { Pool, PoolClient } from 'pg';
import { DEFAULT_FEATURE_FLAGS, FEATURE_ALIASES, FeatureKey, PropertyFeatureRecord } from './featureTypes';

type Queryable = Pool | PoolClient;

function resolveCanonicalKey(key: string): string {
  return FEATURE_ALIASES[key] || key;
}

export async function ensurePropertyFeatures(db: Queryable, propertyId: number): Promise<void> {
  for (const [key, defaultVal] of Object.entries(DEFAULT_FEATURE_FLAGS)) {
    await db.query(
      `INSERT INTO property_features (property_id, feature_key, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (property_id, feature_key) DO NOTHING`,
      [propertyId, key, defaultVal]
    );
  }
}

export async function getPropertyFeatures(db: Queryable, propertyId: number): Promise<Record<string, boolean>> {
  await ensurePropertyFeatures(db, propertyId);

  const res = await db.query(
    `SELECT feature_key, enabled
     FROM property_features
     WHERE property_id = $1`,
    [propertyId]
  );

  const flags: Record<string, boolean> = { ...DEFAULT_FEATURE_FLAGS };
  for (const row of res.rows) {
    flags[row.feature_key] = Boolean(row.enabled);
  }

  // Synchronize aliases so both canonical and alias keys match
  for (const [alias, canonical] of Object.entries(FEATURE_ALIASES)) {
    if (flags[canonical] !== undefined) {
      flags[alias] = flags[canonical];
    }
  }

  return flags;
}

export async function isFeatureEnabled(
  db: Queryable,
  propertyId: number,
  featureKey: string
): Promise<boolean> {
  const flags = await getPropertyFeatures(db, propertyId);
  const resolvedKey = resolveCanonicalKey(featureKey);

  // Hierarchy enforcement: if checking any domain sub-feature, the domain's master switch must be enabled
  const domainPrefix = resolvedKey.split('.')[0];
  const masterKey = `${domainPrefix}.enabled`;
  if (resolvedKey !== masterKey && flags[masterKey] === false) {
    return false;
  }

  return flags[resolvedKey] !== undefined ? flags[resolvedKey] : (DEFAULT_FEATURE_FLAGS[resolvedKey] ?? false);
}

export async function setFeatureFlag(
  db: Queryable,
  propertyId: number,
  featureKey: string,
  enabled: boolean,
  actorName?: string
): Promise<PropertyFeatureRecord> {
  const canonicalKey = resolveCanonicalKey(featureKey);

  const res = await db.query(
    `INSERT INTO property_features (property_id, feature_key, enabled, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (property_id, feature_key)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW(), updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [propertyId, canonicalKey, enabled, actorName || 'System']
  );

  // Also sync alias key in db if applicable
  for (const [alias, target] of Object.entries(FEATURE_ALIASES)) {
    if (target === canonicalKey) {
      await db.query(
        `INSERT INTO property_features (property_id, feature_key, enabled, updated_at, updated_by)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (property_id, feature_key)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [propertyId, alias, enabled, actorName || 'System']
      );
    }
  }

  await db.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'SETTINGS',
      'PROPERTY_FEATURE_TOGGLED',
      'PROPERTY_FEATURE',
      canonicalKey,
      JSON.stringify({ property_id: propertyId, feature_key: canonicalKey, enabled, updated_by: actorName || 'System' }),
      actorName || 'System',
      propertyId,
    ]
  );

  return res.rows[0];
}

export async function setBatchFeatureFlags(
  db: Queryable,
  propertyId: number,
  updates: Record<string, boolean>,
  actorName?: string
): Promise<Record<string, boolean>> {
  for (const [key, val] of Object.entries(updates)) {
    const canonicalKey = resolveCanonicalKey(key);
    await db.query(
      `INSERT INTO property_features (property_id, feature_key, enabled, updated_at, updated_by)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (property_id, feature_key)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
      [propertyId, canonicalKey, val, actorName || 'System']
    );

    // Sync alias
    for (const [alias, target] of Object.entries(FEATURE_ALIASES)) {
      if (target === canonicalKey) {
        await db.query(
          `INSERT INTO property_features (property_id, feature_key, enabled, updated_at, updated_by)
           VALUES ($1, $2, $3, NOW(), $4)
           ON CONFLICT (property_id, feature_key)
           DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [propertyId, alias, val, actorName || 'System']
        );
      }
    }
  }

  await db.query(
    `INSERT INTO audit_logs (module, action, entity, record_id, new_value, correlation_id, property_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'SETTINGS',
      'PROPERTY_FEATURES_BATCH_UPDATED',
      'PROPERTY_FEATURES',
      String(propertyId),
      JSON.stringify({ property_id: propertyId, updates, updated_by: actorName || 'System' }),
      actorName || 'System',
      propertyId,
    ]
  );

  return getPropertyFeatures(db, propertyId);
}
