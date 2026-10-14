import httpStatus from 'http-status';
import PDFDocument from 'pdfkit';
import { Payment } from '../models/payment.model.js';
import { Organization } from '../models/organization.model.js';
import { Subscription } from '../models/subscription.model.js';
import { getWebSettings } from './admin/web-settings.service.js';
import { ApiError } from '../utils/ApiError.js';
import { toObjectId } from './common.service.js';

type PdfDoc = InstanceType<typeof PDFDocument>;

export const BRAND_DARK = '#13355A'; // Deep Navy
export const BRAND_COLOR = '#249BCA'; // Accent Sky Blue
export const BRAND_SKY_LIGHT = '#38BDF8';
export const TEXT_PRIMARY = '#111827';
export const TEXT_SECONDARY = '#4B5563';
export const TEXT_MUTED = '#6B7280';
export const BORDER_COLOR = '#E2E8F0';
export const SURFACE_COLOR = '#F8FAFC';
export const TOTAL_ROW_BG = '#F0F9FF';
export const SUCCESS_GREEN = '#10B981';
export const WHITE = '#FFFFFF';

// ── Base64-encoded 80x80 Ctasis/ScanFlow logo PNG for PDFKit embedding ───
export const LOGO_BASE64 =
  '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';

// ── Currency & Format Utilities ───────────────────────────────────────────
const formatCurrency = (amount: number, currencyCode?: string): string => {
  const code = String(currencyCode || 'usd').toUpperCase();
  const value = Number(amount) || 0;
  const numStr = value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (code === 'INR') {
    return `INR ${numStr}`;
  }
  if (code === 'USD') {
    return `$${numStr}`;
  }
  if (code === 'EUR') {
    return `EUR ${numStr}`;
  }
  return `${code} ${numStr}`;
};

const formatInvoiceDate = (date: Date | string | null | undefined): string => {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
};

const formatBillingCycle = (cycle?: string): string => {
  switch (cycle?.toLowerCase()) {
    case 'quarterly':
      return 'Quarterly';
    case 'month':
    case 'monthly':
      return 'Monthly';
    default:
      return cycle ? cycle.charAt(0).toUpperCase() + cycle.slice(1) : 'Monthly';
  }
};

const formatGateway = (gateway?: string | null): string => {
  switch (gateway?.toLowerCase()) {
    case 'razorpay':
      return 'Razorpay';
    case 'stripe':
      return 'Stripe';
    case 'manual':
      return 'Manual payment';
    default:
      return gateway
        ? gateway.charAt(0).toUpperCase() + gateway.slice(1)
        : 'Online payment';
  }
};

// ── Lightweight Vector Icons ──────────────────────────────────────────────
type IconType = 'person' | 'mail' | 'building' | 'pin' | 'globe' | 'phone';

function drawIcon(
  doc: PdfDoc,
  type: IconType,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  doc.save();
  doc.fillColor(color).strokeColor(color).lineWidth(1);
  const cx = x + size / 2;

  switch (type) {
    case 'person':
      doc.circle(cx, y + size * 0.28, size * 0.18).fill();
      doc
        .moveTo(x + size * 0.12, y + size)
        .quadraticCurveTo(cx, y + size * 0.5, x + size * 0.88, y + size)
        .fill();
      break;
    case 'mail':
      doc.roundedRect(x, y + size * 0.15, size, size * 0.7, 1).stroke();
      doc
        .moveTo(x, y + size * 0.2)
        .lineTo(cx, y + size * 0.55)
        .lineTo(x + size, y + size * 0.2)
        .stroke();
      break;
    case 'building':
      doc.rect(x + size * 0.15, y, size * 0.7, size).stroke();
      [0.15, 0.4].forEach((ry) => {
        [0.28, 0.6].forEach((rx) => {
          doc
            .rect(x + size * rx, y + size * ry, size * 0.12, size * 0.12)
            .fill();
        });
      });
      break;
    case 'pin':
      doc.circle(cx, y + size * 0.35, size * 0.32).fill();
      doc
        .moveTo(cx - size * 0.15, y + size * 0.55)
        .lineTo(cx, y + size)
        .lineTo(cx + size * 0.15, y + size * 0.55)
        .fill();
      doc
        .fillColor(WHITE)
        .circle(cx, y + size * 0.35, size * 0.13)
        .fill();
      break;
    case 'globe':
      doc.circle(cx, y + size / 2, size / 2).stroke();
      doc
        .moveTo(x, y + size / 2)
        .lineTo(x + size, y + size / 2)
        .stroke();
      doc.ellipse(cx, y + size / 2, size * 0.22, size / 2).stroke();
      break;
    case 'phone':
      doc.roundedRect(x + size * 0.28, y, size * 0.44, size, 2).fill();
      break;
  }
  doc.restore();
}

