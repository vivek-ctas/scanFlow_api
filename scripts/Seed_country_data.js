// One-time script: world na badhi countries MongoDB ma insert kare che
// Collection: tbl_country_data  |  Fields: country_name, country_code, currency_code

import 'dotenv/config';
import { MongoClient } from 'mongodb';
const MONGODB_URL =
    process.env.MONGODB_URL || 'mongodb://localhost:27017/db_scanflow';
const COLLECTION = 'tbl_country_data';
const API_URL =
    'https://raw.githubusercontent.com/mledoze/countries/master/countries.json';

async function fetchCountries() {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`API failed: ${res.status} ${res.statusText}`);
    const data = await res.json();

    if (!Array.isArray(data)) {
        throw new Error('API response is not an array of countries');
    }

    return data
        .map((c) => ({
            country_name: c.name?.common,
            country_code: c.cca3, // ISO 3166-1 alpha-3 (e.g. IND, USA)
            currency_code: c.currencies ? Object.keys(c.currencies)[0] : null, // e.g. INR, USD
        }))
        .filter((c) => c.country_name && c.country_code)
        .sort((a, b) => a.country_name.localeCompare(b.country_name));
}

async function main() {
    const client = new MongoClient(MONGODB_URL);

    try {
        const countries = await fetchCountries();
        console.log(`Fetched ${countries.length} countries from API`);

        await client.connect();
        const col = client.db().collection(COLLECTION); // db name URL mathi (db_scanflow) aavse

        await col.createIndex({ country_code: 1 }, { unique: true });

        // upsert -> script ne farithi run karo to duplicate nahi thay
        const result = await col.bulkWrite(
            countries.map((c) => ({
                updateOne: {
                    filter: { country_code: c.country_code },
                    update: { $set: c },
                    upsert: true,
                },
            })),
        );

        console.log(
            `Done. Inserted: ${result.upsertedCount}, Updated: ${result.modifiedCount}`,
        );
        console.log(`Total in ${COLLECTION}: ${await col.countDocuments()}`);
    } catch (err) {
        console.error('Script failed:', err.message);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

main();