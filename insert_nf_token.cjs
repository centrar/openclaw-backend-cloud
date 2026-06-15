const fs = require('fs');
let content = fs.readFileSync('C:/Users/arvin/.openclaw/.env', 'utf8');

content = content.replace(/NORTHFLANK_API_TOKEN.*/g, 'NORTHFLANK_API_TOKEN="nf-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1dWlkIjoiZWIwNTk3MjctODBkMy00M2IzLTk5ZjktNjI4YTE3YTA4MzQzIiwiZW50aXR5SWQiOiI2YTMwNzU4YzZjMWEwZjczYjU3NmYzYTAiLCJlbnRpdHlUeXBlIjoidGVhbSIsInRva2VuSWQiOiI2YTMwNzhhNTZjMWEwZjczYjU3NmYzYjUiLCJ0b2tlbkludGVybmFsSWQiOiJjZW50cmFibzEiLCJyb2xlSWQiOiI2YTMwNzU4YzZjMWEwZjczYjU3NmYzYTEiLCJyb2xlRW50aXR5SWQiOiI2YTMwNzU4YzZjMWEwZjczYjU3NmYzYTAiLCJyb2xlRW50aXR5VHlwZSI6InRlYW0iLCJyb2xlSW50ZXJuYWxJZCI6Im93bmVyIiwidHlwZSI6InJiYWMiLCJpYXQiOjE3ODE1NjE1MDl9.UYFmcWALwxFuytCs_LCaA3JEua4NdZYHuIkdCdOL9bk"');

fs.writeFileSync('C:/Users/arvin/.openclaw/.env', content, 'utf8');
console.log('Saved Northflank token to .env');
