/**
 * One-time migration: move the daily scan limit to the organization.
 *
 * The organization-wise refactor makes `tbl_organization.daily_scan_limit` the
 * single source of truth. Older data may still hold a plan-level value on a
 * subscription snapshot (`features[].daily_scan_limit`), a plan, and a
 * per-operator cap on `tbl_user.daily_scan_limit`.
 *
 * What this does:
 *  1. Audits `tbl_user`, `tbl_plan` and `tbl_subscription` for the removed
 *     daily fields and reports every non-zero value.
 *  2. Copies each active subscription's snapshotted daily limit onto its
 *     organization when the organization has no limit yet, so existing
 *     enforcement continues unchanged. Compare-and-set keeps a concurrent edit
 *     from being overwritten.
 *  3. `--apply` only: writes a JSON backup outside the database, then `$unset`s
 *     the removed fields. Operator caps are listed, never converted: a
 *     per-operator cap and an organization total are different things.
 *
 * `--dry-run` is the default; pass `--apply` to write. Safe to re-run: the
 * copy only fills a zero limit and cleanup only removes fields that exist.
 *
 * Run: npm run migrate:daily-limit-org            (dry run)
 *      npm run migrate:daily-limit-org -- --apply (apply)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import config from '../config/config.js';
import { Organization } from '../models/organization.model.js';
import { Plan } from '../models/plan.model.js';
import { Subscription } from '../models/subscription.model.js';
import { User } from '../models/user.model.js';

type MigrationMode = 'apply' | 'dry-run';

const log = (mode: MigrationMode, message: string): void => {
  console.log(`[MIGRATE:${mode}] ${message}`);
};

export interface AuditRow {
  id: string;
  name: string;
  value: number;
}

export interface DailyLimitMigrationResult {
  mode: MigrationMode;
  operator_caps: AuditRow[];
  plan_level_values: AuditRow[];
  subscription_level_values: AuditRow[];
  to_copy: number;
  copied: number;
  backup_file: string | null;
  cleanup: {
    users: number;
    plans: number;
    subscriptions: number;
    organizations_defaulted: number;
  } | null;
}

export interface DailyLimitMigrationOptions {
  apply?: boolean;
  /** Directory for the JSON backup; defaults to `DAILY_LIMIT_BACKUP_DIR` or `./backups`. */
  backupDir?: string;
}

export const listOperatorCaps = async (): Promise<AuditRow[]> => {
  const rows = await User.collection
    .find({ daily_scan_limit: { $gt: 0 } })
    .project({
      _id: 1,
      email: 1,
      first_name: 1,
      last_name: 1,
      daily_scan_limit: 1,
    })
    .toArray();
  return rows.map((row: any) => ({
    id: String(row._id),
    name:
      [row.first_name, row.last_name].filter(Boolean).join(' ') ||
      row.email ||
      'operator',
    value: Number(row.daily_scan_limit) || 0,
  }));
};

export const listPlanLevelValues = async (): Promise<AuditRow[]> => {
  const rows = await Plan.collection
    .find({ 'features.daily_scan_limit': { $gt: 0 } })
    .project({ _id: 1, name: 1, features: 1 })
    .toArray();
  return rows.map((row: any) => ({
    id: String(row._id),
    name: row.name ?? 'plan',
    value: (row.features ?? []).reduce(
      (max: number, feature: any) =>
        Math.max(max, Number(feature?.daily_scan_limit) || 0),
      0,
    ),
  }));
};

export const listSubscriptionValues = async (): Promise<AuditRow[]> => {
  const rows = await Subscription.collection
    .find({ 'features.daily_scan_limit': { $gt: 0 } })
    .project({ _id: 1, plan_name: 1, status: 1, features: 1 })
    .toArray();
  return rows.map((row: any) => ({
    id: String(row._id),
    name: `${row.plan_name ?? 'subscription'} (${row.status ?? 'unknown'})`,
    value: (row.features ?? []).reduce(
      (max: number, feature: any) =>
        Math.max(max, Number(feature?.daily_scan_limit) || 0),
      0,
    ),
  }));
};

const report = (mode: MigrationMode, title: string, rows: AuditRow[]): void => {
  log(mode, `${title}: ${rows.length} record(s)`);
  for (const row of rows) {
    log(mode, `  - ${row.id}  ${row.name}  -> ${row.value}/day`);
  }
};

/** Active subscription values to copy onto their organization. */
export const planValuesToCopy = async (): Promise<
  { subscriptionId: string; organizationId: string; value: number }[]
> => {
  const subscriptions = await Subscription.collection
    .find({ status: 'active', 'features.daily_scan_limit': { $gt: 0 } })
    .project({ _id: 1, organization_id: 1, features: 1 })
    .toArray();
  return subscriptions
    .map((sub: any) => ({
      subscriptionId: String(sub._id),
      organizationId: String(sub.organization_id),
      value: (sub.features ?? []).reduce(
        (max: number, feature: any) =>
          feature?.features_name === 'scan'
            ? Math.max(max, Number(feature?.daily_scan_limit) || 0)
            : max,
        0,
      ),
    }))
    .filter((row) => row.value > 0);
};

