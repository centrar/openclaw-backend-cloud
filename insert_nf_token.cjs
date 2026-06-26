const fs = require('fs');
// SECURITY NOTE: This file previously contained a hardcoded Northflank API token.
// That token has been revoked and rotated. Tokens must NOT be hardcoded in source files.
// Load the token from the DPAPI keystore (secrets.enc) or environment variable instead.

const token = process.env.NORTHFLANK_API_TOKEN;
if (!token) {
  console.error('ERROR: NORTHFLANK_API_TOKEN not set in environment. Aborting.');
  process.exit(1);
}

let content = fs.readFileSync('C:/Users/arvin/.openclaw/.env', 'utf8');
content = content.replace(/NORTHFLANK_API_TOKEN.*/g, NORTHFLANK_API_TOKEN=" + token + ");
fs.writeFileSync('C:/Users/arvin/.openclaw/.env', content, 'utf8');
console.log('Saved Northflank token to .env from environment (not hardcoded).');
