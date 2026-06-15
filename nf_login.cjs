require('dotenv').config({ path: 'C:/Users/arvin/.openclaw/.env' });
const { execSync } = require('child_process');
try {
  execSync(`northflank login -t ${process.env.NORTHFLANK_API_TOKEN}`, { stdio: 'inherit' });
  console.log('Logged into Northflank!');
} catch (e) {
  console.error(e.message);
}
