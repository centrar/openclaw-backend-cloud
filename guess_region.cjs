require('dotenv').config({ path: require('../ag_paths.cjs').ENV_FILE });
const { Client } = require('pg');
const fs = require('fs');

// Credentials come from env, NOT hardcoded. (The hardcoded values were scrubbed
// — they leaked into the public git history and must be rotated in Supabase.)
const projectId = process.env.SUPABASE_PROJECT_ID;
const password = encodeURIComponent(process.env.SUPABASE_DB_PASSWORD || '');
if (!projectId || !password) {
  console.error('Missing SUPABASE_PROJECT_ID or SUPABASE_DB_PASSWORD in env. Set them in .env.');
  process.exit(1);
}
const regions = [
  'us-east-1', 'us-west-1', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 
  'ap-northeast-1', 'ap-south-1', 'sa-east-1', 'ca-central-1', 'eu-west-2',
  'ap-southeast-2', 'us-east-2'
];

async function findRegion() {
  for (const region of regions) {
    const url = `postgresql://postgres.${projectId}:${password}@aws-0-${region}.pooler.supabase.com:6543/postgres`;
    console.log(`Trying region ${region}...`);
    
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      console.log(`\nSUCCESS! Found region: ${region}`);
      
      // Update .env file automatically
      const envFile = require('../ag_paths.cjs').ENV_FILE;
      let content = fs.readFileSync(envFile, 'utf8');
      content = content.replace(/SUPABASE_DB_URL.*/g, `SUPABASE_DB_URL="${url}"`);
      fs.writeFileSync(envFile, content, 'utf8');
      
      await client.end();
      return url;
    } catch (e) {
      // Failed, try next
    }
  }
  console.log('Could not guess region.');
  return null;
}

findRegion();
