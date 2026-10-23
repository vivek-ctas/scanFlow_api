import mongoose from 'mongoose';
import moment from 'moment';
import config from '../src/config/config.js';
import { generateToken } from '../src/services/token.service.js';
import { tokenTypes } from '../src/config/tokens.js';
import { User } from '../src/models/user.model.js';

(async () => {
  await mongoose.connect(config.mongoose.url);
  const user = await User.findOne({ role: 'SUPER_ADMIN' });
  if (!user) { console.log('NO SUPER_ADMIN'); process.exit(1); }
  const token = generateToken(user.id, moment().add(120, 'minutes'), tokenTypes.ACCESS);
  console.log(JSON.stringify({ id: user.id, email: user.email, role: user.role, token }));
  await mongoose.disconnect();
  process.exit(0);
})();
