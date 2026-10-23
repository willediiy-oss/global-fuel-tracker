/**
 * api/prices.js
 * Public-facing fuel price API (Vercel serverless function).
 * Reads from Supabase `fuel_prices` (read-only via publishable key + RLS).
 *
 * Usage:
 *   GET /api/prices?country=Germany                 -> latest price per fuel
 *   GET /api/prices?country=Germany&fuel_type=diesel
 *   GET /api/prices?country=Germany&history=true    -> full history (newest first)
 *   GET /api/prices?fuel_type=gasoline&limit=20
 *
 * Env vars: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, PUBLIC_API_KEY,
 *           RAPIDAPI_PROXY_SECRET
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const LATEST_WINDOW = 1000; // newest rows to scan when picking the latest per fuel

module.exports = async (req, res) => {
  // --- Auth check ---
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
    const { country, fuel_type: fuelType, limit, history } = req.query || {};
    const wantHistory = String(history).toLowerCase() === 'true';

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
    query = query
      .order('price_date', { ascending: false })
      .limit(wantHistory ? parsedLimit : LATEST_WINDOW);

    const { data: rows, error } = await query;

    if (error) {
      console.error('Supabase query error:', error.message);
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    let data = rows;
    if (!wantHistory) {
      // Rows are newest first, so the first one seen per country + fuel is the latest.
      const seen = new Set();
      data = rows
        .filter((r) => {
          const key = `${r.country}|${r.fuel_type}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, parsedLimit);
    }

    res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('Unexpected error in /api/prices:', err);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};
