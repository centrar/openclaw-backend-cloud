const fs = require('fs');
let content = fs.readFileSync('C:/Users/arvin/.openclaw/.env', 'utf8');

content = content.replace(/RENDER_API_KEY.*/g, ''); // clear if exists
content += '\nRENDER_API_KEY="rnd_fhZOaYsKycNljQmkV0BMk7Yib1Hs"\n';

fs.writeFileSync('C:/Users/arvin/.openclaw/.env', content.trim(), 'utf8');
console.log('Successfully injected the Render API Key!');
