import mongoose from 'mongoose';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { Organization } from '../models/organization.model.js';
import { User } from '../models/user.model.js';
import { Plan } from '../models/plan.model.js';
import { Usage } from '../models/usage.model.js';
import { Scan } from '../models/scan.model.js';
import { WebhookConfig } from '../models/webhook-config.model.js';
import { WebhookDelivery } from '../models/webhook-delivery.model.js';
import { SUPER_ADMIN_ROLE } from '../config/roles.js';
import { grantSubscription } from '../services/subscription.service.js';
import { writeActiveSubscriptionCache } from '../services/quota.service.js';
import { scanLimitOf } from '../utils/plan-features.util.js';

const COMMON_PASSWORD = 'Scanflow@123';

const PLAN_SEED = [
  {
    name: 'Starter',
    desc: 'For small shops getting started with scan capture.',
    price: 1499,
    price_quarterly: 3999,
    currency: 'inr',
    trial_days: 14,
    scan_limit: 500,
    marketing_features: [
      '500 scans / billing cycle',
      'Unlimited operators',
      'Webhook integrations',
      'Email support',
    ],
    is_popular: false,
    discount: 0,
  },
  {
    name: 'Growth',
    desc: 'For growing retail teams with steady scan volume.',
    price: 2999,
    price_quarterly: 7999,
    currency: 'inr',
    trial_days: 14,
    scan_limit: 2000,
    marketing_features: [
      '2,000 scans / billing cycle',
      'Unlimited operators',
      'Webhook integrations',
      'Priority support',
    ],
    is_popular: true,
    discount: 0,
  },
  {
    name: 'Pro',
    desc: 'For multi-branch businesses with heavy scan usage.',
    price: 5999,
    price_quarterly: 15999,
    currency: 'inr',
    trial_days: 0,
    scan_limit: 10000,
    marketing_features: [
      '10,000 scans / billing cycle',
      'Unlimited operators',
      'Webhook integrations',
      'Dedicated support',
    ],
    is_popular: false,
    discount: 0,
  },
  {
    name: 'Enterprise',
    desc: 'Custom volume and SLA-backed support.',
    price: 14999,
    price_quarterly: 39999,
    currency: 'inr',
    trial_days: 0,
    scan_limit: 50000,
    marketing_features: [
      '50,000 scans / billing cycle',
      'Unlimited operators',
      'Webhook integrations',
      'SLA-backed support',
    ],
    is_popular: false,
    discount: 0,
  },
];

interface OrgSeed {
  name: string;
  email: string;
  contact_number: string;
  plan: string;
  billing_cycle: 'month' | 'quarterly';
  trial_days: number;
  used: number;
  admin: { first_name: string; last_name: string; email: string };
  operators: {
    first_name: string;
    last_name: string;
    email: string;
    status?: number;
  }[];
  webhook_enabled: boolean;
}

const ORG_SEED: OrgSeed[] = [
  {
    name: 'Acme Retail Pvt Ltd',
    email: 'billing@acme.scanflowapp.com',
    contact_number: '+91 98200 12345',
    plan: 'Growth',
    billing_cycle: 'month',
    trial_days: 0,
    used: 87,
    admin: {
      first_name: 'Riya',
      last_name: 'Shah',
      email: 'admin@acme.scanflowapp.com',
    },
    operators: [
      {
        first_name: 'Arjun',
        last_name: 'Patel',
        email: 'arjun@acme.scanflowapp.com',
      },
      {
        first_name: 'Meera',
        last_name: 'Joshi',
        email: 'meera@acme.scanflowapp.com',
      },
      {
        first_name: 'Karan',
        last_name: 'Desai',
        email: 'karan@acme.scanflowapp.com',
        status: 0,
      },
      {
        first_name: 'Sneha',
        last_name: 'Iyer',
        email: 'sneha@acme.scanflowapp.com',
      },
    ],
    webhook_enabled: true,
  },
  {
    name: 'Globex Mart',
    email: 'partner@globex.scanflowapp.com',
    contact_number: '+91 99303 98765',
    plan: 'Pro',
    billing_cycle: 'quarterly',
    trial_days: 0,
    used: 342,
    admin: {
      first_name: 'Vikram',
      last_name: 'Nair',
      email: 'admin@globex.scanflowapp.com',
    },
    operators: [
      {
        first_name: 'Divya',
        last_name: 'Menon',
        email: 'divya@globex.scanflowapp.com',
      },
      {
        first_name: 'Rahul',
        last_name: 'Kulkarni',
        email: 'rahul@globex.scanflowapp.com',
      },
    ],
    webhook_enabled: true,
  },
  {
    name: 'Umbrella Corner Store',
    email: 'hello@umbrella.scanflowapp.com',
    contact_number: '+91 90990 45678',
    plan: 'Starter',
    billing_cycle: 'month',
    trial_days: 14,
    used: 12,
    admin: {
      first_name: 'Tara',
      last_name: 'Bose',
      email: 'admin@umbrella.scanflowapp.com',
    },
    operators: [
      {
        first_name: 'Nikhil',
        last_name: 'Ghosh',
        email: 'nikhil@umbrella.scanflowapp.com',
      },
    ],
    webhook_enabled: false,
  },
  {
    name: 'Wonka Distribution Co',
    email: 'ops@wonka.scanflowapp.com',
    contact_number: '+91 90044 11223',
    plan: '',
    billing_cycle: 'month',
    trial_days: 0,
    used: 0,
    admin: {
      first_name: 'Ojas',
      last_name: 'Saxena',
      email: 'admin@wonka.scanflowapp.com',
    },
    operators: [],
    webhook_enabled: false,
  },
];

