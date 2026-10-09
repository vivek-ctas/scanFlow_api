/**
 * Backfill Operator IDs for existing OPERATOR users that don't have one.
 *
 * Idempotent: users with a set operator_id are skipped. Each organization gets
 * its own sequence starting at 1001. No PINs are backfilled — an admin must
 * assign a PIN before an operator can log in with their Operator ID.
 *
 * Run: npm run migrate:operator-ids
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { User, Organization } from '../models/index.js';
import { buildOperatorId } from '../utils/operator-id.util.js';

const MAX_RETRIES = 5;

const run = async () => {
  await mongoose.connect(config.mongoose.url);

  const pending = await User.find({
    role: 'OPERATOR',
    status: { $ne: 2 },
    $or: [
      { operator_id: { $exists: false } },
      { operator_id: null },
      { operator_id: '' },
    ],
  }).lean();

  console.log(`[MIGRATE] operators missing operator_id: ${pending.length}`);

  const orgCache = new Map<string, { company_name?: string | null }>();

  let assigned = 0;
  let skipped = 0;

  for (const user of pending) {
    const orgId = String(user.organization_id ?? '');
    if (!orgId) {
      console.warn(`[MIGRATE] skip user ${user._id} (no organization_id)`);
      skipped += 1;
      continue;
    }

    let org = orgCache.get(orgId);
    if (!org) {
      org = (await Organization.findById(orgId).lean()) ?? {};
      orgCache.set(orgId, org);
    }

    let ok = false;
    for (let i = 0; i < MAX_RETRIES; i += 1) {
      try {
        const operatorId = await buildOperatorId(org?.company_name, orgId);
        await User.updateOne(
          { _id: user._id },
          { $set: { operator_id: operatorId } },
        );
        console.log(`[MIGRATE] user ${user._id} -> ${operatorId}`);
        assigned += 1;
        ok = true;
        break;
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
      }
    }
    if (!ok) {
      console.error(
        `[MIGRATE] FAILED to allocate operator_id for user ${user._id}`,
      );
      skipped += 1;
    }
  }

  console.log(`[MIGRATE] assigned=${assigned}, skipped=${skipped}`);
  await mongoose.disconnect();
  console.log('[MIGRATE] done.');
};

run().catch(async (err) => {
  console.error('[MIGRATE] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
