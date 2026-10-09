/**
 * Move the per-org operator sequence counter from the dedicated
 * `tbl_operator_sequence` collection onto each organization document
 * (`tbl_organizations.operator_seq`), then drop the old collection.
 *
 * Keeps already-issued operator IDs valid: `$inc` on a missing field would
 * otherwise start at 1 (producing ids like `AC1`), so every org is first
 * defaulted to 1000, then overwritten with the higher of the old sequence
 * value / the highest suffix already assigned to its operators.
 *
 * Run: npm run migrate:operator-seq
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { User, Organization } from '../models/index.js';

const SEQ_BASE = 1000;

const suffixOf = (operatorId?: string | null): number => {
  if (!operatorId) return 0;
  const match = String(operatorId).match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
};

const run = async () => {
  await mongoose.connect(config.mongoose.url);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection available');

  // Any org whose field is missing gets the safe default first so $inc
  // never jumps the counter to 1.
  await Organization.updateMany(
    { operator_seq: { $exists: false } },
    { $set: { operator_seq: SEQ_BASE } },
  );

  const oldDocs = await db
    .collection('tbl_operator_sequence')
    .find({}, { projection: { organization_id: 1, seq: 1 } })
    .toArray();
  const oldSeqByOrg = new Map<string, number>();
  for (const doc of oldDocs as any[]) {
    if (doc?.organization_id) {
      oldSeqByOrg.set(String(doc.organization_id), Number(doc?.seq) || 0);
    }
  }
  console.log(`[MIGRATE] old sequence rows: ${oldDocs.length}`);

  const operators = await User.find({
    role: 'OPERATOR',
    status: { $ne: 2 },
    operator_id: { $exists: true, $nin: [null, ''] },
  })
    .select('organization_id operator_id')
    .lean();
  const maxSuffixByOrg = new Map<string, number>();
  for (const user of operators as any[]) {
    const orgId = user?.organization_id ? String(user.organization_id) : null;
    if (!orgId) continue;
    const suffix = suffixOf(user.operator_id);
    if (suffix > (maxSuffixByOrg.get(orgId) ?? 0)) {
      maxSuffixByOrg.set(orgId, suffix);
    }
  }

  const orgIds = new Set([...oldSeqByOrg.keys(), ...maxSuffixByOrg.keys()]);
  let updated = 0;
  for (const orgId of orgIds) {
    const next = Math.max(
      SEQ_BASE,
      oldSeqByOrg.get(orgId) ?? 0,
      maxSuffixByOrg.get(orgId) ?? 0,
    );
    await Organization.updateOne(
      { _id: orgId },
      { $set: { operator_seq: next } },
    );
    if (next > SEQ_BASE) {
      console.log(`[MIGRATE] org ${orgId} operator_seq -> ${next}`);
    }
    updated += 1;
  }

  await db
    .collection('tbl_operator_sequence')
    .drop()
    .catch(() => {});
  console.log(
    `[MIGRATE] organizations seeded: ${updated}; old tbl_operator_sequence dropped`,
  );
  await mongoose.disconnect();
  console.log('[MIGRATE] done.');
};

run().catch(async (err) => {
  console.error('[MIGRATE] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