const copyPlanValues = async (
  rows: { subscriptionId: string; organizationId: string; value: number }[],
  apply: boolean,
  mode: MigrationMode,
): Promise<number> => {
  let copied = 0;
  for (const row of rows) {
    const org = await Organization.findById(row.organizationId)
      .select('daily_scan_limit company_name')
      .lean();
    if (!org) {
      log(
        mode,
        `  ! subscription ${row.subscriptionId} references missing organization ${row.organizationId}; skipped`,
      );
      continue;
    }
    const current = Number((org as any).daily_scan_limit ?? 0) || 0;
    if (current > 0) {
      log(
        mode,
        `  = ${row.organizationId} already has ${current}/day; kept it (subscription value ${row.value})`,
      );
      continue;
    }
    if (!apply) {
      log(mode, `  + would set ${row.organizationId} to ${row.value}/day`);
      copied += 1;
      continue;
    }
    const result = await Organization.collection.updateOne(
      {
        _id: org._id,
        $or: [
          { daily_scan_limit: { $exists: false } },
          { daily_scan_limit: { $in: [0, null] } },
        ],
      },
      { $set: { daily_scan_limit: row.value } },
    );
    if (result.modifiedCount) {
      log(mode, `  + set ${row.organizationId} to ${row.value}/day`);
      copied += 1;
    } else {
      log(
        mode,
        `  = ${row.organizationId} changed concurrently; left untouched`,
      );
    }
  }
  return copied;
};

export const collectBackupDocs = async (): Promise<Record<string, unknown>> => {
  const users = await User.collection
    .find({ daily_scan_limit: { $exists: true } })
    .toArray();
  const plans = await Plan.collection
    .find({ 'features.daily_scan_limit': { $exists: true } })
    .toArray();
  const subscriptions = await Subscription.collection
    .find({ 'features.daily_scan_limit': { $exists: true } })
    .toArray();
  return { users, plans, subscriptions };
};

export const writeBackup = async (
  data: Record<string, unknown>,
  backupDir?: string,
): Promise<string> => {
  const dir = backupDir
    ? path.resolve(backupDir)
    : process.env.DAILY_LIMIT_BACKUP_DIR
      ? path.resolve(process.env.DAILY_LIMIT_BACKUP_DIR)
      : path.resolve('backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `daily-limit-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
};

const cleanup = async (
  mode: MigrationMode,
): Promise<NonNullable<DailyLimitMigrationResult['cleanup']>> => {
  const users = await User.collection.updateMany(
    { daily_scan_limit: { $exists: true } },
    { $unset: { daily_scan_limit: '' } },
  );
  const plans = await Plan.collection.updateMany(
    { 'features.daily_scan_limit': { $exists: true } },
    { $unset: { 'features.$[].daily_scan_limit': '' } },
  );
  const subs = await Subscription.collection.updateMany(
    { 'features.daily_scan_limit': { $exists: true } },
    { $unset: { 'features.$[].daily_scan_limit': '' } },
  );
  const orgDefaults = await Organization.collection.updateMany(
    { daily_scan_limit: { $exists: false } },
    { $set: { daily_scan_limit: 0 } },
  );
  const result = {
    users: users.modifiedCount,
    plans: plans.modifiedCount,
    subscriptions: subs.modifiedCount,
    organizations_defaulted: orgDefaults.modifiedCount,
  };
  log(
    mode,
    `cleanup removed fields from ${result.users} user(s), ${result.plans} plan(s), ${result.subscriptions} subscription(s); defaulted ${result.organizations_defaulted} organization(s) to 0`,
  );
  return result;
};

/**
 * Runs the migration against the current Mongoose connection. The caller owns
 * the connection lifecycle (the CLI wrapper below connects and disconnects).
 */
export const runDailyLimitMigration = async (
  options: DailyLimitMigrationOptions = {},
): Promise<DailyLimitMigrationResult> => {
  const apply = options.apply === true;
  const mode: MigrationMode = apply ? 'apply' : 'dry-run';

  const operatorCaps = await listOperatorCaps();
  const planValues = await listPlanLevelValues();
  const subscriptionValues = await listSubscriptionValues();

  report(mode, 'operator caps (listed, NOT converted)', operatorCaps);
  report(mode, 'plan-level daily values (to be removed)', planValues);
  report(
    mode,
    'subscription-level daily values (to be removed)',
    subscriptionValues,
  );

  const toCopy = await planValuesToCopy();
  log(
    mode,
    `active subscriptions with a daily value to copy: ${toCopy.length}`,
  );
  const copied = await copyPlanValues(toCopy, apply, mode);
  log(
    mode,
    `organizations ${apply ? 'updated' : 'that would be updated'}: ${copied}`,
  );

  if (!apply) {
    log(
      mode,
      'dry run only: no write was performed. Re-run with --apply to apply.',
    );
    return {
      mode,
      operator_caps: operatorCaps,
      plan_level_values: planValues,
      subscription_level_values: subscriptionValues,
      to_copy: toCopy.length,
      copied,
      backup_file: null,
      cleanup: null,
    };
  }

  const backupFile = await writeBackup(
    {
      generated_at: new Date().toISOString(),
      operator_caps: operatorCaps,
      plan_level_values: planValues,
      subscription_level_values: subscriptionValues,
      copied,
      documents: await collectBackupDocs(),
    },
    options.backupDir,
  );
  log(mode, `backup written to ${backupFile}`);
  const cleanupResult = await cleanup(mode);

  return {
    mode,
    operator_caps: operatorCaps,
    plan_level_values: planValues,
    subscription_level_values: subscriptionValues,
    to_copy: toCopy.length,
    copied,
    backup_file: backupFile,
    cleanup: cleanupResult,
  };
};

const runCli = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const mode: MigrationMode = apply ? 'apply' : 'dry-run';
  await mongoose.connect(config.mongoose.url);
  log(mode, 'connected.');
  await runDailyLimitMigration({ apply });
  await mongoose.disconnect();
  log(mode, 'done.');
};

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  return !!entry && import.meta.url === pathToFileURL(path.resolve(entry)).href;
};

if (isDirectRun()) {
  runCli().catch(async (err) => {
    console.error(`[MIGRATE] failed:`, err);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}
