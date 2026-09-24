import mongoose from 'mongoose';

const MONGODB_URL =
  process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/db_scanflow';

await mongoose.connect(MONGODB_URL);

const users = mongoose.connection.collection('tbl_users');

await users.updateMany(
  { is_seller_user: { $exists: true } },
  [
    { $set: { is_sub_user: '$is_seller_user' } },
    { $unset: ['is_seller_user'] },
  ],
);
await users.updateMany(
  { seller_id: { $exists: true } },
  [{ $set: { parent_id: '$seller_id' } }, { $unset: ['seller_id'] }],
);
await users.updateMany(
  { role: 'SELLER_ADMIN' },
  { $set: { role: 'USER_ADMIN' } },
);
await users.updateMany(
  { role: 'SELLER_USER' },
  { $set: { role: 'USER' } },
);

const after = await users
  .find({}, { projection: { email: 1, role: 1, is_sub_user: 1, parent_id: 1 } })
  .toArray();
console.log(JSON.stringify(after, null, 2));

await mongoose.disconnect();