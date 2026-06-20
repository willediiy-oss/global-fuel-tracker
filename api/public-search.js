/**
 * api/public-search.js
 * ---------------------------------------------------------------------------
 * Keyless, read-only endpoint used ONLY by the public demo search page
 * (index.html). Deliberately has no API key gate, since:
 *   - It only ever performs SELECT queries
 *   - The underlying table has Row Level Security enabled with a read-only
 *     policy for the anon/publishable role (no write access is possible
 *     even if this key were misused)
 *   - The data itself isn't sensitive
 *
 * Keep this separate from api/prices.js, which IS protected by an API key
 * and is meant to be the metered/paid product once that's ready to launch.
 *
 * Usage:
 *   GET /api/public-search?country=Germany
 *   GET /api/public-search?country=Germany&fuel_type=diesel
 * ---------------------------------------------------------------------------
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

const MAX_LIMIT = 20;

module.exports = async (req, res) => {
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
    const { country, fuel_type: fuelType } = req.query || {};

    if (!country || !String(country).trim()) {
      res.status(400).json({ success: false, error: 'A "country" query parameter is required.' });
      return;
    }

    let query = supabase
      .from('fuel_prices')
      .select('country, fuel_type, price, currency, price_date, updated_at')
      .ilike('country', `%${String(country).trim()}%`);

    if (fuelType) {
      query = query.eq('fuel_type', String(fuelType).trim().toLowerCase());
    }

    query = query.order('price_date', { ascending: false }).limit(MAX_LIMIT);

    const { data, error } = await query;

    if (error) {
      console.error('Supabase query error:', error.message);
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('Unexpected error in /api/public-search:', err);
    res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};
