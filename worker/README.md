# MyAnimeList sync: one-time setup

AniZone can log in to your MyAnimeList account and keep your progress in sync
(status, episodes watched, score). MyAnimeList doesn't let web pages talk to its
API directly, and logging in needs a secret key that must never be put in a
public website. So AniZone uses a tiny **relay** that you own: a free
Cloudflare Worker running [`mal-relay.js`](mal-relay.js).

The relay stores nothing. Your login tokens go straight back to your browser,
and your MyAnimeList password is only ever typed on MyAnimeList's own page.

Time needed: about 10 minutes. Cost: free.

---

## 1. Create the relay (Cloudflare Worker)

1. Sign in or create a free account at <https://dash.cloudflare.com>.
2. Go to **Workers & Pages → Create → Create Worker** (start from "Hello World").
3. Name it `anizone-mal` and click **Deploy**.
4. Click **Edit code**, delete everything in the editor, paste the whole of
   [`mal-relay.js`](mal-relay.js), and click **Deploy**.
5. Copy the Worker's address. It looks like
   `https://anizone-mal.<your-name>.workers.dev`.

## 2. Register AniZone with MyAnimeList

1. Open <https://myanimelist.net/apiconfig> (signed in) and click **Create ID**.
2. Fill in:
   | Field | Value |
   |---|---|
   | App Name | `AniZone` |
   | App Type | **web** |
   | App Description | `Personal anime site that tracks my progress` |
   | App Redirect URL | your Worker address + `/oauth/callback`, e.g. `https://anizone-mal.<your-name>.workers.dev/oauth/callback` |
   | Homepage URL | `https://legend-1125.github.io` |
   | Commercial / Non-Commercial | Non-Commercial |
   | Name / Company Name | your name |
   | Purpose of Use | Hobbyist |
3. Accept the terms and submit. Open the new entry and copy the
   **Client ID** and **Client Secret**.

## 3. Give the relay its settings

In Cloudflare, open your Worker → **Settings → Variables and Secrets** and add:

| Name | Type | Value |
|---|---|---|
| `MAL_CLIENT_ID` | Text | the Client ID |
| `MAL_CLIENT_SECRET` | **Secret** | the Client Secret |
| `ALLOWED_ORIGINS` | Text | `https://legend-1125.github.io,http://localhost:8000` |

Save/deploy. (`ALLOWED_ORIGINS` lists the sites allowed to use your relay:
your live site and local testing. Add others the same way, comma separated.)

## 4. Connect AniZone

1. Open AniZone → click your profile picture → **MyAnimeList → Relay address**.
2. Paste the Worker address, click **Save**, then **Log in with MyAnimeList**.
3. Approve on MyAnimeList's page. You're sent back to AniZone, signed in.

To make your relay the default for every visitor (so nobody has to paste it),
put the address in `RELAY_DEFAULT` near the top of [`../mal.js`](../mal.js).
Anyone who logs in through it uses **their own** MAL account; tokens stay in
their browser.

---

## What it does on the site

- **Anime pages:** a *My progress* panel with status, episodes watched (− / +)
  and score. Changes save to MyAnimeList automatically; quick clicks are grouped
  into one save. Reaching the last episode marks the show *Completed*, like
  MyAnimeList's own site.
- **My List:** your MyAnimeList list in tabs (Watching, Completed, On Hold,
  Dropped, Plan to Watch) with progress bars and a **+1** button, plus your
  AniZone browsing history.
- Changes made on MyAnimeList itself (or another device) show up on AniZone.
- **MAL scores** on anime pages come from MyAnimeList's official API through
  the relay, for every visitor (no login needed). If the relay can't answer,
  AniZone falls back to Jikan.

## Updating the relay

When `mal-relay.js` changes, open the Worker → **Edit code**, replace
everything with the new file, and click **Deploy**. Your settings and secret
stay as they are.

## Troubleshooting

| Message | Fix |
|---|---|
| "This site is not allowed to use the relay" | Add the site's address to `ALLOWED_ORIGINS` exactly (no trailing `/`). |
| "The relay needs MAL_CLIENT_ID and ALLOWED_ORIGINS settings" | Step 3 isn't saved/deployed yet. |
| MAL says the redirect URL is invalid | The App Redirect URL must be exactly your Worker address + `/oauth/callback`. |
| "MyAnimeList refused the login" | Re-copy the Client Secret into `MAL_CLIENT_SECRET`. |
| "Your MyAnimeList login has expired" | Log in again (MAL logins last about a month). |
