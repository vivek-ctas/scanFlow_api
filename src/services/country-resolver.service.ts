import { Country, ICountry } from '../models/country.model.js';

/**
 * Folds a country label to a comparable key: trimmed, lowercased, accents
 * stripped. This handles pure formatting differences ("Cote d'Ivoire" vs
 * "Côte d'Ivoire", extra padding). Genuine renames are resolved through the
 * `aliases` column instead, so they stay a data concern.
 */
const normalizeCountryKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,()]/g, '')
    .replace(/\s+/g, ' ');

const isBlank = (value?: string | null) => !value || !value.trim();

/**
 * Resolves a caller-supplied country to the canonical row in `tbl_country_data`.
 * Accepts the canonical name, a `country_code` (e.g. `USA`), or any stored alias,
 * and returns the document so callers persist `country_name` rather than the raw
 * input. Returns `null` when the value is blank or matches nothing, leaving the
 * caller's existing value untouched rather than writing an unknown country.
 */
export const resolveCountry = async (
  input?: string | null,
): Promise<ICountry | null> => {
  if (isBlank(input)) return null;

  const raw = String(input).trim();
  const key = normalizeCountryKey(raw);

  const byCode = await Country.findOne({ country_code: raw.toUpperCase() });
  if (byCode) return byCode;

  const candidates = await Country.find({
    $or: [{ country_name: raw }, { aliases: raw }],
  });

  const exact = candidates.find(
    (c) =>
      normalizeCountryKey(c.country_name) === key ||
      (c.aliases ?? []).some((a) => normalizeCountryKey(a) === key),
  );
  if (exact) return exact;

  // Fall back to a normalized scan so punctuation/accent variants still resolve
  // without storing every spelling as an alias.
  const all = await Country.find({});
  return (
    all.find(
      (c) =>
        normalizeCountryKey(c.country_name) === key ||
        (c.aliases ?? []).some((a) => normalizeCountryKey(a) === key) ||
        normalizeCountryKey(c.country_code) === key,
    ) ?? null
  );
};

/**
 * Canonical `country_name` for a caller-supplied value, or `undefined` when the
 * value is blank or unrecognised. Use this on write paths so a stored customer
 * always carries a name that the country API can list.
 */
export const resolveCountryName = async (
  input?: string | null,
): Promise<string | undefined> => {
  const country = await resolveCountry(input);
  return country?.country_name;
};
