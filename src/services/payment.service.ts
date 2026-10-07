import httpStatus from 'http-status';
import { GuestLead } from '../models/guest-lead.model.js';
import { Payment, PaymentGateway } from '../models/payment.model.js';
import { Organization } from '../models/organization.model.js';
import { ApiError } from '../utils/ApiError.js';
import { createOrganization } from './admin/organizations.service.js';
import { grantSubscription } from './subscription.service.js';
import { sendPaymentFailureEmail } from './email.service.js';
import { dispatchSubscriptionGrantEmails } from './subscription-email.service.js';
import { logger } from '../config/logger.js';

export interface ProcessGatewaySuccessInput {
  orderId: string;
  transactionId: string;
  gateway: PaymentGateway;
  successPayload: Record<string, any>;
  amount: number;
  currency: string;
}

/**
 * Shared provisioning path for both gateways (§6.3 + §7 steps 4-10).
 * The payment row is matched by `order_id` (stripe session.id / razorpay order
 * id); an already `TXN_SUCCESS` payment short-circuits idempotently. The
 * unique sparse `transaction_id` index guards against double-processing.
 */
export const processGatewaySuccess = async ({
  orderId,
  transactionId,
  gateway,
  successPayload,
}: ProcessGatewaySuccessInput) => {
  const payment = await Payment.findOne({ order_id: orderId });
  if (!payment) {
    const existingByTxn = await Payment.findOne({
      transaction_id: transactionId,
    });
    if (existingByTxn) {
      return {
        alreadyHandled: true,
        organizationId: existingByTxn.organization_id ?? null,
      };
    }
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Order not found for this payment',
    );
  }

  if (payment.status === 'TXN_SUCCESS') {
    return {
      alreadyHandled: true,
      organizationId: payment.organization_id ?? null,
    };
  }

  const lead = await GuestLead.findOne({
    _id: payment.lead_id,
    status: 'initiated',
  });
  if (!lead) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Lead is not in a processable state',
    );
  }

  try {
    let organization = await Organization.findOne({ email: lead.email });
    if (!organization) {
      try {
        const created = await createOrganization(
          {
            first_name: lead.first_name,
            last_name: lead.last_name,
            company_name: lead.company_name || 'ScanFlow Organization',
            email: lead.email,
            contact_number: lead.contact_number,
            country_name: lead.country_name,
            status: 1,
          },
          undefined,
        );
        organization = created.data.organization;
      } catch (err: any) {
        if (err?.message === 'Email already taken') {
          organization = await Organization.findOne({ email: lead.email });
        }
        if (!organization) {
          throw err;
        }
      }
    }

    if (!organization) {
      throw new ApiError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'Organization resolution failed',
      );
    }

    const subscription = await grantSubscription(
      String(organization._id),
      String(payment.plan_id),
      {
        trialDays: lead.trial_days,
        // The lead carries the cycle that was quoted at checkout.
        billingCycle: lead.billing_cycle ?? payment.billing_cycle,
        paymentId: String(payment._id),
      },
    );

    payment.status = 'TXN_SUCCESS';
    payment.organization_id = organization._id;
    payment.transaction_id = transactionId;
    payment.paid_at = new Date();
    payment.gateway_response = successPayload;
    payment.invoice_number = `INV-${String(payment._id).slice(-8)}`;
    await payment.save();

    void dispatchSubscriptionGrantEmails(
      String(organization._id),
      subscription as any,
    );

    await GuestLead.updateOne(
      { _id: lead._id },
      { $set: { status: 'success' } },
    );

    return {
      alreadyHandled: false,
      organizationId: String(organization._id),
      subscription,
    };
  } catch (err: any) {
    await GuestLead.updateOne(
      { _id: lead._id },
      { $set: { status: 'failed' } },
    );
    payment.status = 'FAILED';
    payment.gateway_response = { error: err.message };
    await payment.save();
    await sendPaymentFailureEmail(lead.email, {
      firstName: lead.first_name,
    }).catch(() => undefined);
    logger.error(
      `[PAYMENT] ${gateway} provisioning failed for order ${orderId}: ${err.message}`,
    );
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      'Payment recorded but provisioning failed',
    );
  }
};
