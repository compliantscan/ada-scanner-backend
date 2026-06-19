const fetch = global.fetch || require('node-fetch');
const BASE = 'http://localhost:3000';

async function run() {
  try {
    console.log('HEALTH');
    let res = await fetch(`${BASE}/health`);
    console.log(res.status, await res.json());

    console.log('\nSCAN valid');
    res = await fetch(`${BASE}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    });
    console.log(res.status, await res.json());

    console.log('\nSCAN missing body');
    res = await fetch(`${BASE}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    console.log(res.status, await res.text());

    console.log('\nSCAN invalid url');
    res = await fetch(`${BASE}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' }),
    });
    console.log(res.status, await res.text());

    console.log('\nSCAN nonexistent domain');
    res = await fetch(`${BASE}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://doesnotexist-ada-test12345.com' }),
    });
    console.log(res.status, await res.text());
  } catch (err) {
    console.error('ERROR', err);
  }
}

run();
