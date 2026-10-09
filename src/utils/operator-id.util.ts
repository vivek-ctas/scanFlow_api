import mongoose from 'mongoose';
import { Organization } from '../models/index.js';

const SEQ_BASE = 1000;

/** Simple prefix: first 2 letters/digits of the company name, uppercased. */
export const deriveOperatorPrefix = (companyName?: string | null): string => {
  const normalized = String(companyName ?? '')
    .trim()
    .toUpperCase();
  const letters = normalized.replace(/[^A-Z0-9]/g, '');
  if (letters.length < 2) return 'XX';
  return letters.slice(0, 2);
};

/**
 * Atomically reserve the next per-organization operator number.
 * The counter lives on the organization document (`operator_seq`), so ids
 * look like `LL1001`, `LL1002` ... under any concurrency.
 */
export const nextOperatorNumber = async (
  organizationId: mongoose.Types.ObjectId | string,
): Promise<number> => {
  const doc = await Organization.findByIdAndUpdate(
    organizationId,
    { $inc: { operator_seq: 1 } },
    { returnDocument: 'after' },
  );
  return Number(doc?.operator_seq ?? SEQ_BASE + 1);
};

export const buildOperatorId = async (
  companyName: string | null | undefined,
  organizationId: mongoose.Types.ObjectId | string,
): Promise<string> => {
  const number = await nextOperatorNumber(organizationId);
  return `${deriveOperatorPrefix(companyName)}${number}`;
};
