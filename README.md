# Common Ground

A Trump-free world-news front page built from NPR, BBC and Guardian world news.

## Setup

1. Create a new public GitHub repo and push these files to it (`index.html`, `package.json`, `scripts/`, `.github/`).
2. **Settings → Pages**: deploy from branch `main`, folder `/ (root)`.
3. **Settings → Actions → General → Workflow permissions**: choose *Read and write*.
4. *(Recommended)* Get a free Guardian key at https://open-platform.theguardian.com/access/ and add it as a repo secret named `GUARDIAN_KEY`. Without one it uses the shared `test` key, which is rate-limited.
5. **Actions → Fetch news → Run workflow** once. After that it runs every 30 minutes.

## How it works

- The Action reads NPR's and BBC's world RSS feeds (fetching each article page for the text) and calls the Guardian API (falling back to its RSS feed), then writes `news.json`.
- The page reads `news.json`. Opening an article marks it as read; **Re-search** mutes the read ones and fills their slots with the next in line.
- **T-off** hides anything mentioning Trump. **T-mid** allows passing mentions in the body (not in the headline or standfirst, not in the first paragraph, three mentions at most). **T-on** shows everything.
- Read state, article count and filter setting are kept in your browser.

If a source fails, its column keeps the last good set. `news.json` has a `status` note per source saying what happened on the last run.
