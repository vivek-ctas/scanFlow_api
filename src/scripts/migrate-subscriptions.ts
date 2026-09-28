import mongoose from 'mongoose';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { Organization } from '../models/organization.model.js';
import { Plan } from '../models/plan.model.js';
import { grantSubscription } from '../services/subscription.service.js';

const execute = process.argv.includes('--execute');
const ORG_COLLECTION = 'tbl_organizations';

const mapBillingCycle = (period?: string) =>
  period === 'yearly' ? 'yearly' : 'monthly';

console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`);

const run = async () => {
  await mongoose.connect(config.mongoose.url);
  logger.info(`Connected to ${config.mongoose.url}`);

  const orgs = (await Organization.find(
    {},
    { name: 1, email: 1, status: 1, scanQuota: 1, scanUsage: 1 },
  ).lean()) as any[];

  console.log('\n=== REPORT ===');
  console.log(`Total organizations: ${orgs.length}`);
  orgs.forEach((o) => {
    console.log(
      `  ${String(o._id)} | ${o.name} | status=${o.status} | quota.limit=${o.scanQuota?.limit ?? 'n/a'} | period=${o.scanQuota?.period ?? 'n/a'} | usage.count=${o.scanUsage?.count ?? 'n/a'}`,
    );
  });

  const candidates = orgs.filter(
    (o) => o.status !== 2 && (o.scanQuota?.limit ?? 0) > 0,
  );
  console.log(
    `\nMigration candidates (active, non-zero quota): ${candidates.length}`,
  );

  const dedupe = new Map<string, any>();
  for (const o of candidates) {
    const cycle = mapBillingCycle(o.scanQuota?.period);
    const key = `${cycle}|${o.scanQuota.limit}`;
    dedupe.set(key, { cycle, limit: o.scanQuota.limit });
  }
  console.log(
    `Distinct (billingCycle, scanLimit) plan shapes to create: ${dedupe.size}`,
  );
  dedupe.forEach((shape) => {
    console.log(`  - ${shape.cycle}, ${shape.limit} scans`);
  });

  if (!execute) {
    console.log(
      '\nDRY-RUN complete — pass --execute to migrate and drop the flat quota.',
    );
    return;
  }

  const ensureMigratedPlan = async (
    cycle: string,
    limit: number,
  ): Promise<any> => {
    const name = `Migrated - ${limit} scans`;
    let plan: any = await (Plan as any).findOne({
      name,
      billingCycle: cycle,
      scanLimit: limit,
    });
    if (!plan) {
      plan = await (Plan as any).create({
        name,
        billingCycle: cycle,
        amount: 0,
        currency: 'INR',
        trialDays: 0,
        scanLimit: limit,
        isActive: true,
        isPublic: false,
      });
      console.log(`  Created Migrated Plan: ${plan.name} (${cycle})`);
    }
    return plan;
  };

  let granted = 0;
  for (const org of candidates) {
    const cycle = mapBillingCycle(org.scanQuota?.period);
    const limit = org.scanQuota.limit;
    const plan = await ensureMigratedPlan(cycle, limit);
    const sub = await grantSubscription(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    granted += 1;
    console.log(
      `  Grant ${sub.status}@${cycle}/${limit} -> ${org.name} (${sub._id})`,
    );
  }
  console.log(`Granted subscriptions: ${granted}`);

  const unset = await mongoose.connection
    .db!.collection(ORG_COLLECTION)
    .updateMany({}, { $unset: { scanQuota: '', scanUsage: '' } });
  console.log(
    `Dropped scanQuota/scanUsage from: ${unset.modifiedCount} documents`,
  );

  const leftovers = await mongoose.connection
    .db!.collection(ORG_COLLECTION)
    .countDocuments({
      $or: [{ scanQuota: { $exists: true } }, { scanUsage: { $exists: true } }],
    });
  console.log(`Documents still carrying scanQuota/scanUsage: ${leftovers}`);

  console.log(
    '\n=== DONE — flat quota removed; all orgs now on Subscription + Usage. ===',
  );
};

run()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
