require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
const { Client } = require('pg');
const fs = require('fs');

const projectId = 'avszlntjjureghhonksz';
const password = encodeURIComponent('ikv!!u6jr/Uab_+');
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
      let content = fs.readFileSync('C:/Users/arvin/.openclaw/.env', 'utf8');
      content = content.replace(/SUPABASE_DB_URL.*/g, `SUPABASE_DB_URL="${url}"`);
      fs.writeFileSync('C:/Users/arvin/.openclaw/.env', content, 'utf8');
      
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
