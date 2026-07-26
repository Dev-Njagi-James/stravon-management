const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const { data, error } = await supabase
    .from('project_users')
    .select('*')
    .limit(1);
  if (error) {
    console.error('Error fetching project_users:', error);
  } else {
    console.log('project_users exists, data:', data);
  }
}

test();
