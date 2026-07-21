# Backend Analysis & Knowledge File

> **Last updated:** 2026-07-21
> **Purpose:** Avoid re-analyzing the same files. Start here for any backend work.

---

## Stack Overview

| Layer | Tech |
|-------|------|
| Runtime | Node.js 24 (CommonJS) |
| Framework | Express 5 |
| Scanner | Playwright + AxeBuilder (`@axe-core/playwright`) |
| Database | Supabase (PostgreSQL) via `@supabase/supabase-js` v2 |
| Auth | Supabase Auth (JWT tokens validated server-side) |
| Email | Resend API (via `nodemailer` adapter in `email.js`) |
| AI fixes | Anthropic Claude (claude-haiku model) |
| Payments | Stripe (subscriptions + webhook) |
| PDFs | pdfkit |
| Cron | node-cron (in-process, every minute) |
| Deploy | Railway (Docker container) |

---

## File Map

| File | Purpose |
|------|---------|
| `server.js` | Main Express app, all API routes (1088 lines) |
| `db.js` | All Supabase DB functions (742 lines) |
| `scanner.js` | Playwright + Axe accessibility scanner |
| `scoring.js` | Score calculation, grade, risk level helpers |
| `paid-report-service.js` | Build free/paid boundary and paid reports |
| `claude.js` | AI fix generation via Anthropic API, with caching |
| `email.js` | Email sending via Resend + PDF generation via pdfkit |
| `report.js` | PDF report generation |
| `cron.js` | Background monitoring scan jobs |
| `entitlements.js` | Token hashing, access keys, plan capabilities |
| `wcag.js` | WCAG criterion mapping helpers |
| `middleware/requireAuth.js` | JWT auth middleware (Supabase token verify) |
| `lib/supabaseAdmin.js` | Shared Supabase admin client (unused - db.js owns its own) |
| `Dockerfile` | Container config for Railway deployment |
| `migrations/` | SQL migration files for Supabase schema changes |
| `SUPABASE_SETUP.sql` | Initial DB schema setup |

---

## Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `SUPABASE_URL` | YES | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | YES | Used by db.js, requireAuth.js. Never expose to frontend |
| `SUPABASE_ANON_KEY` | Optional | Fallback if no service role key. Leave empty if using service role |
| `PORT` | Optional | Defaults to 3000. Set to 3001 in local .env |
| `CORS_ALLOWED_ORIGINS` | Optional | Comma-separated origins. If unset, all origins allowed (dev mode) |
| `RESEND_API_KEY` | Optional | Email delivery. Scan results still work without it |
| `RESEND_FROM` | Optional | Sender email address |
| `ANTHROPIC_API_KEY` | Optional | AI fix generation. Falls back to rule-based fixes if absent |
| `ANTHROPIC_MODEL` | Optional | Defaults to claude-haiku-4-5-20251001 |
| `STRIPE_SECRET_KEY` | Optional | Payments. Checkout/webhook routes return 503 if absent |
| `STRIPE_WEBHOOK_SECRET` | Optional | Stripe webhook signature verification |
| `STRIPE_PRICE_STARTER` | Optional | Stripe price ID for Starter plan |
| `STRIPE_PRICE_GROWTH` | Optional | Stripe price ID for Growth plan |
| `STRIPE_PRICE_AGENCY` | Optional | Stripe price ID for Agency plan |
| `FRONTEND_URL` | Optional | Used in Stripe redirect URLs. Defaults to http://localhost:3000 |

---

## API Routes

