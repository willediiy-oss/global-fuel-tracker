const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase using the secure environment secrets we set up
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function fetchAndSyncFuelPrices() {
  console.log("Starting fuel price synchronization...");

  try {
    // 1. Fetch live fuel data from the CollectAPI
    const response = await axios.get('https://api.collectapi.com/gasPrice/turkeyGasoline', {
      headers: {
        'content-type': 'application/json',
        'authorization': `apikey ${process.env.FUEL_API_KEY}`
      }
    });

    if (!response.data || !response.data.result) {
      throw new Error("Failed to retrieve valid data from CollectAPI.");
    }

    const fuelRecords = response.data.result;
    console.log(`Successfully fetched ${fuelRecords.length} fuel station records.`);

    // 2. Format and map the incoming data for your database
    const rowsToInsert = fuelRecords.map(item => ({
      city: item.city,
      district: item.district,
      brand: item.marka,       // Maps 'marka' API field to your database 'brand' column
      fuel_type: item.gasType, // Maps 'gasType' API field to your database 'fuel_type' column
      price: parseFloat(item.price),
      updated_at: new Date()
    }));

    // 3. Upsert data into your Supabase 'fuel_prices' table
    const { data, error } = await supabase
      .from('fuel_prices')
      .upsert(rowsToInsert, { onConflict: 'city,district,brand,fuel_type' });

    if (error) {
      throw error;
    }

    console.log("Database sync complete! All records successfully updated.");

  } catch (error) {
    console.error("An error occurred during execution:", error.message);
    process.exit(1); // Tells GitHub Actions that the job failed
  }
}

// Execute the function
fetchAndSyncFuelPrices();
