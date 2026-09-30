/**
 * One-time migration: tbl_organizations.name -> company_name.
 *
 * Replaces the legacy `name` field with `company_name` on any org document
 * still carrying `name`. Safe to run against any environment: docs already
 * using `company_name` are left untouched, and a doc cannot have both after
 * this runs ($rename overwrites the target when both exist, so we guard that
 * case by only renaming when company_name is absent).
 *
 * Run: npm run migrate:org-company-name
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { Organization } from '../models/organization.model.js';

const run = async () => {
  await mongoose.connect(config.mongoose.url);

  // Raw driver access: mongoose strips the unknown `name` path out of
  // $rename in strict mode, so the update must bypass schema casting.
  const col = Organization.collection;

  const legacy = await col.countDocuments({
    name: { $exists: true },
    company_name: { $exists: false },
  });
  const both = await col.countDocuments({
    name: { $exists: true },
    company_name: { $exists: true },
  });

  console.log(
    `[MIGRATE] collection=${col.collectionName} orgs with legacy "name" only: ${legacy}; with both fields: ${both}`,
  );

  if (legacy > 0) {
    const res = await col.updateMany(
      { name: { $exists: true }, company_name: { $exists: false } },
      { $rename: { name: 'company_name' } },
    );
    console.log(`[MIGRATE] renamed: ${res.modifiedCount} document(s)`);
  }

  const remaining = await col.countDocuments({ name: { $exists: true } });
  const migrated = await col.countDocuments({
    company_name: { $exists: true },
  });
  console.log(
    `[MIGRATE] verify -> docs with company_name: ${migrated}, docs still with name: ${remaining}`,
  );

  if (both > 0) {
    console.warn(
      `[MIGRATE] ${both} document(s) already have both name and company_name; ` +
        'please review them manually (they were left untouched).',
    );
  }

  await mongoose.disconnect();
  console.log('[MIGRATE] done.');
};

run().catch(async (err) => {
  console.error('[MIGRATE] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
