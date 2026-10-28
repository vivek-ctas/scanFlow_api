/**
 * One-time backfill: populate `last_public_message` on tbl_support_ticket from
 * each ticket's latest PUBLIC message (the denormalised preview the chat list
 * reads). Internal notes and events are ignored; the first message is always
 * public (the customer's description), so every ticket gets a value.
 *
 * Idempotent: only tickets whose stored `last_public_message` is missing, or
 * whose stored `at` does not match the latest public message's `created_at`,
 * are written. Re-running is a no-op once converged.
 *
 * Run: npm run backfill:support-last-public-message
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { SupportTicket } from '../models/support-ticket.model.js';
import { SupportMessage } from '../models/support-message.model.js';
import { buildPreview } from '../services/support.service.js';

const BATCH = 200;

const run = async () => {
  await mongoose.connect(config.mongoose.url);

  const total = await SupportTicket.countDocuments({});
  console.log(`[BACKFILL] tbl_support_ticket total=${total}`);

  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  const cursor = SupportTicket.find({})
    .select('_id organization_id last_message_at last_public_message')
    .cursor();

  for await (const ticket of cursor) {
    scanned += 1;

    const [latestPublic, latestAny] = await Promise.all([
      SupportMessage.findOne({
        ticket_id: ticket._id,
        is_internal: false,
        kind: { $ne: 'event' },
      })
        .sort({ created_at: -1 })
        .select('body sender_role sender_id created_at attachments')
        .lean(),
      SupportMessage.findOne({ ticket_id: ticket._id })
        .sort({ created_at: -1 })
        .select('created_at')
        .lean(),
    ]);

    if (!latestPublic) {
      skipped += 1;
      continue;
    }

    const at = new Date(latestPublic.created_at as Date);
    const stored = (ticket as any).last_public_message;
    const storedAt = stored?.at ? new Date(stored.at).getTime() : null;
    const needsSortField =
      !(ticket as any).last_message_at && latestAny?.created_at;

    if (
      storedAt === at.getTime() &&
      typeof stored?.preview === 'string' &&
      !needsSortField
    ) {
      skipped += 1;
      continue;
    }

    const set: Record<string, any> = {
      last_public_message: {
        preview: buildPreview(
          (latestPublic as any).body,
          (latestPublic as any).attachments ?? [],
        ),
        by_role: (latestPublic as any).sender_role ?? stored?.by_role ?? '',
        by_user_id: (latestPublic as any).sender_id ?? null,
        at,
      },
    };
    if (needsSortField) {
      set.last_message_at = new Date(latestAny!.created_at as Date);
    }

    await SupportTicket.updateOne({ _id: ticket._id }, { $set: set });
    updated += 1;

    if ((scanned + 1) % BATCH === 0) {
      console.log(`[BACKFILL] progress scanned=${scanned} updated=${updated}`);
    }
  }

  const remaining = await SupportTicket.countDocuments({
    last_public_message: { $in: [null] },
  });
  console.log(
    `[BACKFILL] done scanned=${scanned} updated=${updated} skipped=${skipped}`,
  );
  console.log(
    `[BACKFILL] verify -> tickets still without preview: ${remaining}`,
  );

  await mongoose.disconnect();
  console.log('[BACKFILL] complete.');
};

run().catch(async (err) => {
  console.error('[BACKFILL] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
