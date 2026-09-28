import mongoose from 'mongoose';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { User } from '../models/user.model.js';
import { normalizeEmail } from '../services/common.service.js';
import { SUPER_ADMIN_ROLE } from '../config/roles.js';

const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL as string | undefined;
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD as
  string | undefined;

const run = async () => {
  if (!SEED_ADMIN_EMAIL) {
    logger.error(
      '[SEED] SEED_ADMIN_EMAIL is required (e.g. SEED_ADMIN_EMAIL=dev@scanflow.com)',
    );
    process.exit(1);
  }
  if (!SEED_ADMIN_PASSWORD) {
    logger.error(
      '[SEED] SEED_ADMIN_PASSWORD is required — refusing to create a super admin without an explicit password.',
    );
    process.exit(1);
  }

  await mongoose.connect(config.mongoose.url);
  logger.info(`Connected to ${config.mongoose.url}`);

  const email = normalizeEmail(SEED_ADMIN_EMAIL);
  const existing = await User.findOne({ email });
  if (existing) {
    logger.info(`[SEED] Super admin already exists (${email}) — no-op.`);
    await mongoose.disconnect();
    return;
  }

  await User.create({
    first_name: 'Super',
    last_name: 'Admin',
    email,
    password: SEED_ADMIN_PASSWORD,
    role: SUPER_ADMIN_ROLE,
    is_super_admin: true,
    is_email_verified: true,
    status: 1,
  });
  logger.info(`[SEED] Super admin created: ${email}`);
  await mongoose.disconnect();
};

run().catch((err) => {
  logger.error(`[SEED] failed: ${err.message}`);
  process.exit(1);
});
