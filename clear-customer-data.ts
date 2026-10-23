import mongoose from 'mongoose';
import config from './src/config/config.js';

const SUPPORT_COLLECTIONS = [
  'tbl_support_ticket',
  'tbl_support_message',
  'tbl_faq',
];

async function clearSupportCollections() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(config.mongoose.url);
    console.log('Connected!');

    const db = mongoose.connection.db;
    
    for (const coll of SUPPORT_COLLECTIONS) {
      try {
        const result = await db.collection(coll).deleteMany({});
        console.log(`✓ Cleared ${coll}: ${result.deletedCount} documents deleted`);
      } catch (err) {
        console.log(`⚠ Could not clear ${coll}: ${err.message}`);
      }
    }

    console.log('\n✓ Support section collections cleared!');
    console.log('You can now start fresh with a clean support database.');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

clearSupportCollections();