import mongoose from 'mongoose';
import config from '../config/config.js';
import { User } from '../models/user.model.js';

async function main() {
  await mongoose.connect(config.mongoose.url);
  const users = await User.find({ role: 'OPERATOR' })
    .select('email operator_id')
    .lean();
  console.log(users);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
