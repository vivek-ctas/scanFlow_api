/**
 * One-time migration: seed country `aliases` and normalize stored country names.
 *
 * `tbl_country_data` was seeded from current ISO-3166 names ("Türkiye",
 * "Eswatini", "Côte d'Ivoire"), but organizations and admin users saved earlier
 * may still hold the previous official name or a common English spelling
 * ("Turkey", "Swaziland", "Ivory Coast"). Nothing in the database relates those
 * two spellings, so the customer dropdown rendered blank for those records.
 *
 * Rather than hardcoding that mapping in the panel, it is stored as data on the
 * country row itself. `resolveCountry` then matches incoming values against the
 * canonical name, the code, or any alias, so renaming a country later is a data
 * change rather than a code change.
 *
 * Step 1 merges the alias table below into each country's `aliases` array,
 * preserving aliases that are already present.
 * Step 2 rewrites `country_name` on `tbl_organization` and `tbl_user` to the
 * canonical name wherever the current value resolves to a known country.
 *
 * Values that resolve to nothing are reported and left untouched, never cleared:
 * a genuinely unknown country is a data question for a human, not something a
 * migration should destroy.
 *
 * Safe to re-run: aliases are merged (union), and step 2 only writes when the
 * resolved name differs from the stored one.
 *
 * Run: npm run migrate:country-aliases
 */
import mongoose from 'mongoose';
import config from '../config/config.js';
import { Country } from '../models/country.model.js';
import { Organization } from '../models/organization.model.js';
import { User } from '../models/user.model.js';
import { resolveCountry } from '../services/country-resolver.service.js';

// Previous official ISO names and widely used English spellings, keyed by the
// country code of the modern entry.
const ALIASES_BY_CODE: Record<string, string[]> = {
  USA: ['United States of America', 'America'],
  TUR: ['Turkey'],
  CZE: ['Czech Republic'],
  CIV: ["Cote d'Ivoire", 'Cote divoire', 'Ivory Coast'],
  SWZ: ['Swaziland'],
  MMR: ['Burma', 'Myanmar (Burma)'],
  MKD: ['Macedonia', 'The former Yugoslav Republic of Macedonia'],
  CPV: ['Cape Verde'],
  TLS: ['East Timor'],
  VAT: ['Holy See', 'Vatican', 'Vatican City'],
  RUS: ['Russian Federation'],
  VNM: ['Viet Nam'],
  SYR: ['Syrian Arab Republic'],
  BOL: ['Bolivia, Plurinational State of', 'Bolivia'],
  MDA: ['Republic of Moldova', 'Moldova'],
  LAO: [
    "Lao People's Democratic Republic",
    'Lao Peoples Democratic Republic',
    'Laos',
  ],
  IRN: ['Iran, Islamic Republic of'],
  KOR: ['Republic of Korea', 'South Korea'],
  TZA: ['United Republic of Tanzania', 'Tanzania'],
  VEN: ['Bolivarian Republic of Venezuela', 'Venezuela'],
  BRN: ['Brunei Darussalam'],
  HKG: ['Hong Kong SAR China', 'Hong Kong'],
  MAC: ['Macao SAR China', 'Macao', 'Macau'],
  TWN: ['Taiwan, Province of China', 'Taiwan'],
  GBR: [
    'United Kingdom of Great Britain and Northern Ireland',
    'Great Britain',
    'UK',
  ],
  ESH: ['Western Sahara'],
  BIH: ['Bosnia and Herzegovina'],
  PRK: ["Democratic People's Republic of Korea", 'North Korea'],
  TTO: ['Trinidad and Tobago'],
  VUT: ['Vanuatu'],
  ZMB: ['Zambia'],
  COG: ['Congo', 'Republic of the Congo'],
  COD: ['Democratic Republic of the Congo', 'Congo-Kinshasa'],
  CAF: ['Central African Republic'],
  DOM: ['Dominican Republic'],
  TKM: ['Turkmenistan'],
  MNG: ['Mongolia'],
};

const normalizeKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,()]/g, '')
    .replace(/\s+/g, ' ');

const uniqueAliases = (values: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = normalizeKey(trimmed);
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
};

const seedAliases = async () => {
  let merged = 0;
  const unmatchedCodes: string[] = [];

  for (const [code, aliases] of Object.entries(ALIASES_BY_CODE)) {
    if (!aliases.length) continue;
    const country = await Country.findOne({
      country_code: new RegExp(`^${code}$`, 'i'),
    });
    if (!country) {
      unmatchedCodes.push(code);
      continue;
    }
    const mergedAliases = uniqueAliases([
      ...(country.aliases ?? []),
      ...aliases,
    ]);
    if (mergedAliases.length !== (country.aliases ?? []).length) {
      country.aliases = mergedAliases;
      await country.save();
      merged += 1;
    }
  }

  console.log(
    `[MIGRATE] step 1 -> aliases merged into ${merged} country row(s).`,
  );
  if (unmatchedCodes.length) {
    console.log(
      '[MIGRATE] note: these codes have no row in tbl_country_data and were skipped:',
    );
    for (const code of unmatchedCodes) console.log(`[MIGRATE]   - ${code}`);
  }
};

const normalizeStores = async () => {
  let orgFixed = 0;
  let userFixed = 0;
  const unresolved = new Set<string>();

  const orgs = await Organization.find({
    country_name: { $nin: [null, ''] },
  }).select('country_name');
  for (const org of orgs) {
    const current = org.country_name as string;
    const country = await resolveCountry(current);
    if (country && country.country_name !== current) {
      org.country_name = country.country_name;
      await org.save();
      orgFixed += 1;
    } else if (!country) {
      unresolved.add(current);
    }
  }

  const users = await User.find({
    country_name: { $nin: [null, ''] },
  }).select('country_name');
  for (const user of users) {
    const current = user.country_name as string;
    const country = await resolveCountry(current);
    if (country && country.country_name !== current) {
      user.country_name = country.country_name;
      await user.save();
      userFixed += 1;
    } else if (!country) {
      unresolved.add(current);
    }
  }

  console.log(
    `[MIGRATE] step 2 -> normalized ${orgFixed} organization(s) and ${userFixed} admin user(s).`,
  );
  if (unresolved.size) {
    console.log(
      '[MIGRATE] note: these stored countries match no known country and were left unchanged:',
    );
    for (const value of unresolved) console.log(`[MIGRATE]   - ${value}`);
  }
};

const run = async () => {
  await mongoose.connect(config.mongoose.url);
  console.log('[MIGRATE] connected.');

  await seedAliases();
  await normalizeStores();

  await mongoose.disconnect();
  console.log('[MIGRATE] done.');
};

run().catch(async (err) => {
  console.error('[MIGRATE] failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
