import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import {
  createOrg,
  createPlan,
  grant,
} from './helpers.js';
import {
  getActiveSubscription,
  getOrganizationSubscriptionQueue,
  promoteEarliestFutureSubscription,
  activateEligibleSubscriptions,
  cancelActiveSubscription,
  forceActivateSubscription,
  renewSubscription,
  getSubscriptionSummary,
} from '../src/services/subscription.service.js';
import { Subscription } from '../src/models/index.js';
import { reserveScanUsage } from '../src/services/quota.service.js';

describe('subscription lifecycle (§3 + §8)', () => {
  it('1. no active subscription -> first assignment becomes active', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 50 });
    const sub = await grant(String(org._id), String(plan._id), { trialDays: 0 });
    expect(sub.status).toBe('active');
    expect(sub.scanLimit).toBe(50);
    const queued = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queued).toHaveLength(0);
    const active = await getActiveSubscription(String(org._id));
    expect(active?._id.toString()).toBe(String(sub._id));
  });

  it('2. existing active -> new assignment becomes future', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A', scanLimit: 10 });
    const planB = await createPlan({ name: 'B', scanLimit: 20 });
    await grant(String(org._id), String(planA._id), { trialDays: 0 });
    const subB = await grant(String(org._id), String(planB._id), { trialDays: 0 });
    expect(subB.status).toBe('future');
    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queue).toHaveLength(1);
    expect(String(queue[0]._id)).toBe(String(subB._id));
  });

  it('3. multiple futures keep FIFO order and increasing queuePriority', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    const planC = await createPlan({ name: 'C' });
    await grant(String(org._id), String(planA._id));
    const subB = await grant(String(org._id), String(planB._id));
    const subC = await grant(String(org._id), String(planC._id));
    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queue.map((s) => String(s._id))).toEqual([String(subB._id), String(subC._id)]);
    expect(queue[0].queuePriority).toBe(1);
    expect(queue[1].queuePriority).toBe(2);
  });

  it('4. expiry promotes the earliest future subscription', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A' });
    const planB = await createPlan({ name: 'B' });
    const active = await grant(String(org._id), String(planA._id));
    const future = await grant(String(org._id), String(planB._id));
    await Subscription.updateOne(
      { _id: active._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
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
    const planB = await createPlan({ name: 'B', scanLimit: 999 });
    await grant(String(org._id), String(planA._id));
    const future = await grant(String(org._id), String(planB._id));
    const result = await cancelActiveSubscription(String(org._id), 'test');
    expect(String(result.data.promotedSubscription)).toBe(String(future._id));
    const active = await getActiveSubscription(String(org._id));
    expect(String(active?._id)).toBe(String(future._id));
  });

  it('6. force activate resets usage and applies the new limit', async () => {
    const org = await createOrg();
    const planA = await createPlan({ name: 'A', scanLimit: 1 });
    const planB = await createPlan({ name: 'B', scanLimit: 10 });
    await grant(String(org._id), String(planA._id), { trialDays: 0 });
    const first = await reserveScanUsage(String(org._id));
    expect(first.status).toBe('ok');
    const blocked = await reserveScanUsage(String(org._id));
    expect(blocked.status).toBe('quota_exceeded');
    await forceActivateSubscription(String(org._id), String(planB._id));
    const fresh = await reserveScanUsage(String(org._id));
    expect(fresh.status).toBe('ok');
    expect(fresh.status === 'ok' && fresh.count).toBe(1);
    const active = await getActiveSubscription(String(org._id));
    expect(active?.scanLimit).toBe(10);
  });

  it('7. renew continue extends expiry, promote activates next, no active -> error', async () => {
    const org = await createOrg();
    const plan = await createPlan();
    const active = await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const before = active.expiresAt.getTime();
    await renewSubscription(String(org._id), 'continue');
    const afterActive = await getActiveSubscription(String(org._id));
    expect(afterActive?.expiresAt.getTime()).toBeGreaterThan(before);

    const planB = await createPlan({ name: 'Renew Plan' });
    await grant(String(org._id), String(planB._id));
    await renewSubscription(String(org._id), 'promote');
    const promoted = await getActiveSubscription(String(org._id));
    expect(promoted?.planId).toBeDefined();

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
      organizationId: new mongoose.Types.ObjectId(String(org._id)),
      status: 'active',
    });
    expect(actives).toHaveLength(1);

    const queue = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queue).toHaveLength(9);
    for (let i = 0; i < 9; i++) {
      await cancelActiveSubscription(String(org._id), `promote ${i}`);
      const activesNow = await Subscription.find({
        organizationId: new mongoose.Types.ObjectId(String(org._id)),
        status: 'active',
      });
      expect(activesNow).toHaveLength(1);
    }
    const queueEnd = await getOrganizationSubscriptionQueue(String(org._id));
    expect(queueEnd).toHaveLength(0);
  });

  it('summary returns active subscription + usage row', async () => {
    const org = await createOrg();
    const plan = await createPlan({ scanLimit: 5 });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const summary = await getSubscriptionSummary(String(org._id));
    expect(summary.status).toBe(200);
    const body: any = summary.data;
    expect(body.activeSubscription).toBeTruthy();
    expect(body.activeSubscription.scanLimit).toBe(5);
    expect(body.usage).toBeTruthy();
    expect(body.usage.used).toBe(0);
  });
});