### Public
| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/health` | None | Health check |
| POST | `/scan` | Optional | Run accessibility scan, save to DB |
| GET | `/report/:scanId` | None | Fetch raw scan record |
| POST | `/collect-email` | None | Save lead email, send PDF report |
| POST | `/paid-report` | Bearer token | Generate full paid report |
| POST | `/paid-report/pdf` | Bearer token | Download paid report PDF |
| POST | `/lead-report/pdf` | Access key | Download free-tier PDF |
| POST | `/contact` | None | Contact form submission |
| POST | `/checkout` | None | Create Stripe checkout session |
| POST | `/billing-portal` | None | Open Stripe billing portal |
| POST | `/webhook/stripe` | Stripe-sig | Stripe event handler |
| POST | `/test-free-paid-boundary` | None | Debug endpoint |

### Dashboard (requires Authorization: Bearer supabase-jwt)
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/dashboard/stats` | Aggregated stats for dashboard home |
| GET | `/dashboard/scans` | List user's scans |
| POST | `/dashboard/scan` | Kick off background scan (returns immediately with scanId) |
| GET | `/dashboard/scan/:scanId` | Poll scan progress/status |
| DELETE | `/dashboard/scan/:id` | Delete a scan |
| GET | `/dashboard/report/:scanId` | Full report for a specific scan |
| GET | `/dashboard/monitoring` | List monitored sites |
| POST | `/dashboard/monitoring` | Add site to monitor |
| GET | `/dashboard/monitoring/alerts` | All alerts for user |
| POST | `/dashboard/monitoring/alerts/:id/read` | Mark alert as read |
| GET | `/dashboard/monitoring/:id` | Get site + scans + alerts |
| PUT | `/dashboard/monitoring/:id` | Update site frequency/status |
| DELETE | `/dashboard/monitoring/:id` | Remove monitored site |
| POST | `/dashboard/monitoring/:id/scan` | Trigger immediate scan |
| GET | `/dashboard/monitoring/:id/compare` | Compare last 2 scans |

---

## Database Tables

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `scans` | id, url, user_id, user_email, results_json, score, total_violations, violations_by_severity, affected_elements, access_key_hash, free_report_expires_at, scan_type, report_type, created_at, updated_at | RLS enabled. Service role bypasses RLS |
| `emails_collected` | id, email, url_scanned, created_at | Lead capture |
| `contact_submissions` | id, name, email, website, message, created_at | Contact form |
| `subscriptions` | id, stripe_customer_id, stripe_subscription_id, user_email, plan, status, current_period_end, access_token_hash, customer_logo_url, updated_at | Paid plans |
| `ai_fix_cache` | fingerprint, criterion, result_json, updated_at | Claude response cache. Gracefully disabled if missing |
| `monitored_sites` | id, user_id, url, frequency, pages_monitored, alerts_enabled, status, next_scan_at, last_scan_at, created_at, updated_at | Sites to scan periodically |
| `monitoring_scans` | id, monitor_id, audit_id, score, critical/serious/moderate/minor_count, pages_scanned, violations_json, created_at | History of monitoring scans |
| `monitoring_alerts` | id, monitor_id, type, severity, message, read, created_at | Alerts from monitoring scans |

---

## Supabase Client Strategy

- **db.js** creates two clients:
  - `supabase` — uses SERVICE_ROLE_KEY || ANON_KEY (fallback). Used for generic queries.
  - `supabaseAdmin` — uses SERVICE_ROLE_KEY only. Used for writes (bypasses RLS).
- **middleware/requireAuth.js** — lazy-init admin client for auth.getUser() token validation.
- **server.js /dashboard/stats** — inline admin client creation for reads. Filters by user_id manually since service role bypasses RLS.

IMPORTANT: All service-role writes bypass RLS. User-scoped endpoints must explicitly .eq('user_id', req.user.id) — they do not rely on RLS for data isolation.

---

## Scan Flow

