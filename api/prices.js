/**
 * api/prices.js
 * ---------------------------------------------------------------------------
 * Public-facing fuel price API. Deployed as a Vercel serverless function.
 *
 * Reads from the Supabase `fuel_prices` table (read-only, via the
 * publishable key + RLS policy) and returns clean JSON.
 *
 * Usage:
 *   GET /api/prices?country=Germany
 *   GET /api/prices?country=Germany&fuel_type=diesel
 *   GET /api/prices?fuel_type=gasoline&limit=20
 *
 * Required environment variables (set in Vercel project settings):
 *   SUPABASE_URL              - Supabase project URL
 *   SUPABASE_PUBLISHABLE_KEY  - Supabase publishable key (read-only via RLS)
 *   PUBLIC_API_KEY            - for direct/testing access
 *   RAPIDAPI_PROXY_SECRET     - from RapidAPI dashboard (Proxy Secret)
 * ---------------------------------------------------------------------------
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

module.exports = async (req, res) => {
  // --- Auth check ---
  // Accepts either:
  // 1. RapidAPI proxy secret (requests coming through RapidAPI marketplace)
  // 2. Direct x-api-key header (for testing/direct access)
  const rapidApiSecret = req.headers['x-rapidapi-proxy-secret'];
  const directApiKey = req.headers['x-api-key'];
  const validRapidApi = process.env.RAPIDAPI_PROXY_SECRET && rapidApiSecret === process.env.RAPIDAPI_PROXY_SECRET;
  const validDirectKey = process.env.PUBLIC_API_KEY && directApiKey === process.env.PUBLIC_API_KEY;

  if (!validRapidApi && !validDirectKey) {
    res.status(401).json({
      success: false,
      error: 'Unauthorized: missing or invalid API key.',
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
