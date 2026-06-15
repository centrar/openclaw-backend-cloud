const fs = require('fs');
let content = fs.readFileSync('C:/Users/arvin/.openclaw/.env', 'utf8');

// Strip out the bad utf16 appended stuff
content = content.replace(/S\0U\0P\0A\0B\0A\0S\0E.*/g, '');
content = content.replace(/SUPABASE_DB_URL.*/g, '');
content = content.replace(/NORTHFLANK_API_TOKEN.*/g, '');
// Clean up trailing nulls or newlines
content = content.replace(/\0/g, '').trim();

content += '\nSUPABASE_DB_URL="postgresql://postgres:ikv%21%21u6jr%2FUab_%2B@db.avszlntjjureghhonksz.supabase.co:5432/postgres"\n';

fs.writeFileSync('C:/Users/arvin/.openclaw/.env', content, 'utf8');
console.log('Fixed .env');
