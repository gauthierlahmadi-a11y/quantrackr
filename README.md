# VentureTrack

Personal internship tracker. Live listings come from SerpApi's Google Jobs API through a protected Vercel proxy. The browser never sees the SerpApi key.

## Layout
```
public/index.html          UI (module script) and app logic
public/lib/                data layer: urlnorm, normalize, matching, planner, searchrun, store (pure, tested)
api/jobs/search.js         proxy: auth -> validation -> rate limit -> SerpApi (bounded retries)
api/auth/login|logout.js   passcode login, signed HttpOnly cookie
api/_lib/                  serpapi mapping, auth, rate limiter, safe logging
tests/                     node:test suite (mocked providers only)
```
Flow: browser -> `/api/jobs/search` (cookie required) -> SerpApi. Nothing is mocked in the app: only real provider results and clearly labelled manual entries are shown.

## Deploy (Vercel)
1. Environment variables: `SERPAPI_API_KEY`, `APP_PASSCODE`, `SESSION_SECRET` (32+ random chars). See `.env.example`.
2. Optional but recommended: add an Upstash Redis / Vercel KV store (sets `UPSTASH_REDIS_REST_*` or `KV_REST_API_*`) so rate limits are persistent and shared.
3. Push to GitHub; Vercel redeploys. Open the site, run a live search, enter the passcode when asked.
Alternative: enable Vercel Deployment Protection on the project and set `ALLOW_UNAUTHENTICATED=1`. That is your assertion that the platform protects the endpoint; the code cannot verify it.
If neither is configured the proxy **fails closed** (503). A fresh deploy of this version will not search until you set `APP_PASSCODE`/`SESSION_SECRET`.

## Access control and rate limiting
- Passcode login issues an HMAC-signed, `HttpOnly; Secure; SameSite=Strict` cookie (14 days). Cross-site requests are refused. Login is limited to 10/hour per client.
- Search limit defaults: 30/hour, 100/day per client. **With Upstash/KV configured the counter is persistent and shared across instances. Without it, it is in-memory per serverless instance: best-effort only, not a global limit.** The passcode is then your real protection.
- Remaining limitation: a stolen passcode or cookie can spend your allowance until it expires/rotates. Rotate `SESSION_SECRET` to revoke all sessions.

## Search credits
The planner shows queries, the maximum first-page requests, extra-page allowance, expected cache reuse and an estimated maximum of new provider searches. This is an estimate, not billing. Per SerpApi's documentation successful searches count; cached, errored and failed ones do not, and its own cache lasts about an hour ([pricing](https://serpapi.com/pricing), [Google Jobs API](https://serpapi.com/google-jobs-api)). The app reports "requests made", never exact credits. Default Paris preset: up to 3 searches, 1 page each. Pages are only fetched when you click "Load more" and enable extra pages; they count against the same per-run budget.
Google's `chips` date filter is deprecated, so "hide posts older than N days" is a local filter applied only to listings whose posted date could be parsed.

## Local cache
Separate localStorage key (`ventureTrack.searchCache.v1`), stores provider results with retrieval time and parameters, TTL 12 h, never secrets. Stale entries are ignored (not shown as current). "Clear search cache" never touches applications.

## Source attribution and "source checked"
Each job keeps source records: search provider (SerpApi/Google Jobs), listing source as reported (LinkedIn, Indeed, ...), listing URL, every application option, retrieval time, query, and why records were matched. A name in the results is not proof that site was searched directly. **"Source checked" only ever means you recorded a manual check**; the app does not fetch listing pages. "No longer returned by this search" is not "closed". Completeness measures which fields exist, not truth.

## Duplicate matching (public/lib/matching.js)
- Strong (auto-merge): same provider job ID on the same platform (for Google Jobs the stable `htidocid`, since `job_id` strings vary per query), or same job-specific URL, with no conflicting employer, requisition ID or platform ID.
- Probable (review, never auto-merged): same employer, title similarity >= 0.8, same city, compatible type/year/posting date.
- None: missing data, different employer/ID/requisition, different city or role. Generic careers pages and Google search pages without a job ID never match.
- Manual entries are only ever "possibly tracked".

## Old merged records
On first load data is migrated (backup stored under `ventureTrack.backup.*`, nothing deleted). Records whose sources look unrelated are flagged; open "Review previously merged sources" to export, detach sources (kept in the record), re-search, or review legacy cached listings without spending credits. The original 22 listings can only be recovered if your browser still holds the old cache.
Export first: sidebar "Export data".

## Troubleshooting
quota: SerpApi allowance used up. auth: server key rejected (check Vercel) vs sign-in required. timeout/network/provider: retry only failed queries. invalid response: the provider shape changed; the request id in the message is logged server-side. Partial failure: successful pages are kept.

## Tests
`npm test` (Node >= 18). Provider calls are mocked; no live SerpApi call is made by tests.
