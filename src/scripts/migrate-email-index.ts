/**
 * One-time migration: rebuild the unique indexes for tbl_user.
 *
 * Operators no longer require an email, so the legacy `email: 1` unique index
 * (non-sparse) is replaced with a sparse unique index on email plus a sparse
 * unique index on operator_id. `syncIndexes` will fail if the old non-sparse
 * email index is still present, so we drop the legacy `email_1` first.
 *
 * Run: npm run migrate:email-index
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { User } from '../models/user.model.js';

const run = async () => {
  await mongoose.connect(config.mongoose.url);

  const col = User.collection;

  const current = await col.indexes();
  const legacyEmail = current.filter(
    (i) =>
      i.name === 'email_1' && i.key && (i as Record<string, any>).email === 1,
  );

  for (const idx of legacyEmail) {
    const { sparse } = idx as Record<string, any>;
    if (sparse) {
      console.log(`[MIGRATE] keeping sparse email index: ${idx.name}`);
      continue;
    }
    console.log(`[MIGRATE] dropping legacy non-sparse index: ${idx.name}`);
    await col.dropIndex(String(idx.name));
  }

  console.log(
    '[MIGRATE] calling syncIndexes() to build sparse unique indexes...',
  );
  await User.syncIndexes();

  const after = await col.indexes();
  console.log(
    '[MIGRATE] final indexes:',
    after
      .map((i) => i.name)
      .sort()
      .join(', '),
  );

  await mongoose.disconnect();
  console.log('[MIGRATE] done.');
};

run().catch(async (err) => {
  console.error('[MIGRATE] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
