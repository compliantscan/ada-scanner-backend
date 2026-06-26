const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, 'scan_validation.log');
if (!fs.existsSync(file)) {
  console.log('MISSING');
  process.exit(1);
}
const content = fs.readFileSync(file, 'utf8');
const lines = content.split(/\r?\n/);
console.log('LINES', lines.length);
console.log('SIZE', Buffer.byteLength(content, 'utf8'));
console.log('TAIL');
console.log(lines.slice(-40).join('\n'));
