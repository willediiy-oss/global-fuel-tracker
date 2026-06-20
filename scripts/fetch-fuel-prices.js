/**
 * scripts/fetch-fuel-prices.js
 * ---------------------------------------------------------------------------
 * Daily Fuel Price Sync
 *
 * Fetches real-time global fuel prices from a third-party API and upserts
 * the records into a Supabase (PostgreSQL) database. Designed to run
 * headlessly inside GitHub Actions (see .github/workflows/daily-fuel-sync.yml)
 * but works the same way when run locally.
 *
 * Local usage:
 *   SUPABASE_URL=... \
 *   SUPABASE_ANON_KEY=... \
 *   FUEL_API_KEY=... \
 *   node scripts/fetch-fuel-prices.js
 *
 * Required environment variables:
 *   SUPABASE_URL       - Your Supabase project URL
 *   SUPABASE_ANON_KEY  - Supabase key with insert/update rights on the table
 *   FUEL_API_KEY       - API key for your fuel price provider
 *
 * Optional environment variables:
 *   FUEL_API_URL       - Override the fuel price API endpoint
 *   FUEL_AUTH_SCHEME   - Override the auth header scheme (default: "apikey")
 *   SUPABASE_TABLE     - Override the destination table name (default: fuel_prices)
 *
 * ---------------------------------------------------------------------------
 * DEFAULT PROVIDER: CollectAPI "Gas Price" API
 * ---------------------------------------------------------------------------
 * This script is wired up by default for CollectAPI's Gas Price API
 * (https://collectapi.com/api/gasPrice/gas-prices-api), which has real,
 * instant-signup keys and returns clean JSON. Coverage: European countries,
 * US states, and Canada (NOT every country on Earth — no free/instant-signup
 * provider I found genuinely covers all ~195 countries; the one that does,
 * GlobalPetrolPrices.com, is sales-gated and returns XML rather than JSON).
 *
 * To use it:
 *   1. Sign up free at https://collectapi.com
 *   2. Find "Gas Price" in your API key dashboard and copy the full
 *      authorization value (format: "apikey PUBLICKEY:PRIVATEKEY")
 *   3. Set FUEL_API_KEY to everything AFTER "apikey " (the PUBLICKEY:PRIVATEKEY part)
 *   4. Pick an endpoint and set it as FUEL_API_URL, e.g.:
 *        https://api.collectapi.com/gasPrice/europeanCountries
 *        https://api.collectapi.com/gasPrice/stateUsaPrice?state=CA
 *
 * Example europeanCountries response (note: comma decimals, "-" = no data):
 *   { "results": [
 *       { "country": "Germany", "currency": "euro", "gasoline": "1,714", "diesel": "1,759", "lpg": "0,679" },
 *       { "country": "Andorra", "currency": "euro", "gasoline": "1,445", "diesel": "1,387", "lpg": "-" }
 *   ] }
 *
 * If you swap providers later, only fetchFuelPrices() (response unwrapping)
 * and transformRecords() (field mapping) need to change — everything else
 * (config loading, Supabase upsert, error handling) stays the same.
 *
 * Expected Supabase table: `fuel_prices`
 *   id            bigint generated always as identity primary key
 *   country       text not null
 *   fuel_type     text not null
 *   price         numeric not null
 *   currency      text
 *   price_date    date not null
 *   raw_payload   jsonb
 *   updated_at    timestamptz default now()
 *
 *   For the "insert new / overwrite today's entry" upsert behavior to work,
 *   add a unique constraint so Postgres knows which column combination
 *   identifies a single day's price for a given country + fuel type:
 *
 *     alter table fuel_prices
 *       add constraint fuel_prices_unique_entry
 *       unique (country, fuel_type, price_date);
 *
 * ---------------------------------------------------------------------------
 */

'use strict';

// ---------------------------------------------------------------------------
// WebSocket fallback
// ---------------------------------------------------------------------------
if (typeof globalThis.WebSocket === 'undefined') {
  // eslint-disable-next-line global-require
  const WebSocket = require('ws');
  globalThis.WebSocket = WebSocket;
}

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadConfig() {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    FUEL_API_KEY,
    FUEL_API_URL,
    FUEL_AUTH_SCHEME,
    SUPABASE_TABLE,
  } = process.env;

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (!FUEL_API_KEY) missing.push('FUEL_API_KEY');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  return {
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    fuelApiKey: FUEL_API_KEY,
    fuelApiUrl: FUEL_API_URL || 'https://api.collectapi.com/gasPrice/europeanCountries',
    fuelAuthScheme: FUEL_AUTH_SCHEME || 'apikey',
    fuelTable: SUPABASE_TABLE || 'fuel_prices',
  };
}

