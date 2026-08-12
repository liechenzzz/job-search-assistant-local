# UK Visa Jobs Extractor

Fetches job listings from [my.ukvisajobs.com](https://my.ukvisajobs.com) that may sponsor work visas.

## Setup

```bash
npm install
```

If Playwright browsers are skipped in your environment, install Firefox:

```bash
npx playwright install firefox
```

If Camoufox assets are missing, fetch them:

```bash
npx camoufox-js fetch
```

## Configuration

Set the following environment variables:

| Variable | Description |
|----------|-------------|
| `UKVISAJOBS_EMAIL` | Login email for automatic token refresh |
| `UKVISAJOBS_PASSWORD` | Login password for automatic token refresh |
| `UKVISAJOBS_HEADLESS` | Set to `false` to show the browser (default: true) |
| `UKVISAJOBS_MAX_JOBS` | Maximum jobs to fetch (default: 50, max: 200) |
| `UKVISAJOBS_SEARCH_KEYWORD` | Optional search filter |

## Automatic login & cache

The extractor will:

1. Launch a Camoufox (Playwright Firefox) browser and sign in
2. Navigate to the open jobs page and capture the token/cookies
3. Cache the session to `storage/ukvisajobs-auth.json`
4. Reuse the cached values until the API reports an expired token, then refresh

## Running

```bash
npm start
```

Output is written to `storage/datasets/default/` as JSON files.
