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
 *   FUEL_API_URL       - Override the Europe endpoint
 *   USA_API_URL        - Override the US states endpoint (default: allUsaPrice)
 *   CANADA_API_URL     - Override the Canada endpoint (default: canada)
 *   FUEL_AUTH_SCHEME   - Override the auth header scheme (default: "apikey")
 *   SUPABASE_TABLE     - Override the destination table name (default: fuel_prices)
 *
 * ---------------------------------------------------------------------------
 * PROVIDER: CollectAPI "Gas Price" API
 * ---------------------------------------------------------------------------
 * Three endpoints are synced each night:
 *   - /gasPrice/europeanCountries  (one record per country)
 *   - /gasPrice/allUsaPrice        (one record per state, USD per gallon)
 *   - /gasPrice/canada             (provinces with cities, CAD per litre)
 *
 * US prices are converted to per-litre so the site can show "/ L" for all.
 * US states are saved as "<State> (US state)" and Canadian provinces as
 * "<Province> (Canada)". National averages are saved as "USA" and "Canada".
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
 *   Unique constraint used by the upsert:
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
// Retry helper
// Retries on server errors (5xx), rate limits (429) and network/timeout
// errors. Client errors like 401/403 fail immediately.
// ---------------------------------------------------------------------------

async function withRetry(fn, tries = 4, delayMs = 5000) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const retryable = !status || status >= 500 || status === 429;
      if (!retryable || attempt === tries) throw err;

      const wait = delayMs * attempt;
      console.warn(
        `Fuel API attempt ${attempt}/${tries} failed (${status || err.code || 'network error'}). Retrying in ${wait / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

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
    USA_API_URL,
    CANADA_API_URL,
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
    // NEW: extra sources
    usaApiUrl: USA_API_URL || 'https://api.collectapi.com/gasPrice/allUsaPrice',
    canadaApiUrl: CANADA_API_URL || 'https://api.collectapi.com/gasPrice/canada',
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

// CHANGED: accepts a url so the same function fetches all three endpoints
async function fetchFuelPrices(config, url = config.fuelApiUrl) {
  console.log(`Fetching fuel price data from ${url} ...`);

  const response = await withRetry(() =>
    axios.get(url, {
      headers: {
        Authorization: `${config.fuelAuthScheme} ${config.fuelApiKey}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    })
  );

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

// CHANGED: strips currency symbols such as "$3.761" before parsing
function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isNaN(value) ? null : value;

  const trimmed = String(value).trim();
  if (trimmed === '' || trimmed === '-') return null;

  const cleaned = trimmed.replace(/[^\d.,]/g, '');
  if (cleaned === '') return null;

  const normalized = cleaned.replace(',', '.');
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
// NEW: US states and Canada
// ---------------------------------------------------------------------------

const GALLON_IN_LITRES = 3.785411784;

const USA_FIELD_MAP = {
  regular: 'gasoline',
  midGrade: 'mid_grade',
  premium: 'premium',
  diesel: 'diesel',
};

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function average(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// US endpoint: one record per state, prices in USD per gallon.
// Saved per litre as "<State> (US state)", plus a national "USA" average.
function transformUsaRecords(rawRecords) {
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const rows = [];
  const totals = {};

  for (const item of rawRecords) {
    if (!item.name) {
      console.warn('Skipping US record with no name:', JSON.stringify(item));
      continue;
    }

    const currency = normalizeCurrency(item.currency || 'usd');

    for (const [responseKey, fuelType] of Object.entries(USA_FIELD_MAP)) {
      const perGallon = parseLocaleNumber(item[responseKey]);
      if (perGallon === null) continue;

      const perLitre = round3(perGallon / GALLON_IN_LITRES);
      rows.push(
        buildRow(`${String(item.name).trim()} (US state)`, fuelType, perLitre, currency, today, item, nowIso)
      );

      if (!totals[fuelType]) totals[fuelType] = [];
      totals[fuelType].push(perLitre);
    }
  }

  for (const [fuelType, values] of Object.entries(totals)) {
    rows.push(
      buildRow(
        'USA',
        fuelType,
        round3(average(values)),
        'USD',
        today,
        { note: `Simple average of ${values.length} US states, converted to per litre` },
        nowIso
      )
    );
  }

  console.log(`Transformed ${rows.length} US record(s).`);
  return rows;
}

// Canada endpoint: provinces, each with a list of cities (gasoline only,
// CAD per litre). Each province is the average of its cities, saved as
// "<Province> (Canada)", plus a national "Canada" average.
function transformCanadaRecords(rawRecords) {
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const rows = [];
  const provinceAverages = [];
  let currency = 'CAD';

  for (const province of rawRecords) {
    const name = province.state || province.name;
    const cities = Array.isArray(province.cities) ? province.cities : [];
    const prices = cities
      .map((city) => parseLocaleNumber(city.gasoline))
      .filter((price) => price !== null);

    if (!name || prices.length === 0) {
      console.warn('Skipping Canadian record with no usable prices:', JSON.stringify(province));
      continue;
    }

    currency = normalizeCurrency(cities[0]?.currency || 'cad');
    const provinceAverage = round3(average(prices));

    rows.push(
      buildRow(
        `${String(name).trim()} (Canada)`,
        'gasoline',
        provinceAverage,
        currency,
        today,
        { note: `Average of ${prices.length} cities`, cities },
        nowIso
      )
    );
    provinceAverages.push(provinceAverage);
  }

  if (provinceAverages.length > 0) {
    rows.push(
      buildRow(
        'Canada',
        'gasoline',
        round3(average(provinceAverages)),
        currency,
        today,
        { note: `Simple average of ${provinceAverages.length} provinces` },
        nowIso
      )
    );
  }

  console.log(`Transformed ${rows.length} Canadian record(s).`);
  return rows;
}

// Postgres rejects an upsert that contains the same key twice in one batch,
// so keep one row per country + fuel + date.
function dedupeRows(rows) {
  const unique = new Map();
  for (const row of rows) {
    unique.set(`${row.country}|${row.fuel_type}|${row.price_date}`, row);
  }
  return [...unique.values()];
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

    // Europe is required: if it fails, the whole run fails.
    const europeRaw = await fetchFuelPrices(config, config.fuelApiUrl);
    let rows = transformRecords(europeRaw);

    // US and Canada are best-effort: a failure here must not lose Europe's data.
    const extraSources = [
      { name: 'US states', url: config.usaApiUrl, transform: transformUsaRecords },
      { name: 'Canada', url: config.canadaApiUrl, transform: transformCanadaRecords },
    ];
    const failures = [];

    for (const source of extraSources) {
      try {
        const raw = await fetchFuelPrices(config, source.url);
        rows = rows.concat(source.transform(raw));
      } catch (err) {
        failures.push(source.name);
        console.error(`${source.name} sync failed: ${err?.message || err}`);
      }
    }

    rows = dedupeRows(rows);
    const result = await upsertFuelPrices(supabase, config, rows);

    console.log(`Data successfully saved! (${result.count} row(s) upserted)`);

    if (failures.length > 0) {
      console.error(`Saved what was available, but these sources failed: ${failures.join(', ')}`);
      process.exit(1);
    }

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
  transformUsaRecords,
  transformCanadaRecords,
  upsertFuelPrices,
  parseLocaleNumber,
};
