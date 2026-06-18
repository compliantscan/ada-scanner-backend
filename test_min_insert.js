require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

(async () => {
  try {
    const { data, error } = await supabase.from('scans').insert([
      { url: 'https://example.com', results_json: { test: true } }
    ]).select();
    if (error) {
      console.error('Insert error:', error);
      process.exit(1);
    }
    console.log('Insert success:', data);
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
})();