// ── Top Brand Header Block ────────────────────────────────────────────────
function drawInvoiceHeader(
  doc: PdfDoc,
  invoiceNumber: string,
  generatedDate: string,
): void {
  const startY = doc.y;
  const logoX = 46;
  const logoSize = 30;

  // Embedded Ctasis / ScanFlow Logo
  try {
    const logoBuffer = Buffer.from(LOGO_BASE64, 'base64');
    doc.image(logoBuffer, logoX, startY, { width: logoSize, height: logoSize });
  } catch {
    doc
      .save()
      .circle(logoX + 15, startY + 15, 15)
      .fill(BRAND_DARK)
      .restore();
  }

  // ScanFlow Wordmark
  const wordmarkX = logoX + logoSize + 9;
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .fillColor(BRAND_DARK)
    .text('Scan', wordmarkX, startY, { continued: true });
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .fillColor(BRAND_COLOR)
    .text('Flow', { continued: false });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(TEXT_MUTED)
    .text(
      'Smart Barcode & Warehouse Tracking Platform',
      wordmarkX,
      startY + 26,
    );

  // Right Side: INVOICE / Invoice Number / Date
  const rightWidth = 240;
  const rightX = doc.page.width - 46 - rightWidth;
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .fillColor(TEXT_PRIMARY)
    .text('INVOICE', rightX, startY - 2, { width: rightWidth, align: 'right' });
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(BRAND_COLOR)
    .text(invoiceNumber, rightX, startY + 24, {
      width: rightWidth,
      align: 'right',
    });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(TEXT_MUTED)
    .text(`Generated: ${generatedDate}`, rightX, startY + 41, {
      width: rightWidth,
      align: 'right',
    });

  // Two-tone decorative separator line
  const sepY = startY + logoSize + 22;
  doc
    .save()
    .moveTo(46, sepY)
    .lineTo(doc.page.width - 46, sepY)
    .lineWidth(1.2)
    .strokeColor(BRAND_COLOR)
    .stroke()
    .restore();

  doc.y = sepY + 12;
}

// ── Billed To & Invoice Details Side-by-Side Cards ────────────────────────
interface BilledToInfo {
  name: string;
  email: string;
  company?: string;
  phone?: string;
  location?: string;
}

interface DetailLine {
  label: string;
  value: string;
  isStatus?: boolean;
}

