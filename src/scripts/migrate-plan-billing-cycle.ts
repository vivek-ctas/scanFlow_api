/**
 * One-time migration: add `billing_cycle` to tbl_plans (and backfill guest leads).
 *
 * `plan.billing_cycle` is the single cycle a plan is sold on. Existing plans are
 * defaulted to 'month' (their canonical `price`), so no plan silently changes
 * price. Quarterly-priced plans that should be sold quarterly need one admin
 * edit (PUT /api/plans/:id with billing_cycle: 'quarterly') or a manual
 * updateMany with the target `_id`s.
 *
 * `price_quarterly` is deliberately left untouched — it is now derived on every
 * plan write, and nulling it here would destroy pricing data. Note that
 * `price_quarterly` is always stored as a number now (derived as `price * 3` minus
 * discount unless an explicit override is given); `billing_cycle` alone decides
 * which of the two prices is charged. Plans predating this still carry a null
 * quarterly amount and are backfilled manually, not by this script.
 *
 * Safe to re-run: only documents missing the field are touched.
 *
 * Run: npm run migrate:plan-billing-cycle
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { Plan } from '../models/plan.model.js';
import { GuestLead } from '../models/guest-lead.model.js';

const DEFAULT_CYCLE = 'month';

const run = async () => {
  await mongoose.connect(config.mongoose.url);

  const planCol = Plan.collection;
  const leadCol = GuestLead.collection;

  const totalPlans = await planCol.countDocuments({});
  const plansMissing = await planCol.countDocuments({
    billing_cycle: { $exists: false },
  });
  const leadsMissing = await leadCol.countDocuments({
    billing_cycle: { $exists: false },
  });

  console.log(
    `[MIGRATE] collection=${planCol.collectionName} plans=${totalPlans}, missing billing_cycle=${plansMissing}`,
  );
  console.log(
    `[MIGRATE] collection=${leadCol.collectionName} leads missing billing_cycle=${leadsMissing}`,
  );

  if (plansMissing > 0) {
    const res = await planCol.updateMany(
      { billing_cycle: { $exists: false } },
      { $set: { billing_cycle: DEFAULT_CYCLE } },
    );
    console.log(`[MIGRATE] plans updated: ${res.modifiedCount}`);
  }

  if (leadsMissing > 0) {
    const res = await leadCol.updateMany(
      { billing_cycle: { $exists: false } },
      { $set: { billing_cycle: DEFAULT_CYCLE } },
    );
    console.log(`[MIGRATE] guest leads updated: ${res.modifiedCount}`);
  }

  const verifyPlans = await planCol.countDocuments({
    billing_cycle: { $in: ['month', 'quarterly'] },
  });
  const verifyLeads = await leadCol.countDocuments({
    billing_cycle: { $exists: true },
  });
  console.log(
    `[MIGRATE] verify -> plans with a valid billing_cycle: ${verifyPlans}/${totalPlans}, leads with billing_cycle: ${verifyLeads}`,
  );
  console.log(
    `[MIGRATE] note: price_quarterly was left as-is. Set billing_cycle='quarterly' on a plan to start selling it quarterly.`,
  );

  await mongoose.disconnect();
  console.log('[MIGRATE] done.');
};

run().catch(async (err) => {
  console.error('[MIGRATE] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
