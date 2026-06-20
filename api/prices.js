/**
 * api/prices.js
 * ---------------------------------------------------------------------------
 * Public-facing fuel price API. Deployed as a Vercel serverless function.
 *
 * Reads from the Supabase `fuel_prices` table (read-only, via the
 * publishable key + RLS policy) and returns clean JSON.
 *
 * Usage:
 *   GET /api/prices
 *   GET /api/prices?country=Germany
 *   GET /api/prices?country=Germany&fuel_type=diesel
 *   GET /api/prices?fuel_type=gasoline&limit=20
 *
 * Required header on every request:
 *   x-api-key: <your PUBLIC_API_KEY value>
 *
 * Required environment variables (set these in the Vercel project settings):
 *   SUPABASE_URL             - same Supabase project URL as the sync script
 *   SUPABASE_PUBLISHABLE_KEY - the PUBLISHABLE key (sb_publishable_...), NOT
 *                              the secret key. Safe to use here because RLS
 *                              restricts this key to read-only access.
 *   PUBLIC_API_KEY           - a random string you generate yourself, used as
 *                              a simple gate before RapidAPI is wired up.
 * ---------------------------------------------------------------------------
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

module.exports = async (req, res) => {
  const providedKey = req.headers['x-api-key'];
  if (!process.env.PUBLIC_API_KEY || providedKey !== process.env.PUBLIC_API_KEY) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized: missing or invalid x-api-key header.',
    });
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY environment variable.');
    res.status(500).json({ success: false, error: 'Server misconfiguration.' });
    return;
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false } }
  );

  try {
    const { country, fuel_type: fuelType, limit } = req.query || {};

    let query = supabase
      .from('fuel_prices')
      .select('country, fuel_type, price, currency, price_date, updated_at');

    if (country) {
      query = query.ilike('country', `%${country}%`);
    }
    if (fuelType) {
      query = query.eq('fuel_type', String(fuelType).trim().toLowerCase());
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
    query = query.order('price_date', { ascending: false }).limit(parsedLimit);

    const { data, error } = await query;

    if (error) {
      console.error('Supabase query error:', error.message);
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('Unexpected error in /api/prices:', err);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};
