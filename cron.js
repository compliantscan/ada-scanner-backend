const cron = require('node-cron');
const { 
  getSitesDueForScan, 
  updateMonitoredSite, 
  addMonitoringScan, 
  getLatestMonitoringScan,
  addMonitoringAlert,
  saveScanResults
} = require('./db');
const { scanUrl } = require('./scanner');
const { calculateScore } = require('./scoring');

function calculateNextScanDate(frequency) {
  const nextScan = new Date();
  if (frequency === 'daily') {
    nextScan.setDate(nextScan.getDate() + 1);
  } else if (frequency === 'monthly') {
    nextScan.setMonth(nextScan.getMonth() + 1);
  } else {
    // weekly (default)
    nextScan.setDate(nextScan.getDate() + 7);
  }
  return nextScan.toISOString();
}

async function runMonitorScan(site) {
  console.log(`[CRON] Scanning site: ${site.url}`);
  try {
    // 1. Perform scan
    const results = await scanUrl(site.url);
    const newScore = calculateScore(results.violations);

    const violationsBySeverity = {
      critical: results.violations.filter(v => v.impact === 'critical').length,
      serious: results.violations.filter(v => v.impact === 'serious').length,
      moderate: results.violations.filter(v => v.impact === 'moderate').length,
      minor: results.violations.filter(v => v.impact === 'minor').length,
    };

    // 2. Fetch previous scan for comparison
    const previousScan = await getLatestMonitoringScan(site.id);

    // Save to scans table to get an audit_id
    let audit_id = null;
    try {
      const savedScan = await saveScanResults(site.url, results, { id: site.user_id }, { source: 'monitoring' });
      audit_id = savedScan?.id || null;
    } catch (e) {
      console.warn(`[CRON] Could not save full scan results to scans table for ${site.url}:`, e.message);
    }

    // 3. Save new scan to monitoring_scans table
    const scanData = {
      score: newScore,
      critical_count: violationsBySeverity.critical,
      serious_count: violationsBySeverity.serious,
      moderate_count: violationsBySeverity.moderate,
      minor_count: violationsBySeverity.minor,
      pages_scanned: site.pages_monitored || 1,
      violations_json: results.violations
    };
    await addMonitoringScan(site.id, audit_id, scanData);

    // 4. Compare and generate alerts
    if (previousScan && site.alerts_enabled) {
      const previousRuleIds = new Set((previousScan.violations_json || []).map(v => v.id));
      const newViolations = results.violations.filter(v => !previousRuleIds.has(v.id));

      if (newScore < previousScan.score) {
        await addMonitoringAlert(
          site.id,
          'score_drop',
          'warning',
          `Accessibility score dropped from ${previousScan.score} to ${newScore}.`
        );
      }

      for (const nv of newViolations) {
        if (nv.impact === 'critical' || nv.impact === 'serious') {
          await addMonitoringAlert(
            site.id,
            'new_issue',
            nv.impact === 'critical' ? 'critical' : 'warning',
            `New ${nv.impact} issue detected: ${nv.help || nv.id}`
          );
        }
      }
    }

    // Determine status
    let status = 'healthy';
    if (newScore < 80) status = 'warning';
    if (newScore < 60) status = 'critical';

    // 5. Update monitored_sites
    await updateMonitoredSite(site.id, {
      status,
      last_scan_at: new Date().toISOString(),
      next_scan_at: calculateNextScanDate(site.frequency)
    });

    console.log(`[CRON] Successfully updated site: ${site.url} (Score: ${newScore})`);
  } catch (error) {
    console.error(`[CRON] Failed to scan site ${site.url}:`, error.message);
    const retryScan = new Date();
    retryScan.setHours(retryScan.getHours() + 1); // Retry in 1 hour
    await updateMonitoredSite(site.id, {
      status: 'warning',
      next_scan_at: retryScan.toISOString()
    });
  }
}

function initCronJobs() {
  console.log('[CRON] Initializing background jobs...');
  // Check every minute if there are any sites due for a scan
  cron.schedule('* * * * *', async () => {
    try {
      const sites = await getSitesDueForScan();
      if (!sites || sites.length === 0) return;
      
      console.log(`[CRON] Found ${sites.length} sites due for scan.`);
      for (const site of sites) {
        await runMonitorScan(site);
      }
    } catch (error) {
      console.error('[CRON] Error in scheduled task:', error);
    }
  });
}

module.exports = { initCronJobs, runMonitorScan };