POST /scan:
  1. normalizedScanUrl() - normalize/validate URL
  2. scanUrl() - Playwright + Axe (scanner.js) - up to 90s timeout
  3. calculateScore() - scoring.js
  4. saveScanResults() - db.js (best-effort, doesn't block response)
  5. buildFreePaidBoundaryReport() - paid-report-service.js -> claude.js for AI fixes
  6. Return JSON response

Background scan (POST /dashboard/scan):
  1. createScanPlaceholder() - immediate DB insert with _status: 'queued'
  2. Return { scanId } instantly (200)
  3. setImmediate -> scanUrl() runs in background
  4. updateScanWithResults() - updates DB row when done

---

## Scoring Algorithm

- Penalties: critical=12, serious=7, moderate=3, minor=1 per violation
- Per affected element: +weight*0.2 (capped at 10 elements per violation)
- Score: max(0, min(100, 100 - totalPenalty))
- Risk levels: CRITICAL < 40, HIGH < 65, MODERATE < 85, LOW >= 85

---

## Monitoring Cron

- Runs every minute (node-cron in-process)
- Queries monitored_sites where next_scan_at <= now and status != 'paused'
- Runs scanUrl() for each site, saves to monitoring_scans, generates alerts
- Updates next_scan_at based on frequency (daily/weekly/monthly)
- On failure: sets status='warning', retries in 1 hour

---

## Issues Found & Fixed (2026-07-21)

### BUG 1 (CRITICAL): CORS missing PUT and DELETE methods
- File: server.js line 55
- Problem: corsOptions.methods only had ['GET', 'POST', 'OPTIONS']. Monitoring routes use PUT (update site) and DELETE (delete site/scan), causing CORS preflight failures from the browser.
- Fix: Added 'PUT' and 'DELETE' to the methods array.

### BUG 2 (HIGH): Supabase key priority wrong in db.js
- File: db.js line 7
- Problem: SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY - Since .env has SUPABASE_ANON_KEY= (empty), anon key was evaluated first. Service role key (more capable, bypasses RLS) should always be preferred.
- Fix: Swapped to SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY.

### BUG 3 (HIGH): requireAuth.js crashes server at startup
- File: middleware/requireAuth.js lines 6-8
- Problem: Module-level throw new Error(...) executed immediately when the module was require()'d. If env vars weren't available at import time, the entire process would crash.
- Fix: Converted to lazy initialization inside getAdminClient() helper. Now returns 503 per-request instead of crashing on startup.

### BUG 4 (MEDIUM): Dockerfile broken on Debian Bookworm (node:24-slim)
- File: Dockerfile
- Problem: Several system packages were renamed/removed in Debian Bookworm:
  - libasound2 -> libasound2t64
  - libgcc1 -> libgcc-s1
  - libgconf-2-4 removed entirely
  - Missing: libvpx9, libwebp7, libxkbcommon0, fonts-liberation, wget
- Fix: Updated package list to be Bookworm-compatible and added missing Chromium deps.

---

## Known Patterns / Gotchas

1. Schema mismatch fallback: saveScanResults() and createScanPlaceholder() have multi-level fallback logic that strips unknown columns and retries. Handles schema drift gracefully.

2. ai_fix_cache table is optional: getCachedAiFix/saveCachedAiFix auto-disable if the table doesn't exist. No manual config needed.

3. Free scans (no user_id): Anonymous scans have user_id = null. Only accessible via service role key (e.g. GET /report/:scanId). RLS does not expose them to authenticated users.

4. buildFreePaidBoundaryReport() generates AI fixes for ALL violations. The 3-violation limit is enforced in the frontend via hiddenViolationCount.

5. Memory warning in scanner.js: warns when rss < 700MB — means Chromium hasn't consumed much memory yet (may indicate it didn't launch). Railway needs at least 1GB RAM.

6. lib/supabaseAdmin.js exists but is NOT used by any current module. db.js and middleware/requireAuth.js each create their own clients.

7. Background scan polling: Client polls GET /dashboard/scan/:scanId. Status stored in results_json._status (queued | scanning | completed | failed) and results_json._progress (0-100).

8. Stripe is optional: If STRIPE_SECRET_KEY is not set, stripe = null and checkout/webhook/billing-portal routes return 503. Everything else works normally.