function initSupabaseClient(config) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

async function fetchFuelPrices(config) {
  console.log(`Fetching fuel price data from ${config.fuelApiUrl} ...`);

  const response = await axios.get(config.fuelApiUrl, {
    headers: {
      Authorization: `${config.fuelAuthScheme} ${config.fuelApiKey}`,
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Fuel API returned unexpected status: ${response.status}`);
  }

  const payload = response.data;

  const records = Array.isArray(payload)
    ? payload
    : payload?.data || payload?.prices || payload?.results || payload?.result;

  if (!Array.isArray(records)) {
    throw new Error('Unexpected API response shape: could not locate an array of price records.');
  }

  console.log(`Fetched ${records.length} raw record(s) from the API.`);
  return records;
}

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

const FUEL_FIELD_MAP = {
  gasoline: 'gasoline',
  diesel: 'diesel',
  lpg: 'lpg',
  midGrade: 'mid_grade',
  premium: 'premium',
  e85: 'e85',
};

const CURRENCY_ALIASES = {
  euro: 'EUR',
  usd: 'USD',
  dollar: 'USD',
};

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;

  const trimmed = String(value).trim();
  if (trimmed === '' || trimmed === '-') return null;

  const normalized = trimmed.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeCurrency(rawCurrency) {
  const key = String(rawCurrency || 'USD').trim().toLowerCase();
  return CURRENCY_ALIASES[key] || rawCurrency.toUpperCase();
}

function buildRow(country, fuelType, price, currency, priceDate, rawItem, nowIso) {
  return {
    country: String(country).trim(),
    fuel_type: fuelType,
    price,
    currency,
    price_date: priceDate,
    raw_payload: rawItem,
    updated_at: nowIso,
  };
}

function transformRecords(rawRecords) {
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const rows = [];
  let skipped = 0;

  for (const item of rawRecords) {
    const country = item.country || item.country_name || item.name || item.location;
    if (!country) {
      console.warn('Skipping record with no country/region identifier:', JSON.stringify(item));
      skipped += 1;
      continue;
    }

    const currency = normalizeCurrency(item.currency || item.currency_code);
    const priceDate = item.date || item.price_date || today;

    if (item.price !== undefined || item.value !== undefined || item.amount !== undefined) {
      const fuelType = String(item.fuel_type || item.type || item.product || 'unknown')
        .trim()
        .toLowerCase();
      const price = parseLocaleNumber(item.price ?? item.value ?? item.amount);

      if (price === null) {
        skipped += 1;
        continue;
      }

      rows.push(buildRow(country, fuelType, price, currency, priceDate, item, nowIso));
      continue;
    }

    let matchedAnyFuelColumn = false;
    for (const [responseKey, fuelType] of Object.entries(FUEL_FIELD_MAP)) {
      if (item[responseKey] === undefined) continue;
      matchedAnyFuelColumn = true;

      const price = parseLocaleNumber(item[responseKey]);
      if (price === null) continue;

      rows.push(buildRow(country, fuelType, price, currency, priceDate, item, nowIso));
    }

    if (!matchedAnyFuelColumn) {
      console.warn('Skipping record with no recognizable fuel price fields:', JSON.stringify(item));
      skipped += 1;
    }
  }

  console.log(`Transformed ${rows.length} valid record(s) (${skipped} record(s) skipped).`);
  return rows;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function upsertFuelPrices(supabase, config, rows) {
  if (rows.length === 0) {
    console.log('No valid records to upsert. Skipping database write.');
    return { count: 0 };
  }

  console.log(`Upserting ${rows.length} record(s) into "${config.fuelTable}" ...`);

  const { data, error } = await supabase
    .from(config.fuelTable)
    .upsert(rows, {
      onConflict: 'country,fuel_type,price_date',
      ignoreDuplicates: false,
    })
    .select();

  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  return { count: data ? data.length : rows.length };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function main() {
  console.log('Starting sync...');
  console.log(`Run timestamp: ${new Date().toISOString()}`);

  try {
    const config = loadConfig();
    const supabase = initSupabaseClient(config);

    const rawRecords = await fetchFuelPrices(config);
    const rows = transformRecords(rawRecords);
    const result = await upsertFuelPrices(supabase, config, rows);

    console.log(`Data successfully saved! (${result.count} row(s) upserted)`);
    console.log('Sync completed successfully.');
  } catch (error) {
    console.error('Fuel price sync failed:');
    console.error(error?.message || error);
    if (error?.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadConfig,
  fetchFuelPrices,
  transformRecords,
  upsertFuelPrices,
  parseLocaleNumber,
};
