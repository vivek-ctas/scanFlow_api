/**
 * One-time migration: plan currency `inr` -> `usd`.
 *
 * Plans were originally seeded and priced in whole rupees (1499, 2999, ...).
 * Moving the project to USD means those magnitudes have to be rescaled too, or
 * the plan becomes "$1499 / month". Amounts are therefore divided by 100
 * (rupees -> dollars) and rounded to 2dp, which maps the old seed onto
 * dollar-denominated prices: 1499 -> 14.99.
 *
 * A price below 100 is treated as already dollar-denominated and is left alone
 * but reported, since dividing it would be a different mistake.
 *
 * Scope is deliberately limited to `tbl_plan`. Payment and Subscription rows are
 * immutable financial records: each already snapshots its own `plan_price` and
 * `currency_code`, and rewriting historical charges is not something a currency
 * label change should do. Re-priced plans only affect future grants, which
 * snapshot from the plan at grant time.
 *
 * Safe to re-run: only plans whose currency is not already `usd` are touched.
 *
 * Run: npm run migrate:plan-currency-usd
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { Plan } from '../models/plan.model.js';

const FROM_CURRENCY = 'inr';
const TO_CURRENCY = 'usd';
const MIN_RUPEE_MAGNITUDE = 100;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const run = async () => {
  await mongoose.connect(config.mongoose.url);

  const planCol = Plan.collection;

  const totalPlans = await planCol.countDocuments({});
  const legacyPlans = await planCol
    .find({ currency: FROM_CURRENCY })
    .project({ name: 1, price: 1, price_quarterly: 1, billing_cycle: 1 })
    .toArray();

  console.log(
    `[MIGRATE] collection=${planCol.collectionName} plans=${totalPlans}, currency="${FROM_CURRENCY}"=${legacyPlans.length}`,
  );

  if (legacyPlans.length === 0) {
    console.log('[MIGRATE] nothing to do.');
    await mongoose.disconnect();
    return;
  }

  const skipped: string[] = [];

  for (const plan of legacyPlans) {
    const price = Number(plan.price);

    // Already a dollar-scale amount: converting the label alone is right, but
    // dividing would underprice the plan, so leave it and flag it.
    if (Math.abs(price) < MIN_RUPEE_MAGNITUDE) {
      skipped.push(`${plan.name} (price=${price})`);
      await planCol.updateOne(
        { _id: plan._id },
        { $set: { currency: TO_CURRENCY } },
      );
      continue;
    }

    const rescaledPrice = round2(price / 100);

    // Only a quarterly plan is ever charged from `price_quarterly`, and that
    // value is re-derived on every plan write, so scale it when present.
    const rescaledQuarterly =
      plan.price_quarterly !== null &&
      plan.price_quarterly !== undefined &&
      Number(plan.price_quarterly) > 0
        ? round2(Number(plan.price_quarterly) / 100)
        : null;

    await planCol.updateOne(
      { _id: plan._id },
      {
        $set: {
          currency: TO_CURRENCY,
          price: rescaledPrice,
          ...(rescaledQuarterly !== null
            ? { price_quarterly: rescaledQuarterly }
            : {}),
        },
      },
    );

    console.log(
      `[MIGRATE] "${plan.name}": ${price} -> ${rescaledPrice} ${TO_CURRENCY.toUpperCase()} (${plan.billing_cycle})`,
    );
  }

  if (skipped.length) {
    console.log(
      `[MIGRATE] note: these had a price below ${MIN_RUPEE_MAGNITUDE} and were NOT rescaled, only relabelled. Re-price them if the amount is wrong:`,
    );
    for (const entry of skipped) {
      console.log(`[MIGRATE]   - ${entry}`);
    }
  }

  const verify = await planCol.countDocuments({ currency: TO_CURRENCY });
  const remaining = await planCol.countDocuments({ currency: FROM_CURRENCY });
  console.log(
    `[MIGRATE] verify -> plans with currency="${TO_CURRENCY}": ${verify}, still "${FROM_CURRENCY}": ${remaining}`,
  );
  console.log(
    '[MIGRATE] note: payments/subscriptions were left untouched; they snapshot their own price and currency at grant time.',
  );

  await mongoose.disconnect();
  console.log('[MIGRATE] done.');
};

run().catch(async (err) => {
  console.error('[MIGRATE] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
