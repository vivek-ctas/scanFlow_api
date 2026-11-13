import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { Organization } from '../src/models/organization.model.js';
import { Plan } from '../src/models/plan.model.js';
import { Subscription } from '../src/models/subscription.model.js';
import { User } from '../src/models/user.model.js';
import { createOrg } from './helpers.js';
import { runDailyLimitMigration } from '../src/scripts/migrate-daily-limit-to-organization.js';

const backupDir = (): string =>
  fs.mkdtempSync(path.join('/tmp/opencode', 'daily-limit-migration-'));

const legacySubscription = async (
  organizationId: string,
  dailyLimit: number,
): Promise<void> => {
  await Subscription.collection.insertOne({
    organization_id: new mongoose.Types.ObjectId(organizationId),
    plan_name: 'Legacy Plan',
    status: 'active',
    started_at: new Date('2026-01-01T00:00:00.000Z'),
    expires_at: new Date('2026-01-31T00:00:00.000Z'),
    features: [
      {
        features_name: 'scan',
        scan_limit: 1000,
        daily_scan_limit: dailyLimit,
      },
    ],
  });
};

const legacyPlan = async (dailyLimit: number): Promise<void> => {
  await Plan.collection.insertOne({
    name: 'Legacy Plan',
    status: 1,
    features: [
      {
        features_name: 'scan',
        scan_limit: 1000,
        daily_scan_limit: dailyLimit,
      },
    ],
  });
};

const legacyUserCap = async (dailyLimit: number): Promise<void> => {
  await User.collection.insertOne({
    first_name: 'Legacy',
    last_name: 'Operator',
    email: `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    role: 'OPERATOR',
    status: 1,
    daily_scan_limit: dailyLimit,
  });
};

describe('daily limit migration to organization', () => {
  it('dry run reports and copies nothing', async () => {
    const org = await createOrg();
    await legacySubscription(String(org._id), 120);
    await legacyPlan(90);
    await legacyUserCap(7);
    const dir = backupDir();

    const result = await runDailyLimitMigration({ apply: false, backupDir: dir });

    expect(result.mode).toBe('dry-run');
    expect(result.operator_caps).toHaveLength(1);
    expect(result.plan_level_values).toHaveLength(1);
    expect(result.subscription_level_values).toHaveLength(1);
    expect(result.to_copy).toBe(1);
    expect(result.copied).toBe(1);
    expect(result.backup_file).toBeNull();
    expect(result.cleanup).toBeNull();

    const fresh = await Organization.findById(org._id).lean();
    expect(Number(fresh?.daily_scan_limit)).toBe(0);

    const user = await User.collection.findOne({ daily_scan_limit: 7 });
    expect(user).not.toBeNull();
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('apply copies active subscription values, backs up and cleans up', async () => {
    const org = await createOrg();
    const existingOrg = await createOrg({ daily_scan_limit: 55 });
    await legacySubscription(String(org._id), 120);
    await legacySubscription(String(existingOrg._id), 120);
    await legacyPlan(90);
    await legacyUserCap(7);
    const missingField = await Organization.collection.insertOne({
      company_name: 'No Field Org',
      status: 1,
    });
    const dir = backupDir();

    const result = await runDailyLimitMigration({ apply: true, backupDir: dir });

    expect(result.mode).toBe('apply');
    expect(result.copied).toBe(1);
    expect(result.backup_file).toBeTruthy();
    expect(fs.existsSync(result.backup_file as string)).toBe(true);

    const backup = JSON.parse(fs.readFileSync(result.backup_file as string, 'utf8'));
    expect(backup.documents.users).toHaveLength(1);
    expect(backup.documents.plans).toHaveLength(1);
    expect(backup.documents.subscriptions).toHaveLength(2);

    const copiedOrg = await Organization.findById(org._id).lean();
    const keptOrg = await Organization.findById(existingOrg._id).lean();
    const defaultedOrg = await Organization.collection.findOne({
      _id: missingField.insertedId,
    });
    expect(Number(copiedOrg?.daily_scan_limit)).toBe(120);
    expect(Number(keptOrg?.daily_scan_limit)).toBe(55);
    expect(Number(defaultedOrg?.daily_scan_limit)).toBe(0);

    expect(await User.collection.findOne({ daily_scan_limit: { $exists: true } })).toBeNull();
    expect(
      await Plan.collection.findOne({ 'features.daily_scan_limit': { $exists: true } }),
    ).toBeNull();
    expect(
      await Subscription.collection.findOne({
        'features.daily_scan_limit': { $exists: true },
      }),
    ).toBeNull();

    expect(result.cleanup?.users).toBe(1);
    expect(result.cleanup?.plans).toBe(1);
    expect(result.cleanup?.subscriptions).toBe(2);
    expect(result.cleanup?.organizations_defaulted).toBe(1);
  });

  it('is idempotent on a second apply', async () => {
    const org = await createOrg();
    await legacySubscription(String(org._id), 120);
    await legacyUserCap(7);
    const dir = backupDir();

    await runDailyLimitMigration({ apply: true, backupDir: dir });
    const second = await runDailyLimitMigration({ apply: true, backupDir: dir });

    expect(second.operator_caps).toHaveLength(0);
    expect(second.plan_level_values).toHaveLength(0);
    expect(second.subscription_level_values).toHaveLength(0);
    expect(second.to_copy).toBe(0);
    expect(second.copied).toBe(0);

    const fresh = await Organization.findById(org._id).lean();
    expect(Number(fresh?.daily_scan_limit)).toBe(120);
  });
});