function drawBilledToAndDetails(
  doc: PdfDoc,
  billedTo: BilledToInfo,
  details: DetailLine[],
): void {
  const startX = 46;
  const gap = 16;
  const totalWidth = doc.page.width - 92;
  const leftWidth = totalWidth * 0.44;
  const rightWidth = totalWidth - leftWidth - gap;
  const rightX = startX + leftWidth + gap;
  const startY = doc.y;

  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(BRAND_DARK)
    .text('BILLED TO', startX, startY);

  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(BRAND_DARK)
    .text('INVOICE DETAILS', rightX, startY);

  const cardStartY = startY + 13;

  const rows: { icon: IconType; text: string; bold?: boolean }[] = [
    {
      icon: 'person',
      text: billedTo.name || 'Organization Client',
      bold: true,
    },
    { icon: 'mail', text: billedTo.email || '—' },
  ];
  if (billedTo.company && billedTo.company !== billedTo.name) {
    rows.push({ icon: 'building', text: billedTo.company });
  }
  if (billedTo.phone) {
    rows.push({ icon: 'phone', text: billedTo.phone });
  }
  if (billedTo.location) {
    rows.push({ icon: 'pin', text: billedTo.location });
  }

  const rowHeight = 17;
  const leftCardHeight = 16 + rows.length * rowHeight;
  const rightRowHeight = 18;
  const rightCardHeight = 16 + details.length * rightRowHeight;
  const cardHeight = Math.max(leftCardHeight, rightCardHeight, 92);

  // Background Containers
  doc
    .save()
    .roundedRect(startX, cardStartY, leftWidth, cardHeight, 6)
    .fillAndStroke(SURFACE_COLOR, BORDER_COLOR)
    .restore();

  doc
    .save()
    .roundedRect(rightX, cardStartY, rightWidth, cardHeight, 6)
    .fillAndStroke(SURFACE_COLOR, BORDER_COLOR)
    .restore();

  // Draw Left Card Content
  let ly = cardStartY + 10;
  rows.forEach((row) => {
    drawIcon(doc, row.icon, startX + 12, ly + 1, 9, BRAND_COLOR);
    doc
      .font(row.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(8.5)
      .fillColor(row.bold ? TEXT_PRIMARY : TEXT_SECONDARY)
      .text(row.text, startX + 26, ly, { width: leftWidth - 36 });
    ly += rowHeight;
  });

  // Draw Right Card Content
  let ry = cardStartY + 10;
  details.forEach((d) => {
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(TEXT_MUTED)
      .text(d.label, rightX + 12, ry, { width: rightWidth * 0.44 });

    if (d.isStatus) {
      const pillWidth = 44;
      const pillHeight = 13;
      const pillX = rightX + rightWidth - 12 - pillWidth;
      doc
        .save()
        .roundedRect(pillX, ry - 1, pillWidth, pillHeight, 3)
        .fill('#ECFDF5')
        .restore();
      doc
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .fillColor(SUCCESS_GREEN)
        .text('PAID', pillX, ry + 1, { width: pillWidth, align: 'center' });
    } else {
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(TEXT_PRIMARY)
        .text(d.value || '—', rightX + rightWidth * 0.44, ry, {
          width: rightWidth - rightWidth * 0.44 - 12,
          align: 'right',
        });
    }
    ry += rightRowHeight;
  });

  doc.y = cardStartY + cardHeight + 14;
}

// ── Subscription Summary Band ─────────────────────────────────────────────
function drawSummaryBand(doc: PdfDoc, title: string, rows: DetailLine[]): void {
  const startX = 46;
  const width = doc.page.width - 92;
  const bandHeight = 22;
  const startY = doc.y;

  // Solid Brand Navy Header
  doc
    .save()
    .roundedRect(startX, startY, width, bandHeight, 5)
    .fill(BRAND_DARK)
    .restore();
  doc
    .save()
    .rect(startX, startY + bandHeight / 2, width, bandHeight / 2)
    .fill(BRAND_DARK)
    .restore();

  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(WHITE)
    .text(title.toUpperCase(), startX + 14, startY + 6);

  let y = startY + bandHeight;
  const rowHeight = 22;

  rows.forEach((row, i) => {
    const isLast = i === rows.length - 1;
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(TEXT_MUTED)
      .text(row.label, startX + 14, y + 6, { width: width * 0.5 });
    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(TEXT_PRIMARY)
      .text(row.value || '—', startX + width * 0.5, y + 6, {
        width: width * 0.5 - 14,
        align: 'right',
      });

    if (!isLast) {
      doc
        .save()
        .moveTo(startX, y + rowHeight)
        .lineTo(startX + width, y + rowHeight)
        .lineWidth(0.5)
        .strokeColor(BORDER_COLOR)
        .stroke()
        .restore();
    }
    y += rowHeight;
  });

  doc
    .save()
    .roundedRect(startX, startY, width, y - startY, 5)
    .lineWidth(0.75)
    .strokeColor(BORDER_COLOR)
    .stroke()
    .restore();

  doc.y = y + 14;
}

// ── Line Items Table with Subtotal & Total Paid ───────────────────────────
interface LineItem {
  description: string;
  subDescription?: string;
  amount: string;
}

function drawLineItemsTable(
  doc: PdfDoc,
  items: LineItem[],
  totals: { subtotal: string; taxLabel: string; tax: string; total: string },
): void {
  const startX = 46;
  const width = doc.page.width - 92;
  const amountColWidth = 140;
  const descColWidth = width - amountColWidth;
  const headerHeight = 23;
  const tableTop = doc.y;
  let y = tableTop;

  // Dark table header
  doc.save().rect(startX, y, width, headerHeight).fill(BRAND_DARK).restore();
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(WHITE)
    .text('DESCRIPTION', startX + 14, y + 7);
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(WHITE)
    .text('AMOUNT', startX + descColWidth, y + 7, {
      width: amountColWidth - 14,
      align: 'right',
    });
  y += headerHeight;

  // Line items
  items.forEach((item) => {
    const itemHeight = item.subDescription ? 30 : 22;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(TEXT_PRIMARY)
      .text(item.description, startX + 14, y + 6, { width: descColWidth - 24 });

    if (item.subDescription) {
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(TEXT_MUTED)
        .text(item.subDescription, startX + 14, y + 18, {
          width: descColWidth - 24,
        });
    }

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(TEXT_PRIMARY)
      .text(
        item.amount,
        startX + descColWidth,
        y + (item.subDescription ? 10 : 6),
        {
          width: amountColWidth - 14,
          align: 'right',
        },
      );

    doc
      .save()
      .moveTo(startX, y + itemHeight)
      .lineTo(startX + width, y + itemHeight)
      .lineWidth(0.4)
      .strokeColor(BORDER_COLOR)
      .stroke()
      .restore();

    y += itemHeight;
  });

  // Subtotal row
  const rowH = 20;
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(TEXT_PRIMARY)
    .text('Subtotal', startX + 14, y + 5, { width: descColWidth - 24 });
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(TEXT_PRIMARY)
    .text(totals.subtotal, startX + descColWidth, y + 5, {
      width: amountColWidth - 14,
      align: 'right',
    });
  doc
    .save()
    .moveTo(startX, y + rowH)
    .lineTo(startX + width, y + rowH)
    .lineWidth(0.4)
    .strokeColor(BORDER_COLOR)
    .stroke()
    .restore();
  y += rowH;

  // Tax row
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(TEXT_MUTED)
    .text(totals.taxLabel, startX + 14, y + 5, { width: descColWidth - 24 });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(TEXT_MUTED)
    .text(totals.tax, startX + descColWidth, y + 5, {
      width: amountColWidth - 14,
      align: 'right',
    });
  doc
    .save()
    .moveTo(startX, y + rowH)
    .lineTo(startX + width, y + rowH)
    .lineWidth(0.4)
    .strokeColor(BORDER_COLOR)
    .stroke()
    .restore();
  y += rowH;

  // Highlighted Total Paid row
  const totalH = 24;
  doc.save().rect(startX, y, width, totalH).fill(TOTAL_ROW_BG).restore();
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(BRAND_COLOR)
    .text('TOTAL PAID', startX + 14, y + 7, { width: descColWidth - 24 });
  doc
    .font('Helvetica-Bold')
    .fontSize(10.5)
    .fillColor(BRAND_COLOR)
    .text(totals.total, startX + descColWidth, y + 7, {
      width: amountColWidth - 14,
      align: 'right',
    });
  y += totalH;

  // Outer border
  doc
    .save()
    .rect(startX, tableTop, width, y - tableTop)
    .lineWidth(0.75)
    .strokeColor(BORDER_COLOR)
    .stroke()
    .restore();

  doc.y = y + 14;
}

// ── Thank You & Verification Badge Card ───────────────────────────────────
function drawThankYouCard(
  doc: PdfDoc,
  opts: {
    message: string;
    subMessage: string;
    signatureName: string;
    signatureRole: string;
  },
): void {
  const startX = 46;
  const width = doc.page.width - 92;
  const startY = doc.y;
  const cardHeight = 56;

  doc
    .save()
    .roundedRect(startX, startY, width, cardHeight, 6)
    .lineWidth(0.75)
    .strokeColor(BORDER_COLOR)
    .stroke()
    .restore();

  const badgeX = startX + 18;
  const badgeY = startY + 18;
  doc.save().circle(badgeX, badgeY, 11).fill(SUCCESS_GREEN).restore();
  doc
    .save()
    .lineWidth(1.8)
    .strokeColor(WHITE)
    .moveTo(badgeX - 4.5, badgeY)
    .lineTo(badgeX - 1, badgeY + 4)
    .lineTo(badgeX + 5.5, badgeY - 4.5)
    .stroke()
    .restore();

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(BRAND_DARK)
    .text(opts.message, startX + 36, startY + 11, { width: width - 190 });
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(TEXT_MUTED)
    .text(opts.subMessage, startX + 36, startY + 25, { width: width - 190 });

  const sigWidth = 150;
  const sigX = startX + width - sigWidth - 14;
  doc
    .font('Times-Italic')
    .fontSize(14)
    .fillColor(TEXT_PRIMARY)
    .text(opts.signatureName, sigX, startY + 13, {
      width: sigWidth,
      align: 'right',
    });
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(TEXT_MUTED)
    .text(opts.signatureRole, sigX, startY + 31, {
      width: sigWidth,
      align: 'right',
    });

  doc.y = startY + cardHeight + 14;
}

// ── Three-Column Invoice Footer ───────────────────────────────────────────
interface FooterCompanyInfo {
  website: string;
  supportEmail: string;
  phone: string;
  legalName: string;
  addressLines: string[];
}

function drawInvoiceFooterBlock(doc: PdfDoc, company: FooterCompanyInfo): void {
  const startX = 46;
  const width = doc.page.width - 92;
  const startY = doc.y;

  doc
    .save()
    .moveTo(startX, startY)
    .lineTo(startX + width, startY)
    .lineWidth(0.5)
    .strokeColor(BORDER_COLOR)
    .stroke()
    .restore();

  const colY = startY + 10;
  const colWidth = width / 3;

  // Left column: Contact info
  const leftRows: { icon: IconType; text: string }[] = [
    { icon: 'globe', text: company.website || 'https://scanflow.app' },
    { icon: 'mail', text: company.supportEmail || 'info@ctasis.com' },
    { icon: 'phone', text: company.phone || '+91 7948993409' },
  ];
  let ly = colY;
  leftRows.forEach((row) => {
    drawIcon(doc, row.icon, startX, ly + 1, 8, TEXT_MUTED);
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(TEXT_MUTED)
      .text(row.text, startX + 12, ly, { width: colWidth - 20 });
    ly += 13;
  });

  // Center column: Logo & Wordmark
  const logoSize = 20;
  const colCenterX = startX + colWidth * 1.5;
  const logoX = colCenterX - logoSize / 2;
  try {
    const logoBuffer = Buffer.from(LOGO_BASE64, 'base64');
    doc.image(logoBuffer, logoX, colY, { width: logoSize, height: logoSize });
  } catch {
    doc
      .save()
      .circle(colCenterX, colY + 10, 10)
      .fill(BRAND_DARK)
      .restore();
  }

  const textY = colY + logoSize + 4;
  doc.font('Helvetica-Bold').fontSize(9);
  const scanW = doc.widthOfString('Scan');
  const flowW = doc.widthOfString('Flow');
  const wordmarkStartX = colCenterX - (scanW + flowW) / 2;
  doc
    .fillColor(BRAND_DARK)
    .text('Scan', wordmarkStartX, textY, { continued: true });
  doc.fillColor(BRAND_COLOR).text('Flow', { continued: false });

  // Right column: Legal Entity & Address
  const rightX = startX + colWidth * 2;
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(TEXT_PRIMARY)
    .text(company.legalName || 'ScanFlow Technologies, Inc.', rightX, colY, {
      width: colWidth,
      align: 'right',
    });

  const addressY = doc.y + 2;
  const addressText = company.addressLines.filter(Boolean).join('\n');
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(TEXT_MUTED)
    .text(addressText, rightX, addressY, { width: colWidth, align: 'right' });

  const endY = Math.max(ly, textY + 12, doc.y);
  doc.y = endY + 8;
}

// ── Small Disclaimer Bar at the Bottom ────────────────────────────────────
function drawDisclaimerBar(doc: PdfDoc, text: string): void {
  const startX = 46;
  const width = doc.page.width - 92;
  const startY = doc.y;
  const height = 18;

  doc
    .save()
    .roundedRect(startX, startY, width, height, 3)
    .fill(SURFACE_COLOR)
    .restore();

  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor(TEXT_MUTED)
    .text(text, startX, startY + 5, { width, align: 'center' });

  doc.y = startY + height;
}

// ── Main Invoice PDF Generation ───────────────────────────────────────────
interface InvoiceRenderData {
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
  transactionId?: string | null;
  startedAt?: Date | null;
  expiresAt?: Date | null;
  featuresSummary?: string | null;
}

export const renderInvoicePdf = async (
  data: InvoiceRenderData,
): Promise<Buffer> => {
  const webSettings = await getWebSettings().catch(() => null);

  const company = webSettings?.company;
  const contact = webSettings?.contact;

  const legalName = company?.name
    ? `${company.name.charAt(0).toUpperCase() + company.name.slice(1)} Technologies, Inc.`
    : 'ScanFlow Technologies, Inc.';
  const website = company?.website || 'https://scanflow.app';
  const supportEmail = contact?.email || 'info@ctasis.com';
  const phone = contact?.phone || '+91 7948993409';

  const addressLines: string[] = [];
  if (contact?.address) addressLines.push(contact.address);
  const cityStatePostal = [contact?.city, contact?.state, contact?.postal_code]
    .filter(Boolean)
    .join(', ');
  if (cityStatePostal) addressLines.push(cityStatePostal);
  if (contact?.country) addressLines.push(contact.country);
  if (addressLines.length === 0) {
    addressLines.push('Money Plant High Street, Jagatpur Rd');
    addressLines.push('Ahmedabad, Gujarat 382470');
    addressLines.push('India');
  }

  const issuedDateStr = formatInvoiceDate(data.issuedAt);
  const billingCycleLabel = formatBillingCycle(data.billingCycle);

  // Calculate start & end date
  const startDate = data.startedAt || data.issuedAt || new Date();
  let endDate = data.expiresAt;
  if (!endDate) {
    const end = new Date(startDate);
    if (data.billingCycle === 'quarterly') {
      end.setMonth(end.getMonth() + 3);
    } else {
      end.setMonth(end.getMonth() + 1);
    }
    endDate = end;
  }
  const periodText = `${formatInvoiceDate(startDate)} — ${formatInvoiceDate(endDate)}`;

  const amountFormatted = formatCurrency(data.amount, data.currency);
  const paymentMethod = formatGateway(data.gateway);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 46,
      info: {
        Title: `ScanFlow Invoice ${data.invoiceNumber}`,
        Author: 'ScanFlow Technologies, Inc.',
        Subject: `${data.planName} Plan Subscription Invoice`,
        Keywords: 'ScanFlow, Invoice, Barcode Scanner, Subscription',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // 1. Top Brand Header
    drawInvoiceHeader(doc, data.invoiceNumber, issuedDateStr);

    // 2. Billed To & Invoice Details Cards
    const detailRows: DetailLine[] = [
      { label: 'Invoice Date', value: issuedDateStr },
      { label: 'Billing Period', value: periodText },
      { label: 'Payment Method', value: paymentMethod },
    ];
    if (data.transactionId && data.transactionId.trim() !== '') {
      detailRows.push({ label: 'Transaction ID', value: data.transactionId });
    }
    detailRows.push({ label: 'Status', value: 'PAID', isStatus: true });
    detailRows.push({ label: 'Amount Paid', value: amountFormatted });

    drawBilledToAndDetails(
      doc,
      {
        name: data.billedTo?.companyName || 'Valued Client',
        email: data.billedTo?.email || '—',
        company: data.billedTo?.companyName,
        phone: data.billedTo?.contactNumber,
        location: data.billedTo?.countryName,
      },
      detailRows,
    );

    // 3. Subscription Summary Band
    const summaryRows: DetailLine[] = [
      { label: 'Subscribed Plan', value: `${data.planName || 'Active'} Plan` },
      { label: 'Billing Cycle', value: `${billingCycleLabel} Subscription` },
      { label: 'Subscription Validity', value: periodText },
    ];
    if (data.featuresSummary) {
      summaryRows.push({ label: 'Plan Features', value: data.featuresSummary });
    }
    drawSummaryBand(doc, 'Subscription Summary', summaryRows);

    // 4. Line Items Table
    drawLineItemsTable(
      doc,
      [
        {
          description: `${data.planName || 'Subscription'} Plan — ${billingCycleLabel} Plan`,
          subDescription:
            'Full enterprise access to ScanFlow barcode scanner engine, live dashboard & cloud APIs',
          amount: amountFormatted,
        },
      ],
      {
        subtotal: amountFormatted,
        taxLabel: 'Tax (0% — Tax Exempt)',
        tax: formatCurrency(0, data.currency),
        total: amountFormatted,
      },
    );

    // 5. Thank You & Verification Card
    drawThankYouCard(doc, {
      message: 'Payment Verified — Thank you for your business!',
      subMessage:
        'We appreciate your trust in ScanFlow. If you have questions about your billing, our support team is here to help.',
      signatureName: 'ScanFlow Team',
      signatureRole: 'Accounts & Billing Department',
    });

    // 6. Three-Column Footer Block
    drawInvoiceFooterBlock(doc, {
      website,
      supportEmail,
      phone,
      legalName,
      addressLines,
    });

    // 7. Electronic Disclaimer
    drawDisclaimerBar(
      doc,
      'This is an electronically generated invoice and does not require a physical signature. Issued under ScanFlow Terms of Service.',
    );

    doc.end();
  });
};

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

  // Look up matching subscription for exact started_at and expires_at
  const subscription = await Subscription.findOne({
    $or: [
      { payment_id: payment._id },
      { organization_id: payment.organization_id, plan_id: payment.plan_id },
    ],
  }).sort({ created_at: -1 });

  const invoiceNumber =
    payment.invoice_number ??
    `INV-${String(payment._id).slice(-8).toUpperCase()}`;

  const planName =
    (payment.plan_id as any)?.name ??
    subscription?.plan_name ??
    'ScanFlow Subscription';

  // Build features summary if features exist
  let featuresSummary: string | null = null;
  if (subscription?.features && subscription.features.length > 0) {
    featuresSummary = subscription.features
      .map(
        (f) =>
          `${f.features_name}: ${f.scan_limit > 0 ? f.scan_limit.toLocaleString('en-IN') : 'Unlimited'}`,
      )
      .join(' · ');
  }

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
    planName,
    billingCycle: payment.billing_cycle,
    amount: payment.price ?? 0,
    currency: payment.currency_code ?? 'inr',
    gateway: payment.gateway ?? null,
    transactionId: payment.transaction_id || payment.order_id || null,
    startedAt:
      subscription?.started_at ?? payment.paid_at ?? payment.created_at,
    expiresAt: subscription?.expires_at ?? null,
    featuresSummary,
  });

  return { buffer, invoice_number: invoiceNumber };
};
