/**
 * Seed the starter FAQ drafts (plan §8.7). Every entry is created as
 * **unpublished** (status 0) so the owner can review the wording before it
 * reaches customers. Re-running upserts by question, never duplicates.
 *
 * Run: npm run seed:faqs
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { Faq } from '../models/support-faq.model.js';

type SeedFaq = {
  question: string;
  answer: string;
  category:
    | 'scanner'
    | 'account_login'
    | 'subscription_quota'
    | 'webhook'
    | 'bug'
    | 'other';
  keywords: string[];
  sort_order: number;
};

const STARTER_FAQS: SeedFaq[] = [
  {
    question: 'The camera will not start',
    answer:
      'The scanner needs **HTTPS** (or `localhost`) and camera permission.\n\n1. Open ScanFlow in Chrome or Safari.\n2. Allow the camera when the browser asks.\n3. Close any other app or tab that is already using the camera.\n4. Reload the scanner page and try again.',
    category: 'scanner',
    keywords: ['camera', 'permission', 'https', 'scanner'],
    sort_order: 10,
  },
  {
    question: 'A barcode will not scan',
    answer:
      'Try these steps:\n\n- Fill the frame with the barcode and hold the phone steady.\n- Improve the lighting or use the torch.\n- If live scanning still fails, tap **Capture** to take a still photo.\n- Make sure the barcode is not damaged or covered.',
    category: 'scanner',
    keywords: ['barcode', 'scan', 'camera', 'capture'],
    sort_order: 20,
  },
  {
    question: 'What counts toward my scan limit?',
    answer:
      'Each accepted scan counts **once per billing period**.\n\n- Retrying the same scan does not count twice.\n- Scanning the same barcode again later, as a new scan, counts again.\n- Rejected or failed scans do not count.',
    category: 'subscription_quota',
    keywords: ['scan', 'limit', 'quota', 'billing'],
    sort_order: 30,
  },
  {
    question: 'What happens when I reach my scan limit?',
    answer:
      'New scans are rejected until your plan renews. **Unlimited** plans have no limit.\n\nIf you need more scans sooner, contact support and we will help you upgrade.',
    category: 'subscription_quota',
    keywords: ['scan', 'limit', 'renew', 'upgrade'],
    sort_order: 40,
  },
  {
    question: 'Why do my scans say queued or sending?',
    answer:
      'Scans saved while the device is offline are kept on the device and sent in batches. They are retried automatically when the connection returns.\n\nKeep the app open until they show as sent.',
    category: 'scanner',
    keywords: ['queued', 'sending', 'offline', 'sync'],
    sort_order: 50,
  },
  {
    question: 'How do I verify a webhook?',
    answer:
      'Each delivery includes an `x-scanflow-signature` header: an **HMAC-SHA256** of the raw request body using your webhook secret.\n\nThe body is `{ events: [...] }` and events are batched. Compare the signature in constant time before trusting the payload.',
    category: 'webhook',
    keywords: ['webhook', 'signature', 'hmac', 'verify'],
    sort_order: 60,
  },
  {
    question: 'My webhook shows failed or pending',
    answer:
      'Check that:\n\n1. Your endpoint is reachable from the internet.\n2. It returns a **2xx** response within the timeout.\n3. The signing secret matches the one shown in ScanFlow.\n\nFailed deliveries are retried up to the configured limit.',
    category: 'webhook',
    keywords: ['webhook', 'failed', 'pending', 'retry'],
    sort_order: 70,
  },
  {
    question: 'When does my plan expire or renew?',
    answer:
      'Your renewal date is shown on your dashboard. A queued next plan starts automatically when the current one ends.\n\nRenewals and plan changes are handled by ScanFlow support.',
    category: 'subscription_quota',
    keywords: ['plan', 'expire', 'renew', 'subscription'],
    sort_order: 80,
  },
  {
    question: 'How do I add or disable an operator?',
    answer:
      'Open **Customers → Operators**. From there you can add a new operator or disable an existing one. Disabled operators cannot sign in.',
    category: 'account_login',
    keywords: ['operator', 'user', 'add', 'disable'],
    sort_order: 90,
  },
  {
    question: 'I did not receive my login code',
    answer:
      'Check your spam folder and wait a minute, then request a new code.\n\nIf it still does not arrive, use the public **Contact** form — you cannot open a support ticket without being signed in.',
    category: 'account_login',
    keywords: ['login', 'code', 'otp', 'email'],
    sort_order: 100,
  },
];

const run = async () => {
  await mongoose.connect(config.mongoose.url);

  let created = 0;
  let existing = 0;

  for (const faq of STARTER_FAQS) {
    const found = await Faq.findOne({ question: faq.question });
    if (found) {
      existing += 1;
      continue;
    }
    await Faq.create({
      question: faq.question,
      answer: faq.answer,
      category: faq.category,
      audience: 'all',
      keywords: faq.keywords,
      status: 0,
      sort_order: faq.sort_order,
    });
    created += 1;
  }

  console.log(
    `[SEED-FAQ] complete created=${created} existing=${existing} total=${STARTER_FAQS.length} (all unpublished)`,
  );

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('[SEED-FAQ] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