const isLocalMongoUrl = (url: string): boolean =>
  /localhost|127\.0\.0\.1/i.test(String(url).split('?')[0] ?? '');

const makeBarcode = (seed: number, index: number): string =>
  `890${String((seed * 7919 + index) % 9999999999).padStart(10, '0')}`;

const BARCODE_TYPES = ['ean13', 'code128', 'qrcode', 'upca'];

const randomOffset = (spanMs: number): number =>
  Math.floor(Math.random() * Math.max(1, spanMs));

const run = async () => {
  if (!isLocalMongoUrl(config.mongoose.url)) {
    logger.error(
      `[SEED] Refusing to wipe non-local database: ${config.mongoose.url}`,
    );
    process.exit(1);
  }

  await mongoose.connect(config.mongoose.url);
  logger.info(`Connected to ${config.mongoose.url}`);

  await mongoose.connection.dropDatabase();
  logger.info('[SEED] Database dropped — starting fresh seed.');

  const plans: { [name: string]: any } = {};
  for (const p of PLAN_SEED) {
    const doc = await Plan.create({
      name: p.name,
      desc: p.desc,
      price: p.price,
      price_quarterly: p.price_quarterly,
      currency: p.currency,
      trial_days: p.trial_days,
      features: [{ features_name: 'scan', scan_limit: p.scan_limit }],
      marketing_features: p.marketing_features,
      status: 1,
      is_custom_plan: false,
      is_popular: p.is_popular,
      discount: p.discount,
    });
    plans[p.name] = doc;
    logger.info(`[SEED] Plan "${p.name}" -> ${doc._id}`);
  }

  const superAdmin = await User.create({
    first_name: 'Super',
    last_name: 'Admin',
    email: 'dev@scanflow.com',
    password: 'Admin@1234',
    role: SUPER_ADMIN_ROLE,
    is_super_admin: true,
    is_email_verified: true,
    status: 1,
  });
  logger.info(
    `[SEED] Super admin -> ${superAdmin._id} (dev@scanflow.com / Admin@1234)`,
  );

  // Insert multiple organizations at once, then track the created docs by name.
  const orgDocs = await Organization.insertMany(
    ORG_SEED.map((o) => ({
      name: o.name,
      email: o.email,
      contact_number: o.contact_number,
      status: 1,
    })),
  );
  const orgBySeed: { [name: string]: any } = {};
  ORG_SEED.forEach((o, i) => {
    orgBySeed[o.name] = orgDocs[i];
    logger.info(`[SEED] Organization "${o.name}" -> ${orgDocs[i]?._id}`);
  });

  for (const orgSeed of ORG_SEED) {
    const org = orgBySeed[orgSeed.name];

    await User.create({
      first_name: orgSeed.admin.first_name,
      last_name: orgSeed.admin.last_name,
      email: orgSeed.admin.email,
      password: COMMON_PASSWORD,
      role: 'ORGANIZATION_ADMIN',
      organization_id: org._id,
      is_super_admin: false,
      is_email_verified: true,
      status: 1,
    });

    for (const op of orgSeed.operators) {
      await User.create({
        first_name: op.first_name,
        last_name: op.last_name,
        email: op.email,
        password: COMMON_PASSWORD,
        role: 'OPERATOR',
        organization_id: org._id,
        is_super_admin: false,
        is_email_verified: op.status === 0 ? false : true,
        status: op.status ?? 1,
      });
    }
  }
  logger.info('[SEED] Organization admins + operators created.');

  const assignedSubs: any[] = [];
  for (const orgSeed of ORG_SEED) {
    if (!orgSeed.plan) continue;
    const org = orgBySeed[orgSeed.name];
    const sub = await grantSubscription(
      String(org._id),
      String(plans[orgSeed.plan]._id),
      {
        trialDays: orgSeed.trial_days,
        billingCycle: orgSeed.billing_cycle,
        forceActive: true,
      },
    );
    assignedSubs.push({ orgSeed, org, sub });
    logger.info(
      `[SEED] "${orgSeed.name}" <- plan "${orgSeed.plan}" (${orgSeed.billing_cycle}${orgSeed.trial_days ? `, trial ${orgSeed.trial_days}d` : ''})`,
    );
  }

  for (const orgSeed of ORG_SEED) {
    const org = orgBySeed[orgSeed.name];
    if (!orgSeed.webhook_enabled) continue;
    const wc = await WebhookConfig.create({
      organization_id: org._id,
      endpoint_url: `https://webhook.example.com/scan/${orgSeed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      secret: 'whsec_demo_local_secret',
      enabled: true,
      timeout_ms: 5000,
      batch_size: 100,
      retry_limit: 3,
    });
    logger.info(`[SEED] Webhook config for "${orgSeed.name}" -> ${wc._id}`);
  }

  const usersByOrg: { [orgName: string]: any[] } = {};
  for (const orgSeed of ORG_SEED) {
    const org = orgBySeed[orgSeed.name];
    const orgUsers = await User.find({ organization_id: org._id });
    const operators = orgUsers.filter((u) => u.role === 'OPERATOR');
    const admins = orgUsers.filter((u) => u.role === 'ORGANIZATION_ADMIN');
    const all = [...admins, ...operators];
    usersByOrg[orgSeed.name] = all;
    logger.info(
      `[SEED] "${orgSeed.name}": ${admins.length} admin(s), ${operators.length} operator(s)`,
    );
  }

  const deliveryCandidates: any[] = [];
  for (const { orgSeed, org, sub } of assignedSubs) {
    const orgUsers = usersByOrg[orgSeed.name] ?? [];
    const scanLimit = scanLimitOf(sub.features);
    const now = Date.now();
    const startMs = new Date(sub.started_at).getTime();
    const spanMs = Math.max(1, now - startMs);
    const scanDocs: any[] = [];
    const seed = org.name.length * 13 + orgSeed.used;

    const scanForUser = (index: number) => {
      const operatorPool = orgUsers.filter((u) => u.role === 'OPERATOR');
      if (operatorPool.length === 0)
        return orgUsers[index % orgUsers.length]._id;
      return operatorPool[index % operatorPool.length]._id;
    };

    for (let i = 0; i < orgSeed.used; i += 1) {
      let scanned_at: Date;
      if (i >= orgSeed.used - 8) {
        scanned_at = new Date(now - (orgSeed.used - i) * 45 * 60 * 1000);
      } else {
        scanned_at = new Date(startMs + randomOffset(spanMs));
      }
      scanDocs.push({
        organization_id: org._id,
        user_id: scanForUser(i),
        device_id: `handheld-${(i % 3) + 1}`,
        client_scan_id: `cs-${orgSeed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`,
        barcode: makeBarcode(seed, i),
        barcode_type: BARCODE_TYPES[i % BARCODE_TYPES.length],
        scanned_at,
      });
    }

    const scans = await Scan.insertMany(scanDocs);
    logger.info(
      `[SEED] "${orgSeed.name}": ${scans.length} scans (limit ${scanLimit})`,
    );

    await Usage.updateOne(
      { organization_id: org._id, subscription_id: sub._id },
      {
        $set: {
          usage: orgSeed.used,
          is_exhausted: scanLimit !== 0 && orgSeed.used >= scanLimit,
          last_used_at: scans.length
            ? (scans[scans.length - 1]?.scanned_at ?? null)
            : null,
        },
      },
    );
    await writeActiveSubscriptionCache(
      String(org._id),
      scanLimit,
      sub.expires_at,
      false,
      orgSeed.used,
    );

    if (orgSeed.webhook_enabled) {
      const tail = scans.slice(-12);
      tail.forEach((scan, i) => {
        const remainder = i % 6;
        const status =
          remainder === 4
            ? 'pending'
            : remainder === 5
              ? 'failed'
              : 'delivered';
        deliveryCandidates.push({
          scan,
          status,
          retry_count: status === 'failed' ? 3 : 0,
        });
      });
    }
  }

  const deliveryDocs = deliveryCandidates.map((c, index) => ({
    event_id: `evt-${(index + 1).toString().padStart(6, '0')}`,
    scan_id: c.scan._id,
    organization_id: c.scan.organization_id,
    retry_count: c.retry_count,
    status: c.status,
    last_attempt_at: c.status === 'pending' ? undefined : c.scan.scanned_at,
    delivered_at: c.status === 'delivered' ? c.scan.scanned_at : undefined,
    last_error:
      c.status === 'failed' ? 'Request timed out after 5000ms' : undefined,
  }));
  await WebhookDelivery.insertMany(deliveryDocs);
  logger.info(`[SEED] ${deliveryDocs.length} webhook deliveries created.`);

  const counts: Record<string, number> = {};
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('No active database connection');
  }
  const collections = await db.listCollections().toArray();
  for (const collection of collections) {
    counts[collection.name] = await db
      .collection(collection.name)
      .countDocuments();
  }

  logger.info('[SEED] Done. Collection counts:');
  Object.entries(counts).forEach(([name, count]) => {
    logger.info(`  ${name}: ${count}`);
  });

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (err) => {
  logger.error(`[SEED] failed: ${err.stack || err.message}`);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect errors after a failed seed
  }
  process.exit(1);
});
