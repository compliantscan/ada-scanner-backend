require('dotenv').config();
const { getScanById } = require('./db');

async function run() {
  try {
    console.log('Test getScanById existing 7');
    const a = await getScanById(7);
    console.log('existing', a ? 'found' : 'not found', a && a.id);
  } catch (err) {
    console.error('existing error', err.message || err);
  }

  try {
    console.log('Test getScanById missing 999999999');
    const b = await getScanById(999999999);
    console.log('missing', b === null ? 'null' : b);
  } catch (err) {
    console.error('missing error', err.message || err);
  }

  try {
    console.log('Test getScanById string abc');
    const c = await getScanById('abc');
    console.log('string abc', c === null ? 'null' : c);
  } catch (err) {
    console.error('string abc error', err.message || err);
  }
}
run();
