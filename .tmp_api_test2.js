const BASE = 'http://localhost:3000';

async function test() {
  try {
    const tests = [
      {
        name: '/collect-email missing data',
        options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      },
      {
        name: '/collect-email invalid email',
        options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bad-email', url: 'https://example.com', scanResult: { url: 'https://example.com', summary: { totalViolations: 1, passes: 0, incomplete: 0 }, violationsBySeverity: { critical: 0, serious: 0, moderate: 1, minor: 0 }, violations: [{ id: 'landmark-one-main', impact: 'moderate', description: 'Ensure the document has a main landmark', help: 'Document should have one main landmark', affectedElements: 1, nodes: [{ html: '<html>', target: ['html'], failureSummary: 'Fix all of the following: Document does not have a main landmark' }] }] } }) },
      },
      {
        name: '/collect-email valid email',
        options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test@example.com', url: 'https://example.com', scanResult: { url: 'https://example.com', summary: { totalViolations: 1, passes: 0, incomplete: 0 }, violationsBySeverity: { critical: 0, serious: 0, moderate: 1, minor: 0 }, violations: [{ id: 'landmark-one-main', impact: 'moderate', description: 'Ensure the document has a main landmark', help: 'Document should have one main landmark', affectedElements: 1, nodes: [{ html: '<html>', target: ['html'], failureSummary: 'Fix all of the following: Document does not have a main landmark' }] }] } }) },
      },
      {
        name: '/generate-report missing scanId',
        options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      },
      {
        name: '/generate-report invalid scanId',
        options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scanId: 999999999 }) },
      },
    ];

    for (const test of tests) {
      console.log('===', test.name, '===');
      const res = await fetch(`${BASE}${test.name.startsWith('/generate-report') ? '/generate-report' : '/collect-email'}`, test.options);
      const text = await res.text();
      console.log(res.status, text);
      console.log();
    }
  } catch (error) {
    console.error('Test error:', error);
  }
}

test();
