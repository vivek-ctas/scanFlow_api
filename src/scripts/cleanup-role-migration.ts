import mongoose from 'mongoose';
import config from '../config/config.js';
import { User } from '../models/user.model.js';
import { Organization } from '../models/organization.model.js';

const LEGACY_ROLES = ['USER_ADMIN', 'USER'];
const DEFAULT_ORG_NAME = 'Default Organization';

const mapLegacyRole = (role: string) =>
  role === 'USER_ADMIN' ? 'ORGANIZATION_ADMIN' : 'OPERATOR';

const execute = process.argv.includes('--execute');

const report = async () => {
  const total = await User.countDocuments();
  const roleBreakdown: Record<string, number> = {};
  for (const role of await User.distinct('role')) {
    roleBreakdown[role] = await User.countDocuments({ role });
  }
  const byStatus2 = await User.countDocuments({ status: 2 });
  const legacy = (await User.find(
    { role: { $in: LEGACY_ROLES } },
    {
      email: 1,
      role: 1,
      is_sub_user: 1,
      parent_id: 1,
      organizationId: 1,
      status: 1,
    },
  ).lean()) as any[];
  const withSubField = await User.countDocuments({ is_sub_user: true });
  const withParentId = await User.countDocuments({
    parent_id: { $ne: null },
  });

  console.log('\n=== PRE-CHANGE REPORT ===');
  console.log(`Total users: ${total}`);
  console.log('Role breakdown (counted):');
  for (const role of Object.keys(roleBreakdown)) {
    console.log(`  ${role}: ${await User.countDocuments({ role })}`);
  }
  console.log(`Status 2 (soft-deleted): ${byStatus2}`);
  console.log(`is_sub_user = true: ${withSubField}`);
  console.log(`parent_id set: ${withParentId}`);
  console.log('\nLegacy-role accounts:');
  legacy.forEach((u) =>
    console.log(
      `  ${u.role} | status=${u.status} | sub=${u.is_sub_user} | parent=${u.parent_id ? String(u.parent_id) : 'null'} | org=${u.organizationId ? String(u.organizationId) : 'null'} | ${u.email}`,
    ),
  );
  console.log(
    `\nLegacy accounts still active (status 0/1): ${legacy.filter((u) => u.status !== 2).length}`,
  );
  console.log('=================================\n');
};

console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`);
try {
  await mongoose.connect(config.mongoose.url!);
  console.log(`Connected to ${config.mongoose.url}`);

  await report();

  if (!execute) {
    console.log('DRY-RUN complete — pass --execute to apply.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // 1. Delete soft-deleted (status 2) legacy accounts outright.
  const deleted = await User.deleteMany({
    status: 2,
    role: { $in: LEGACY_ROLES },
  });
  console.log(`Deleted soft-deleted legacy accounts: ${deleted.deletedCount}`);

  // 2. Create (or reuse) one controlled Default Organization.
  let defaultOrg = await Organization.findOne({ name: DEFAULT_ORG_NAME });
  if (!defaultOrg) {
    defaultOrg = await Organization.create({
      name: DEFAULT_ORG_NAME,
      email: 'default@scanflow.com',
      contactNumber: '',
      status: 1,
      scanQuota: { limit: 0, period: 'monthly', periodStart: new Date() },
      created_by: null,
    });
    console.log(`Created Default Organization: ${defaultOrg._id}`);
  } else {
    console.log(`Reusing existing Default Organization: ${defaultOrg._id}`);
  }

  // 3. Reassign every remaining legacy-role account into the Default Org
  //    (vivek is reactivated as ORGANIZATION_ADMIN; logtest as OPERATOR).
  const remainingLegacy = await User.find({
    role: { $in: LEGACY_ROLES },
  }).lean();
  let reassigned = 0;
  for (const user of remainingLegacy) {
    const patch: Record<string, any> = {
      role: mapLegacyRole(user.role as string),
      organizationId: defaultOrg._id,
    };
    if (user.status === 0) {
      patch.status = 1; // reactivate the two status-0 dev test accounts
    }
    await User.updateOne(
      { _id: user._id },
      { $set: patch, $unset: { is_sub_user: '', parent_id: '' } },
    );
    reassigned += 1;
    console.log(
      `Reassigned ${user.email}: ${user.role} -> ${patch.role} (org=${defaultOrg._id}, status=${patch.status ?? user.status})`,
    );
  }
  console.log(`Reassigned accounts: ${reassigned}`);

  // 4. Drop the now-unused legacy fields from every remaining document.
  //    Mongoose casts `$unset` of paths absent from the schema away, so use
  //    the raw driver to physically remove the fields.
  const unset = await mongoose.connection
    .db!.collection('tbl_users')
    .updateMany({}, { $unset: { is_sub_user: '', parent_id: '' } });
  console.log(`Unset legacy fields on: ${unset.modifiedCount}`);

  // 5. Verify.
  const finalRoles: Record<string, number> = {};
  for (const role of await User.distinct('role')) {
    finalRoles[role] = await User.countDocuments({ role });
  }
  const stillLegacy = await User.countDocuments({
    role: { $in: LEGACY_ROLES },
  });
  const subLeft = await User.countDocuments({ is_sub_user: true });
  const parentLeft = await User.countDocuments({ parent_id: { $ne: null } });
  const stillCarrying = await mongoose.connection
    .db!.collection('tbl_users')
    .countDocuments({
      $or: [
        { is_sub_user: { $exists: true } },
        { parent_id: { $exists: true } },
      ],
    });

  console.log('\n=== POST-CHANGE REPORT ===');
  console.log('Final role breakdown:', JSON.stringify(finalRoles));
  console.log(`Remaining legacy-role docs: ${stillLegacy}`);
  console.log(`Remaining is_sub_user = true: ${subLeft}`);
  console.log(`Remaining parent_id set: ${parentLeft}`);
  console.log(`Documents still carrying legacy fields: ${stillCarrying}`);
  console.log('=================================\n');
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
