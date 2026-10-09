import httpStatus from 'http-status';
import PDFDocument from 'pdfkit';
import { Payment } from '../models/payment.model.js';
import { Organization } from '../models/organization.model.js';
import { ApiError } from '../utils/ApiError.js';
import { toObjectId } from './common.service.js';

const money = (amount: number, currency: string) =>
  `${String(currency).toUpperCase()} ${Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatDate = (value: Date | null | undefined) => {
  if (!value) return '-';
  const date = new Date(value);
  return `${String(date.getDate()).padStart(2, '0')}-${String(
    date.getMonth() + 1,
  ).padStart(2, '0')}-${date.getFullYear()}`;
};

interface InvoiceData {
  invoiceNumber: string;
  issuedAt: Date | null;
  billedTo: {
    companyName: string;
    email?: string;
    contactNumber?: string;
    countryName?: string;
  } | null;
  planName: string;
  billingCycle: string;
  amount: number;
  currency: string;
  gateway: string | null;
}

const renderInvoicePdf = (data: InvoiceData): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      info: { Title: `Invoice ${data.invoiceNumber}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = 595.28;
    const right = pageWidth - 48;
    let y = 48;

    doc.rect(0, 0, pageWidth, 96).fill('#f4f4f5');
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor('#4f46e5')
      .text('ScanFlow', 48, 32);
    doc
      .font('Helvetica-Bold')
      .fontSize(26)
      .fillColor('#111827')
      .text('INVOICE', right - 220, 28, { width: 220, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#6b7280')
      .text(data.invoiceNumber, right - 220, 62, {
        width: 220,
        align: 'right',
      });
    doc.text(`Issued: ${formatDate(data.issuedAt)}`, right - 220, 78, {
      width: 220,
      align: 'right',
    });

    y = 124;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#6b7280')
      .text('BILLED TO', 48, y);
    y += 18;
    if (data.billedTo) {
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor('#111827')
        .text(data.billedTo.companyName, 48, y);
      y += 18;
      doc.font('Helvetica').fontSize(10).fillColor('#374151');
      for (const line of [
        data.billedTo.email ?? null,
        data.billedTo.contactNumber ?? null,
        data.billedTo.countryName ?? null,
      ]) {
        if (!line) continue;
        doc.text(line, 48, y);
        y += 15;
      }
    } else {
      doc.font('Helvetica').fontSize(10).fillColor('#374151').text('-', 48, y);
    }

    const metaY = 124;
    let metaYOffset = 0;
    const meta = (label: string, value: string) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#9ca3af')
        .text(label, right - 250, metaY + metaYOffset, {
          width: 250,
          align: 'right',
        });
      metaYOffset += 13;
      doc
        .font('Helvetica')
        .fontSize(11)
        .fillColor('#111827')
        .text(value, right - 250, metaY + metaYOffset, {
          width: 250,
          align: 'right',
        });
      metaYOffset += 24;
    };
    meta('SERVICE', data.planName || 'Subscription');
    meta('BILLING PERIOD', `${data.billingCycle}ly`);
    meta('STATUS', 'Paid');
    meta('PAID VIA', data.gateway ? String(data.gateway) : '-');

    y = Math.max(y + 24, metaY + metaYOffset + 24);
    doc
      .strokeColor('#e5e7eb')
      .lineWidth(1)
      .moveTo(48, y)
      .lineTo(right, y)
      .stroke();
    y += 18;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#6b7280')
      .text('SERVICE', 48, y, { width: 300 });
    doc.text('AMOUNT', right - 200, y, { width: 200, align: 'right' });
    y += 18;
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor('#111827')
      .text(
        `${data.planName || 'Subscription'} – ${data.billingCycle}ly plan`,
        48,
        y,
        { width: 300 },
      );
    doc.text(money(data.amount, data.currency), right - 200, y, {
      width: 200,
      align: 'right',
    });
    y += 18;
    doc
      .strokeColor('#e5e7eb')
      .lineWidth(1)
      .moveTo(48, y)
      .lineTo(right, y)
      .stroke();
    y += 22;
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#111827')
      .text('Total', 48, y, { width: 200 });
    doc.text(money(data.amount, data.currency), right - 200, y, {
      width: 200,
      align: 'right',
    });
    y += 34;
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#9ca3af')
      .text(
        `Invoice payable in ${String(data.currency).toUpperCase()}. This is an automatically generated invoice — no tax component is included.`,
        48,
        y,
        { width: right - 48 },
      );

    doc.end();
  });

export const getInvoicePdf = async (
  organizationId: string,
  paymentId: string,
): Promise<{ buffer: Buffer; invoice_number: string }> => {
  const payment = await Payment.findOne({
    _id: toObjectId(paymentId),
    organization_id: toObjectId(organizationId),
  }).populate('plan_id');
  if (!payment) {
    throw new ApiError(httpStatus.NOT_FOUND, 'INVOICE_NOT_FOUND');
  }
  const organization = await Organization.findById(organizationId);
  const invoiceNumber =
    payment.invoice_number ?? `INV-${String(payment._id).slice(-8)}`;
  const buffer = await renderInvoicePdf({
    invoiceNumber,
    issuedAt: payment.paid_at ?? payment.created_at,
    billedTo: organization
      ? {
          companyName: organization.company_name,
          email: organization.email,
          contactNumber: organization.contact_number,
          countryName: organization.country_name,
        }
      : null,
    planName: (payment.plan_id as any)?.name ?? '',
    billingCycle: payment.billing_cycle,
    amount: payment.price ?? 0,
    currency: payment.currency_code ?? 'inr',
    gateway: payment.gateway ?? null,
  });
  return { buffer, invoice_number: invoiceNumber };
};
