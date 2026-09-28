import httpStatus from 'http-status';
import { GuestLead } from '../models/guest-lead.model.js';
import { Payment, PaymentGateway } from '../models/payment.model.js';
import { Organization } from '../models/organization.model.js';
import { ApiError } from '../utils/ApiError.js';
import { toObjectId } from './common.service.js';
import { createOrganization } from './admin/organizations.service.js';
import { grantSubscription } from './subscription.service.js';
import {
  sendPaymentSuccessEmail,
  sendPaymentFailureEmail,
} from './email.service.js';
import { logger } from '../config/logger.js';

export interface ProcessGatewaySuccessInput {
  leadId: string;
  gateway: PaymentGateway;
  gatewayEventId: string;
  successPayload: Record<string, any>;
  amount: number;
  gatewayAmount: number;
  currency: string;
}

/**
 * Shared provisioning path for both gateways (§6.3 + §7 steps 4-10).
 * The conditional `initiated -> success` status transition is the primary
 * idempotency guard; the unique `gatewayEventId` index is conditional on it.
 */
export const processGatewaySuccess = async ({
  leadId,
  gateway,
  gatewayEventId,
  successPayload,
  amount,
  gatewayAmount,
  currency,
}: ProcessGatewaySuccessInput) => {
  const lead = await GuestLead.findOneAndUpdate(
    { _id: toObjectId(leadId), status: 'initiated' },
    { $set: { status: 'success' } },
    { new: true },
  );
  if (!lead) {
    const existingPayment = await Payment.findOne({ gatewayEventId });
    if (existingPayment) {
      return {
        alreadyHandled: true,
        organizationId: existingPayment.organizationId ?? null,
      };
    }
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Lead is not in a processable state',
    );
  }

  let payment;
  try {
    payment = await Payment.create({
      leadId: lead._id,
      gateway,
      amount,
      gatewayAmount,
      currency,
      status: 'TXN_SUCCESS',
      gatewayEventId,
      successResponse: successPayload,
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      const existing = await Payment.findOne({ gatewayEventId });
      return {
        alreadyHandled: true,
        organizationId: existing?.organizationId ?? null,
      };
    }
    throw err;
  }
  payment.invoiceNumber = `INV-${String(payment._id).slice(-8)}`;

  try {
    let organization = await Organization.findOne({ email: lead.email });
    if (!organization) {
      try {
        const created = await createOrganization(
          {
            name: lead.company || 'ScanFlow Organization',
            email: lead.email,
            contactNumber: lead.phone,
            status: 1,
            adminEmail: lead.email,
            adminFirstName: lead.firstName,
            adminLastName: lead.lastName,
            adminContactNo: lead.phone,
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
      String(lead.planId),
      {
        trialDays: lead.trialDays,
      },
    );

    payment.organizationId = organization._id;
    await payment.save();

    await sendPaymentSuccessEmail(lead.email, {
      firstName: lead.firstName,
      organizationName: organization.name,
      planName: `Plan (${subscription.billingCycle})`,
      amount,
      currency,
      invoiceNumber: payment.invoiceNumber,
      invoiceUrl: payment.invoiceUrl ?? undefined,
    });

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
    payment.failedResponse = { error: err.message };
    await payment.save();
    await sendPaymentFailureEmail(lead.email, {
      firstName: lead.firstName,
    }).catch(() => undefined);
    logger.error(
      `[PAYMENT] ${gateway} provisioning failed for lead ${leadId}: ${err.message}`,
    );
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      'Payment recorded but provisioning failed',
    );
  }
};
