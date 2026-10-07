import type { OtpEmailContext } from './email.types.js';
import { renderEmailLayout } from './email-layout.js';
import {
  renderGreeting,
  renderInlineSupport,
  renderLeadParagraph,
  renderOtpCodeBox,
} from './email-components.js';
import { escapeHtml } from './format.utils.js';

export function renderOtpEmail(ctx: OtpEmailContext): string {
  const appName = escapeHtml(ctx.app_name);
  const content = `
    ${renderGreeting(ctx.first_name)}
    ${renderLeadParagraph(
      `Use the verification code below to sign in to your <strong>${appName}</strong> account. This code is valid for <strong>${ctx.expiry_minutes} minutes</strong>.`,
    )}
    ${renderOtpCodeBox(ctx.otp)}
    <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#6B7280;">
      If you did not request this code, you can safely ignore this email — your account stays protected.
    </p>
    ${renderInlineSupport(ctx.support_email)}
  `;

  return renderEmailLayout({
    appName: ctx.app_name,
    headerTitle: 'Verify it’s you',
    headerSubtitle:
      'Enter this one-time code to finish signing in to your ScanFlow account.',
    supportEmail: ctx.support_email,
    content,
  });
}
