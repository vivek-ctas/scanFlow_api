import type { InvoiceEmailDetails } from './email.types.js';
import { BRAND } from './email.constants.js';
import { escapeHtml } from './format.utils.js';

function renderDetailRow(label: string, value: string, isLast = false): string {
  const border = isLast ? '' : `border-bottom:1px solid ${BRAND.border};`;
  return `
    <tr>
      <td style="padding:10px 0;${border}font-size:13px;color:${BRAND.textMuted};width:42%;vertical-align:top;">
        ${escapeHtml(label)}
      </td>
      <td style="padding:10px 0;${border}font-size:13px;color:${BRAND.textPrimary};font-weight:700;text-align:right;vertical-align:top;">
        ${escapeHtml(value)}
      </td>
    </tr>
  `;
}

export function renderGreeting(firstName?: string): string {
  const name = firstName && firstName.trim() ? firstName.trim() : 'there';
  return `
    <p style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:700;color:${BRAND.textPrimary};">
      Hi ${escapeHtml(name)},
    </p>
  `;
}

export function renderLeadParagraph(text: string): string {
  return `
    <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:${BRAND.textSecondary};">
      ${text}
    </p>
  `;
}

export function renderSectionTitle(title: string): string {
  return `
    <p style="margin:0 0 14px;font-size:12px;line-height:1.4;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.sky};">
      ${escapeHtml(title)}
    </p>
  `;
}

export function renderSubscriptionSummary(params: {
  planName: string;
  expiredAt: string;
  billingCycleLabel: string;
}): string {
  return `
    <table width="100%" role="presentation" style="margin:0 0 24px;border:1px solid ${BRAND.border};border-radius:12px;background:${BRAND.surface};">
      <tr>
        <td style="padding:22px 24px;">
          ${renderSectionTitle('Subscription summary')}
          <table width="100%" role="presentation">
            ${renderDetailRow('Plan', params.planName)}
            ${renderDetailRow('Billing cycle', params.billingCycleLabel)}
            ${renderDetailRow('Active until', params.expiredAt, true)}
          </table>
        </td>
      </tr>
    </table>
  `;
}

export function renderInvoiceSummary(invoice: InvoiceEmailDetails): string {
  const billingPeriod = invoice.subscription_start
    ? `${invoice.subscription_start} – ${invoice.subscription_end || '…'}`
    : '—';
  return `
    <table width="100%" role="presentation" style="margin:0 0 24px;border:1px solid ${BRAND.border};border-radius:12px;background:#ffffff;">
      <tr>
        <td style="padding:22px 24px;">
          ${renderSectionTitle('Invoice details')}
          <table width="100%" role="presentation">
            ${renderDetailRow('Invoice number', invoice.invoice_number)}
            ${renderDetailRow('Invoice date', invoice.invoice_date)}
            ${renderDetailRow('Billing period', billingPeriod)}
            ${renderDetailRow('Payment method', invoice.payment_method)}
            ${renderDetailRow('Transaction ID', invoice.transaction_id || '—')}
            ${renderDetailRow('Amount paid', invoice.amount, true)}
          </table>
        </td>
      </tr>
    </table>
  `;
}

export function renderFeaturesList(features: string[]): string {
  const items = features.length
    ? features
        .map(
          (feature) => `
            <tr>
              <td style="padding:0 0 8px;font-size:14px;line-height:1.5;color:${BRAND.textSecondary};">
                <span style="color:${BRAND.sky};font-weight:800;margin-right:8px;">&#10003;</span>
                ${escapeHtml(feature)}
              </td>
            </tr>
          `,
        )
        .join('')
    : `
      <tr>
        <td style="padding:0;font-size:14px;line-height:1.5;color:${BRAND.textSecondary};">
          All features included in your plan.
        </td>
      </tr>
    `;

  return `
    <table width="100%" role="presentation" style="margin:0 0 24px;border:1px solid ${BRAND.border};border-radius:12px;background:${BRAND.surface};">
      <tr>
        <td style="padding:22px 24px;">
          ${renderSectionTitle('What is included')}
          <table width="100%" role="presentation">
            ${items}
          </table>
        </td>
      </tr>
    </table>
  `;
}

export function renderPrimaryCta(label: string, url: string): string {
  return `
    <table width="100%" role="presentation" style="margin:0 0 16px;">
      <tr>
        <td align="center">
          <a href="${escapeHtml(url)}"
             style="display:inline-block;background:${BRAND.gradient};color:#ffffff;font-size:15px;font-weight:700;line-height:1;padding:15px 30px;border-radius:10px;text-decoration:none;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>
  `;
}

export function renderFallbackLink(url: string): string {
  return `
    <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:${BRAND.textMuted};">
      If the button does not work, copy and paste this link into your browser:
    </p>
    <p style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all;">
      <a href="${escapeHtml(url)}" style="color:${BRAND.sky};text-decoration:none;">
        ${escapeHtml(url)}
      </a>
    </p>
  `;
}

export function renderInlineSupport(supportEmail: string): string {
  return `
    <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.textMuted};">
      Questions about your subscription or invoice?
      Email us at
      <a href="mailto:${escapeHtml(supportEmail)}" style="color:${BRAND.sky};text-decoration:none;font-weight:600;">
        ${escapeHtml(supportEmail)}
      </a>.
    </p>
  `;
}

export function renderOtpCodeBox(otp: string): string {
  return `
    <table width="100%" role="presentation" style="margin:0 0 22px;">
      <tr>
        <td align="center">
          <table role="presentation" style="margin:0 auto;background:${BRAND.otpBackground};border:2px dashed ${BRAND.sky};border-radius:12px;">
            <tr>
              <td style="padding:18px 28px;">
                <span style="font-size:32px;font-weight:800;letter-spacing:10px;color:${BRAND.navy};font-family:'Courier New',Courier,monospace;">
                  ${escapeHtml(otp)}
                </span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

export function renderInfoBox(
  headline: string,
  lines: string[],
  tone: 'sky' | 'warn' = 'sky',
): string {
  const accent = tone === 'warn' ? BRAND.skySoft : BRAND.sky;
  const rows = lines
    .map(
      (line) => `
        <tr>
          <td style="padding:2px 0;font-size:14px;line-height:1.55;color:${BRAND.textSecondary};">
            ${line}
          </td>
        </tr>
      `,
    )
    .join('');
  return `
    <table width="100%" role="presentation" style="margin:0 0 24px;border:1px solid ${BRAND.border};border-left:4px solid ${accent};border-radius:12px;background:${BRAND.surface};">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 8px;font-size:13px;line-height:1.4;font-weight:700;color:${BRAND.navy};">${escapeHtml(headline)}</p>
          <table width="100%" role="presentation">
            ${rows}
          </table>
        </td>
      </tr>
    </table>
  `;
}
