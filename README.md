# IG Public Poller

Polls a public Instagram profile (via Playwright), detects new posts by shortcode, and optionally notifies a Discord channel via webhook.

## Configure

Edit `profiles.json` to set the Instagram accounts to monitor.

## Discord

Set `DISCORD_WEBHOOK_URL` as a repository secret in GitHub.

Optional:
- `NOTIFY_ON_FIRST_RUN=true` to notify on the first run instead of only on subsequent new posts.

## Run locally

```bash
npm install
npx playwright install --with-deps chromium
npm run poll
```

## Notes

This uses scraping of the profile page and may break if Instagram changes its page structure.

