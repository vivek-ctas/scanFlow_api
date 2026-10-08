import type { EmailLayoutOptions } from './email.types.js';
import { BRAND, DEFAULT_COMPANY_NAME } from './email.constants.js';
import { escapeHtml } from './format.utils.js';

const renderBrandLockup = (appName: string, supportEmail: string): string => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
    <tr>
      <td style="vertical-align:middle;text-align:left;">
        <span style="
          display:inline-block;
          font-size:26px;
          font-weight:800;
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
          line-height:1;
          letter-spacing:-0.02em;
          background:${BRAND.gradient};
          -webkit-background-clip:text;
          background-clip:text;
          -webkit-text-fill-color:transparent;
        ">
          ${escapeHtml(appName)}
        </span>
      </td>
      <td style="vertical-align:middle;text-align:right;">
        <span style="font-size:12px;line-height:1.4;color:${BRAND.textMuted};">
          <a href="mailto:${escapeHtml(supportEmail)}" style="color:${BRAND.sky};text-decoration:none;font-weight:600;">
            ${escapeHtml(supportEmail)}
          </a>
        </span>
      </td>
    </tr>
  </table>
`;

export function renderEmailLayout(options: EmailLayoutOptions): string {
  const year = new Date().getFullYear();
  const appName = escapeHtml(options.appName || DEFAULT_COMPANY_NAME);
  const supportEmail = escapeHtml(options.supportEmail);
  const headerTitle = escapeHtml(options.headerTitle);
  const headerSubtitle = escapeHtml(options.headerSubtitle);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${headerTitle}</title>
    <style>
      body { margin:0; padding:0; background-color:#F1F5F9; -webkit-text-size-adjust:100%; }
      table { border-spacing:0; border-collapse:collapse; }
      @media only screen and (max-width: 620px) {
        .email-shell { padding:16px 10px !important; }
        .email-card { width:100% !important; }
        .header-pad { padding:22px 20px !important; }
        .section-pad { padding:26px 20px !important; }
        .footer-pad { padding:20px 20px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.textSecondary};">
    <table width="100%" role="presentation" class="email-shell" style="width:100%;background-color:#F1F5F9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table width="600" role="presentation" class="email-card" style="width:600px;max-width:600px;background:#ffffff;border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;box-shadow:0 12px 32px rgba(19,53,90,0.09);">
            <tr>
              <td style="padding:6px 0;background:${BRAND.gradient};font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td class="header-pad" style="padding:28px 36px;border-bottom:1px solid #EEF2F7;">
                ${renderBrandLockup(options.appName || DEFAULT_COMPANY_NAME, options.supportEmail)}
              </td>
            </tr>
            <tr>
              <td class="section-pad" style="padding:34px 36px;">
                <p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND.sky};">
                  ${headerTitle}
                </p>
                <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:${BRAND.textMuted};">
                  ${headerSubtitle}
                </p>
                ${options.content}
              </td>
            </tr>
            <tr>
              <td class="footer-pad" style="padding:26px 36px;background:${BRAND.surface};border-top:1px solid ${BRAND.border};text-align:center;">
                <p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:${BRAND.textMuted};">
                  &copy; ${year} ${appName} Technologies, Inc. All rights reserved.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.5;color:${BRAND.textMuted};">
                  Need help?
                  <a href="mailto:${supportEmail}" style="color:${BRAND.sky};text-decoration:underline;font-weight:600;">
                    Contact support
                  </a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
