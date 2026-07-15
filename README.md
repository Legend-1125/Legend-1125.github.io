# AniZone

AniZone is a Netflix-inspired anime discovery companion built with HTML, CSS, and vanilla JavaScript.

It uses the AniList GraphQL API as its main data source, with Jikan and MyAnimeList providing additional anime information such as MAL scores, theme songs, and news.

## Features

- Cinematic rotating hero banner
- Trending, top-rated, and seasonal anime sections
- Anime and studio search
- Search suggestions
- Filters by genre, year, season, type, status, score, and adult content
- Sorting by relevance, popularity, score, and release date
- Detailed anime pages
- AniList and MyAnimeList scores
- Cast and voice actor information
- Japanese and English voice actor toggle
- Staff profiles and credits
- Official trailers
- Opening and ending themes
- Related manga
- Recommendations
- Franchise timeline
- Weekly airing schedule
- Anime news
- Local viewing history
- English and Romaji title preferences
- Multiple visual themes
- Responsive design

## Data Sources

- [AniList GraphQL API](https://anilist.co/graphiql)
- [Jikan API](https://jikan.moe/)
- [MyAnimeList](https://myanimelist.net/)

## Technology Stack

- HTML5
- CSS3
- Vanilla JavaScript
- AniList GraphQL API
- Jikan API
- Local Storage
- History API
- Intersection Observer
- CSS Grid and Flexbox

## Technical Highlights

### API Handling

AniZone includes request queues, rate-limit handling, retry logic, request deduplication, caching, and stale-data fallbacks for AniList and Jikan.

### Local Caching

API responses are cached in `localStorage` using different expiration times depending on the type of data.

Cached data includes:

- Trending anime
- Search results
- Anime details
- Airing schedules
- MyAnimeList scores
- Anime news

### Browser Routing

The application uses the browser History API with `pushState`, `replaceState`, and `popstate` to support back and forward navigation without full page reloads.

### Franchise Timeline

AniZone follows AniList prequel and sequel relations to build a chronological franchise timeline.

### Personalization

The following settings are stored locally:

- Viewing history
- Title language
- Voice actor language
- Adult content preference
- Visual theme
- Detail page section preferences

## Project Structure

```text
.
├── index.html
├── styles.css
├── app.js
└── README.md
```

## Setup

Clone the repository:

```bash
git clone https://github.com/Legend-1125/Legend-1125.github.io.git
```

Open the project directory:

```bash
cd Legend-1125.github.io
```

Run a local server:

```bash
python -m http.server 8000
```

Open the application:

```text
http://localhost:8000
```

## Deployment

AniZone is a static application and can be deployed directly using GitHub Pages.

The live site is available at:

```text
https://Legend-1125.github.io/
```

## Notes

- AniZone does not host anime videos.
- Streaming buttons open external websites.
- News and additional MyAnimeList data may occasionally be unavailable because of API limits or third-party service availability.
- Viewing history and preferences are stored only in the current browser.
- No backend or user account is required.

## Disclaimer

AniZone is an unofficial project and is not affiliated with AniList, MyAnimeList, Jikan, Netflix, YouTube, or any anime publisher or streaming provider.

Anime artwork, titles, descriptions, scores, and related metadata belong to their respective owners and data providers.

---

Developed as a responsive anime discovery experience for modern browsers.
