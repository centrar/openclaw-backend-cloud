const fs = require('fs');
let content = fs.readFileSync('C:/Users/arvin/.openclaw/.env', 'utf8');

// Replace the old SUPABASE_DB_URL with the correct Transaction Pooler URL and password
content = content.replace(/SUPABASE_DB_URL.*/g, 'SUPABASE_DB_URL="postgresql://postgres.avszlntjjureghhonksz:ikv%21%21u6jr%2FUab_%2B@aws-1-us-west-2.pooler.supabase.com:6543/postgres"');

fs.writeFileSync('C:/Users/arvin/.openclaw/.env', content, 'utf8');
console.log('Successfully injected the IPv4 Pooler URL!');
