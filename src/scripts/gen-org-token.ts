import mongoose from 'mongoose';
import config from '../config/config.js';
import { User } from '../models/user.model.js';
import moment from 'moment';
import jwt from 'jsonwebtoken';
import { tokenTypes } from '../config/tokens.js';

async function main() {
  await mongoose.connect(config.mongoose.url);

  const user = await User.findOne({
    email: 'vivek.ctasis.llp@gmail.com',
  }).lean();
  if (!user) {
    console.log('Org user not found');
    process.exit(1);
  }

  const accessTokenExpires = moment().add(
    config.jwt.accessExpirationMinutes,
    'minutes',
  );
  const accessToken = jwt.sign(
    {
      sub: String(user._id),
      iat: moment().unix(),
      exp: accessTokenExpires.unix(),
      type: tokenTypes.ACCESS,
    },
    config.jwt.secret,
  );
  console.log(accessToken);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
