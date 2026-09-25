import mongoose from 'mongoose';

const MONGODB_URL =
  process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/db_scanflow';

await mongoose.connect(MONGODB_URL);

const users = mongoose.connection.collection('tbl_users');

// Decouple account-type from role: a "sub-user" is only ever a user that
// has a parent_id. Any row flagged is_sub_user without a parent is invalid
// (previously derived from role === 'USER') and becomes a normal account.
const fixed = await users.updateMany(
  { is_sub_user: true, parent_id: { $in: [null, undefined] } },
  { $set: { is_sub_user: false } },
);
console.log(
  `Fixed ${fixed.modifiedCount} rows: is_sub_user -> false (no parent_id).`,
);

// Cross-check: sub-users must keep is_sub_user true.
const orphans = await users.countDocuments({
  is_sub_user: false,
  parent_id: { $nin: [null, undefined] },
});
console.log(`Sub-users with parent but is_sub_user=false: ${orphans}`);

const after = await users
  .find(
    {},
    {
      projection: {
        email: 1,
        role: 1,
        is_sub_user: 1,
        parent_id: 1,
        status: 1,
      },
    },
  )
  .toArray();
console.log(JSON.stringify(after, null, 2));

await mongoose.disconnect();
