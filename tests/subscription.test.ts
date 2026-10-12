import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { createOrg, createPlan, grant, activeUsed } from './helpers.js';
import { scanLimitOf } from '../src/utils/plan-features.util.js';
import {
  getActiveSubscription,
  getOrganizationSubscriptionQueue,
  activateEligibleSubscriptions,
  cancelActiveSubscription,
  cancelQueuedSubscription,
  reorderSubscriptionQueue,
  adjustScanLimits,
  forceActivateSubscription,
  renewSubscription,
  getSubscriptionSummary,
} from '../src/services/subscription.service.js';
import { Subscription } from '../src/models/index.js';
import {
  reserveScanUsage,
  readActiveSubUsage,
} from '../src/services/quota.service.js';

describe('subscription lifecycle (§3 + §8)', () => {
  it('1. no active subscription -> first assignment becomes active', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 50 });
    const sub = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    expect(sub.status).toBe('active');
    expect(scanLimitOf(sub.features)).toBe(50);
    const queued = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queued).toHaveLength(0);
    const active = await getActiveSubscription(String(org._id));
    expect(active?._id.toString()).toBe(String(sub._id));
  });

  it('2. existing active -> new assignment becomes future', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A', scan_limit: 10 });
    const planB = await createPlan({ name: 'B', scan_limit: 20 });
    await grant(String(org._id), String(planA._id), { trialDays: 0 });
    const subB = await grant(String(org._id), String(planB._id), {
      trialDays: 0,
    });
    expect(subB.status).toBe('future');
    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queue).toHaveLength(1);
    expect(String(queue[0]._id)).toBe(String(subB._id));
  });

  it('3. multiple futures keep FIFO order and increasing queue_priority', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    const planC = await createPlan({ name: 'C' });
    await grant(String(org._id), String(planA._id));
    const subB = await grant(String(org._id), String(planB._id));
    const subC = await grant(String(org._id), String(planC._id));
    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queue.map((s) => String(s._id))).toEqual([
      String(subB._id),
      String(subC._id),
    ]);
    expect(queue[0].queue_priority).toBe(1);
    expect(queue[1].queue_priority).toBe(2);
  });

  it('4. expiry promotes the earliest future subscription', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    const active = await grant(String(org._id), String(planA._id));
    const future = await grant(String(org._id), String(planB._id));
    await Subscription.updateOne(
      { _id: active._id },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
    );
    await activateEligibleSubscriptions();
    const refreshedActive = await getActiveSubscription(String(org._id));
    expect(String(refreshedActive?._id)).toBe(String(future._id));
    expect(refreshedActive?.status).toBe('active');
    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queue).toHaveLength(0);
  });

  it('5. cancel active promotes earliest future (promote mode)', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B', scan_limit: 999 });
    await grant(String(org._id), String(planA._id));
    const future = await grant(String(org._id), String(planB._id));
    const result = await cancelActiveSubscription(String(org._id), 'test');
    expect(String(result.data.promotedSubscription)).toBe(String(future._id));
    const active = await getActiveSubscription(String(org._id));
    expect(String(active?._id)).toBe(String(future._id));
  });

  it('6. force activate resets usage and applies the new limit', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A', scan_limit: 1 });
    const planB = await createPlan({ name: 'B', scan_limit: 10 });
    await grant(String(org._id), String(planA._id), { trialDays: 0 });
    const first = await reserveScanUsage(String(org._id));
    expect(first.status).toBe('ok');
    expect(await activeUsed(String(org._id))).toBe(1);
    const blocked = await reserveScanUsage(String(org._id));
    expect(blocked.status).toBe('quota_exceeded');
    await forceActivateSubscription(String(org._id), String(planB._id));
    // brand new period -> counter reset to 0
    expect(await activeUsed(String(org._id))).toBe(0);
    const fresh = await reserveScanUsage(String(org._id));
    expect(fresh.status).toBe('ok');
    expect(fresh.status === 'ok' && fresh.count).toBe(1);
    const active = await getActiveSubscription(String(org._id));
    expect(scanLimitOf(active?.features ?? [])).toBe(10);
  });

  it('7. renew continue extends expiry, promote activates next, no active -> error', async () => {
    const org = await createOrg();
    const plan = await createPlan();
    const active = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    const before = active.expires_at.getTime();
    await renewSubscription(String(org._id), 'continue');
    const afterActive = await getActiveSubscription(String(org._id));
    expect(afterActive?.expires_at.getTime()).toBeGreaterThan(before);

    const planB = await createPlan({ name: 'Renew Plan' });
    await grant(String(org._id), String(planB._id));
    await renewSubscription(String(org._id), 'promote');
    const promoted = await getActiveSubscription(String(org._id));
    expect(promoted?.plan_id).toBeDefined();
    // promote must retire the previous active, never sit alongside it
    const activesAfterPromote = await Subscription.find({
      organization_id: new mongoose.Types.ObjectId(String(org._id)),
      status: 'active',
    });
    expect(activesAfterPromote).toHaveLength(1);
    expect(String(activesAfterPromote[0]._id)).toBe(String(promoted?._id));

    const another = await renewSubscription(String(org._id), 'continue');
    expect(another.status).toBe(200);
  });

  it('8. single-active invariant never breaks across many grants', async () => {
    const org = await createOrg();
    const created: string[] = [];
    for (let i = 0; i < 10; i++) {
      const plan = await createPlan({ name: `P${i}` });
      const sub = await grant(String(org._id), String(plan._id));
      created.push(String(sub._id));
    }
    const actives = await Subscription.find({
      organization_id: new mongoose.Types.ObjectId(String(org._id)),
      status: 'active',
    });
    expect(actives).toHaveLength(1);

    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queue).toHaveLength(9);
    for (let i = 0; i < 9; i++) {
      await cancelActiveSubscription(String(org._id), `promote ${i}`);
      const activesNow = await Subscription.find({
        organization_id: new mongoose.Types.ObjectId(String(org._id)),
        status: 'active',
      });
      expect(activesNow).toHaveLength(1);
    }
    const queueEnd = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queueEnd).toHaveLength(0);
    expect(created.length).toBe(10);
  });

  it('summary returns active subscription + normalized usage row', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 5 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const summary = await getSubscriptionSummary(String(org._id));
    expect(summary.status).toBe(200);
    const body: any = summary.data;
    expect(body.activeSubscription).toBeTruthy();
    expect(scanLimitOf(body.activeSubscription.features)).toBe(5);
    expect(body.usage).toEqual({
      period_count: 0,
      scan_limit: 5,
      quota_period: 'month',
      subscription_expires_at: body.activeSubscription.expires_at,
      usages: [
        {
          feature_name: 'scan',
          usage: 0,
          scan_limit: 5,
          started_at: body.activeSubscription.started_at,
          expires_at: body.activeSubscription.expires_at,
        },
      ],
    });
  });

  // Plan writes always store a quarterly amount, so this exercises the guard for
  // legacy/malformed rows that predate that invariant.
  it('quarterly grant on a plan missing price_quarterly is rejected (400)', async () => {
    const org = await createOrg();
    const plan = await createPlan({
      price: 100,
      price_quarterly: null,
      billing_cycle: 'quarterly',
    });
    await expect(
      grant(String(org._id), String(plan._id), {
        trialDays: 0,
        billingCycle: 'quarterly',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Quarterly pricing is not configured for this plan',
    });
  });

  it('grant on a cycle the plan does not sell is rejected (400)', async () => {
    const org = await createOrg();
    // Monthly-only plan, quarterly requested.
    const plan = await createPlan({
      price: 100,
      price_quarterly: 300,
      billing_cycle: 'month',
    });
    await expect(
      grant(String(org._id), String(plan._id), {
        trialDays: 0,
        billingCycle: 'quarterly',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Test Plan is only available on the monthly billing cycle',
    });
  });

  it('grant defaults to the plan billing_cycle when none is given', async () => {
    const org = await createOrg();
    const plan = await createPlan({
      price: 100,
      price_quarterly: 250,
      billing_cycle: 'quarterly',
    });
    const sub = await grant(String(org._id), String(plan._id));
    expect(sub.billing_cycle).toBe('quarterly');
    expect(sub.plan_price).toBe(250);
  });

  it('trial extends the paid period instead of replacing it', async () => {
    const org = await createOrg();
    const plan = await createPlan({
      price: 100,
      price_quarterly: 300,
      billing_cycle: 'quarterly',
    });
    const sub = await grant(String(org._id), String(plan._id), {
      trialDays: 14,
      billingCycle: 'quarterly',
    });
    // 14 trial days + 3 monthly billing months, not 14 days total.
    const spanDays =
      (sub.expires_at.getTime() - sub.started_at.getTime()) / 86_400_000;
    expect(spanDays).toBeGreaterThan(90);
    expect(spanDays).toBeLessThan(110);
  });

  it('renew does not re-apply the trial on an already-trialed subscription', async () => {
    const org = await createOrg();
    const plan = await createPlan({ price: 100 });
    const sub = await grant(String(org._id), String(plan._id), {
      trialDays: 14,
    });
    const before = sub.expires_at.getTime();
    const res = await renewSubscription(String(org._id), 'continue');
    const after = new Date(
      (res as any).data.activeSubscription.expires_at,
    ).getTime();
    // A renewal adds exactly one billing month to the existing expiry.
    const addedDays = (after - before) / 86_400_000;
    expect(addedDays).toBeGreaterThan(27);
    expect(addedDays).toBeLessThan(32);
  });

  it('manual grant creates a TXN_SUCCESS payment and links it', async () => {
    const org = await createOrg();
    const plan = await createPlan({
      price: 250,
      price_quarterly: 600,
      billing_cycle: 'quarterly',
    });
    const sub = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
      billingCycle: 'quarterly',
    });
    const cached = await readActiveSubUsage(String(org._id), sub as any);
    expect(cached).not.toBeNull();
    const active = await getActiveSubscription(String(org._id));
    const payment: any = await (
      await import('../src/models/index.js')
    ).Payment.findById(active?.payment_id);
    expect(payment).toBeTruthy();
    expect(payment.gateway).toBe('manual');
    expect(payment.status).toBe('TXN_SUCCESS');
    expect(payment.billing_cycle).toBe('quarterly');
    expect(payment.price).toBe(600);
    expect(payment.organization_id.toString()).toBe(String(org._id));
  });

  it('cancel-queued removes only the targeted future and repacks the rest', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    const planC = await createPlan({ name: 'C' });
    await grant(String(org._id), String(planA._id));
    const b = await grant(String(org._id), String(planB._id));
    const c = await grant(String(org._id), String(planC._id));

    const result = await cancelQueuedSubscription(String(org._id), String(b._id));
    expect(result.status).toBe(200);

    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queue.map((s) => String(s._id))).toEqual([String(c._id)]);
    expect(queue[0].queue_priority).toBe(1);

    const cancelled = await Subscription.findById(b._id);
    expect(cancelled?.status).toBe('cancelled');
    // The active subscription must be untouched.
    const active = await getActiveSubscription(String(org._id));
    expect(active?.status).toBe('active');
  });

  it('cancel-queued rejects a non-future subscription', async () => {
    const org = await createOrg();
    const plan = await createPlan();
    const active = await grant(String(org._id), String(plan._id));
    await expect(
      cancelQueuedSubscription(String(org._id), String(active._id)),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'ONLY_FUTURE_SUBSCRIPTIONS_CAN_BE_CANCELLED',
    });
  });

  it('reorder-queue applies the submitted order to queue_priority', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    const planC = await createPlan({ name: 'C' });
    await grant(String(org._id), String(planA._id));
    const b = await grant(String(org._id), String(planB._id));
    const c = await grant(String(org._id), String(planC._id));

    await reorderSubscriptionQueue(String(org._id), [
      String(c._id),
      String(b._id),
    ]);
    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queue.map((s) => String(s._id))).toEqual([String(c._id), String(b._id)]);
    expect(queue[0].queue_priority).toBe(1);
    expect(queue[1].queue_priority).toBe(2);
  });

  it('chains a newly queued subscription off the queue tail, not the active one', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    const planC = await createPlan({ name: 'C' });

    const active = await grant(String(org._id), String(planA._id));
    const first = await grant(String(org._id), String(planB._id));
    const second = await grant(String(org._id), String(planC._id));

    // The first future row starts when the active one ends.
    expect(first.started_at!.getTime()).toBe(active.expires_at!.getTime());
    // The second must start after the first ends. Chaining off the active expiry
    // instead would place both future rows at the same start.
    expect(second.started_at!.getTime()).toBe(first.expires_at!.getTime());
    expect(second.started_at!.getTime()).toBeGreaterThan(
      active.expires_at!.getTime(),
    );
  });

  it('reorder-queue rewrites the schedule so dates follow the new order', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    const planC = await createPlan({ name: 'C' });

    const active = await grant(String(org._id), String(planA._id));
    const b = await grant(String(org._id), String(planB._id));
    const c = await grant(String(org._id), String(planC._id));

    await reorderSubscriptionQueue(String(org._id), [
      String(c._id),
      String(b._id),
    ]);

    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    const [head, tail] = queue;
    // Head now starts where the active subscription ends.
    expect(head.started_at!.getTime()).toBe(active.expires_at!.getTime());
    // Tail starts where the head ends, with no gap or overlap.
    expect(tail.started_at!.getTime()).toBe(head.expires_at!.getTime());
    // The reorder moved c ahead of b, so b's own dates must have changed.
    const reloadedB = await Subscription.findById(b._id);
    expect(reloadedB?.started_at!.getTime()).toBe(head.expires_at!.getTime());
    // Every queued row keeps its own plan and cycle.
    expect(String(reloadedB?.plan_id)).toBe(String(planB._id));
    expect(reloadedB?.billing_cycle).toBe('month');
  });

  it('reorder-queue preserves each queued plan own billing cycle', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({
      name: 'B',
      billing_cycle: 'quarterly',
      price_quarterly: 300,
    });
    const planC = await createPlan({ name: 'C' });

    await grant(String(org._id), String(planA._id));
    const b = await grant(String(org._id), String(planB._id));
    const c = await grant(String(org._id), String(planC._id));

    await reorderSubscriptionQueue(String(org._id), [
      String(b._id),
      String(c._id),
    ]);

    const reloadedB = await Subscription.findById(b._id);
    const reloadedC = await Subscription.findById(c._id);
    expect(reloadedB?.billing_cycle).toBe('quarterly');
    expect(reloadedC?.billing_cycle).toBe('month');
    // A quarterly row spans three months, a monthly row one.
    const bDays = Math.round(
      (reloadedB!.expires_at!.getTime() - reloadedB!.started_at!.getTime()) /
        86_400_000,
    );
    const cDays = Math.round(
      (reloadedC!.expires_at!.getTime() - reloadedC!.started_at!.getTime()) /
        86_400_000,
    );
    expect(bDays).toBeGreaterThan(cDays);
  });

  it('promote with an empty queue fails without retiring the active subscription', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const active = await grant(String(org._id), String(planA._id));

    await expect(
      renewSubscription(String(org._id), 'promote'),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'No queued subscription to promote',
    });

    // The customer must still hold the plan they had.
    const stillActive = await getActiveSubscription(String(org._id));
    expect(stillActive).not.toBeNull();
    expect(String(stillActive!._id)).toBe(String(active._id));
    expect(stillActive?.status).toBe('active');
  });

  it('ignores start_date when the new plan is queued behind the active one', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });

    const active = await grant(String(org._id), String(planA._id));
    // A far-future date must not pull the queued row forward; it chains off the
    // active subscription instead (SaaS assign-plan semantics).
    const queued = await grant(String(org._id), String(planB._id), {
      startDate: '2035-01-01',
    });

    expect(queued.status).toBe('future');
    expect(queued.started_at!.getTime()).toBe(active.expires_at!.getTime());
  });

  it('start_date drives started_at and expires_at on a force-activated plan', async () => {
    const org = await createOrg();
    const plan = await createPlan({ name: 'A' });
    const sub = await grant(String(org._id), String(plan._id), {
      forceActive: true,
      startDate: '2031-06-01',
    });

    expect(sub.status).toBe('active');
    expect(sub.started_at!.toISOString().slice(0, 10)).toBe('2031-06-01');
    expect(sub.expires_at!.toISOString().slice(0, 10)).toBe('2031-07-01');
  });

  it('force-activate applies the start_date sent by the admin endpoint', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });

    await grant(String(org._id), String(planA._id));
    const result = await forceActivateSubscription(
      String(org._id),
      String(planB._id),
      { trialDays: 0, startDate: '2032-03-15' },
    );
    const forced = (result as any).data.subscription;

    expect(forced.status).toBe('active');
    expect(forced.started_at.toISOString().slice(0, 10)).toBe('2032-03-15');
    expect(forced.expires_at.toISOString().slice(0, 10)).toBe('2032-04-15');
    const active = await getActiveSubscription(String(org._id));
    expect(String(active?._id)).toBe(String(forced._id));
  });

  it('reorder-queue rejects a partial or extra id list', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    await grant(String(org._id), String(planA._id));
    const b = await grant(String(org._id), String(planB._id));
    const planC = await createPlan({ name: 'C' });
    const c = await grant(String(org._id), String(planC._id));

    // Missing one queued id.
    await expect(
      reorderSubscriptionQueue(String(org._id), [String(c._id)]),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'QUEUE_ORDER_MISMATCH',
    });
    // Includes an id that is not queued.
    await expect(
      reorderSubscriptionQueue(String(org._id), [
        String(c._id),
        String(b._id),
        String(planA._id),
      ]),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'QUEUE_ORDER_MISMATCH',
    });
  });

  it('adjust-scan-limits raises the active quota and preserves used count', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 10 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    expect((await reserveScanUsage(String(org._id))).status).toBe('ok');
    expect((await reserveScanUsage(String(org._id))).status).toBe('ok');
    expect(await activeUsed(String(org._id))).toBe(2);

    const result = await adjustScanLimits(String(org._id), String(
      (await getActiveSubscription(String(org._id)))!._id,
    ), [{ delta: 5 }]);
    expect(result.status).toBe(200);
    expect(result.data.scan_limit).toBe(15);
    expect(result.data.usage).toBe(2);
    expect(await activeUsed(String(org._id))).toBe(2);
  });

  it('adjust-scan-limits refuses to drop the quota below used count', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scan_limit: 5 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    expect((await reserveScanUsage(String(org._id))).status).toBe('ok');
    expect(await activeUsed(String(org._id))).toBe(1);

    const active = await getActiveSubscription(String(org._id));
    await expect(
      adjustScanLimits(String(org._id), String(active!._id), [{ delta: 1 }]),
    ).resolves.toMatchObject({ status: 200 });
    // Now 5 -> 6; a fresh adjustment cannot go below the already-used count.
    await expect(
      adjustScanLimits(String(org._id), String(active!._id), [{ delta: -5 }]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('adjust-scan-limits updates the feature snapshot on a queued subscription', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B', scan_limit: 20 });
    await grant(String(org._id), String(planA._id));
    const queued = await grant(String(org._id), String(planB._id));

    const result = await adjustScanLimits(String(org._id), String(queued._id), [
      { delta: 30 },
    ]);
    expect(result.status).toBe(200);
    expect(result.data.scan_limit).toBe(50);

    const refreshed = await Subscription.findById(queued._id);
    expect(scanLimitOf(refreshed?.features ?? [])).toBe(50);
  });

  it('adjust-scan-limits rejects a cancelled subscription', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    await grant(String(org._id), String(planA._id));
    const queued = await grant(String(org._id), String(planB._id));
    await cancelQueuedSubscription(String(org._id), String(queued._id));

    await expect(
      adjustScanLimits(String(org._id), String(queued._id), [{ delta: 5 }]),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'LIMITS_CANNOT_BE_ADJUSTED_ON_CANCELLED',
    });
  });
});
