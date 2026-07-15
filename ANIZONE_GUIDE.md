# AniZone User and Setup Guide

AniZone is a browser-based anime discovery website powered primarily by AniList, with additional information from MyAnimeList through Jikan and public MyAnimeList news feeds.

This guide explains how to run the website, configure the **Watch on** button, use themes, enable optional 18+ content, browse the schedule and news, manage My List, and use the anime detail pages.

---

## 1. Project Files

The website uses three main files:

```text
index.html   Main page structure
styles.css   Design, layout, themes, and responsive styling
app.js       Search, API requests, settings, history, schedule, news, and other logic
```

All three files must remain in the same folder.

---

## 2. Running AniZone

### Basic local use

You can open `index.html` directly in a browser. However, some browser security settings may block external API requests when a website is opened as a local file.

For more reliable testing, run the folder through a local web server.

### Using Python

Open a terminal inside the AniZone folder and run:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

### Publishing with GitHub Pages

1. Upload `index.html`, `styles.css`, and `app.js` to a GitHub repository.
2. Open the repository's **Settings**.
3. Open **Pages**.
4. Select the branch that contains the website files.
5. Select the root folder and save.
6. Wait for GitHub Pages to publish the site.

The files use relative paths, so they work when published together in the same directory.

---

## 3. Profile Settings

Click the profile picture in the top-right corner to open **Profile Settings**.

The profile panel contains:

- Color theme selection
- 18+ content control
- Watch website selection
- The option to save additional watch websites

The selected settings are stored in the browser using `localStorage`. This means they normally remain selected after refreshing or reopening the website on the same browser and device.

Browser private mode, clearing site data, or using another device will not share these settings.

---

## 4. Configuring the Watch Website

AniZone does not provide or host anime video streams. The **Watch on** button opens a website selected by the user.

By default, AniZone contains one safe example entry:

```text
Name: Read Setup Docs
Link: https://github.com/Legend-1125/Legend-1125.github.io
```

This placeholder helps avoid publishing the site with a third-party streaming service already configured.

### Adding a website

1. Click the profile picture.
2. Find **Watch website**.
3. Click **+ Save website**.
4. Enter a website name, such as:

```text
Crunchyroll
```

5. Enter an HTTPS website address.
6. The new entry is saved and selected automatically.

AniZone allows a maximum of **three saved websites**.

### HTTPS requirement

Only addresses beginning with a valid `https://` protocol are accepted.

Accepted example:

```text
https://example.com
```

Rejected examples:

```text
http://example.com
example.com
javascript:alert(1)
```

This validation reduces the chance of saving insecure or unsafe address types.

### Dynamic anime-title search with `{query}`

Add `{query}` anywhere in the saved address where the anime title should be inserted.

Example template:

```text
https://example.com/search?q={query}
```

When the selected anime is **Frieren: Beyond Journey's End**, AniZone replaces `{query}` with a URL-safe version of that title.

The resulting address will look similar to:

```text
https://example.com/search?q=Frieren%3A%20Beyond%20Journey%27s%20End
```

If the saved website does not contain `{query}`, AniZone opens the saved address without modifying it.

### Selecting a saved website

Each saved website has a radio button.

1. Open Profile Settings.
2. Select the radio button beside the website you want.
3. Close the menu.

The selected website is used by the dynamic **Watch on _Website Name_** button and remains selected after refresh.

### Removing a saved website

Click the **×** beside an entry.

At least one website must remain saved. This prevents the Watch button from having no valid destination.

### Publishing responsibility

The site owner is responsible for deciding which external websites may be added or recommended. AniZone only stores user-entered links locally and opens the selected address. It does not verify whether a third-party website is licensed, safe, legal, or available in a particular country.

---

## 5. Themes

AniZone includes multiple visual themes. Open Profile Settings and select a theme.

Available themes include:

| Theme | Main accent |
|---|---|
| AniZone | Purple |
| Crimson Pulse | Red |
| Sakura | Pink |
| Shōnen | Orange |
| Cyberpunk | Bright neon pink |
| Forest Spirit | Green |

Purple **AniZone** is the default theme.

Every theme uses the same Forest Spirit-style profile image design, recolored to match the active theme.

Theme colors affect interface elements such as:

- Logo highlights
- Active controls
- Loading indicators
- Buttons and badges
- Selected theme markers
- Adult-content filter highlighting when 18+ content is enabled

The selected theme persists after a page refresh.

---

## 6. 18+ Content

18+ content is **disabled by default**.

### Enabling 18+

1. Click the profile picture.
2. Turn on **Enable 18+ content**.
3. Close the profile panel.

The setting is saved in the browser and persists after refresh.

When 18+ content is enabled, an additional adult-content filter appears in applicable Discover and search areas. Its visible control and dropdown use the current theme color so users can easily identify the newly available option.

Available modes may include:

- **Regular Only** — excludes adult titles
- **18+ Only** — shows adult titles
- **Both** or **All Content** — shows regular and adult titles

When 18+ is disabled, adult titles are excluded and the special filter is hidden where applicable.

### Important notice

Users should only enable this feature if they are legally permitted to view adult material in their location and meet the required age. AniZone receives content metadata from external databases and does not independently classify every title.

---

## 7. Home Page

The Home page is the main discovery dashboard.

### Hero banner

The large hero area displays trending anime with:

- Background artwork
- Anime title
- Short synopsis
- Trending and season badges
- **Watch Now** button
- **More Info** button
- Previous and next controls
- Slide indicators

The hero rotates through currently trending titles.

### Trending Now

Shows anime currently receiving strong attention on AniList.

Use **See All** to open a full grid with pagination.

### Top Rated Masterpieces

Shows highly rated anime based on AniList scores.

Use **See All** to browse the expanded list.

### Discover

The Discover section helps find anime using filters such as:

- Genre
- Year
- Season
- Format or type
- Airing status
- Minimum score
- Adult mode, when 18+ is enabled

The expanded Discover grid supports more browsing space and pagination.

### Surprise Me

The **Surprise Me** navigation button chooses an anime for the user and opens its details.

---

## 8. Search

Click the search icon in the navigation bar to expand the search box.

Search supports anime titles and studio names.

### Search suggestions

While typing, AniZone displays matching suggestions. Selecting a title opens its anime detail page. Selecting a studio opens that studio's anime grid.

### Search results

Submitted searches open a full results page. Available filters can include:

- Genre
- Year
- Season
- Format
- Status
- Score
- Adult mode, when enabled
- Sort order

Sort options can include best match, popularity, score, and release date.

### Automatic collapse

The search box collapses when it is no longer being used, including when:

- The user clicks outside it
- The user presses Escape
- The user selects another navigation action
- The page is scrolled while the search box is not focused

This keeps the navigation bar uncluttered.

---

## 9. Anime Detail Pages

Selecting an anime opens a detailed information page.

Depending on data availability, the page may show:

- English, Romaji, and native titles
- Cover and banner images
- Description or synopsis
- Format
- Airing status
- Episode count
- Episode duration
- Start and end dates
- Season and year
- Genres
- Studio information
- AniList score
- MyAnimeList score
- Popularity and favorites
- Rankings
- External links
- Adult-content warning

### Cast and characters

The Cast & Characters section displays characters and voice actors.

Use the language buttons to switch between:

- **JP** — Japanese voice actors
- **EN** — English voice actors

The selected cast language persists locally.

### Episode countdown

For currently airing anime, AniZone may display the next episode number and a countdown until release.

The countdown depends on AniList having a valid upcoming episode time.

### Franchise timeline

The franchise timeline organizes related anime such as:

- Prequels
- Sequels
- Side stories
- Spin-offs
- Alternative versions
- Parent stories

### Official trailer

When trailer information is available, AniZone embeds or links to the official trailer.

### Opening and ending themes

AniZone can display opening and ending song information using available MyAnimeList/Jikan data.

### Related manga

The related manga section shows manga connected to the anime when relationship data is available.

### Key staff

Displays major staff members and their roles.

### Recommendations

Shows other anime recommended in connection with the current title.

### Page section preferences

Click **Page sections** on an anime detail page to show or hide optional sections such as:

- Episode countdown
- Franchise timeline
- Trailer
- Opening and ending themes
- Related manga
- Key staff
- Recommendations

These preferences are stored locally.

---

## 10. Schedule

Open **Schedule** from the navigation bar to view episodes airing during the current week.

The schedule page includes:

- Day navigation
- Anime title
- Episode number
- Release time
- Anime image
- A link to the anime detail page

The schedule uses AniList airing information.

When 18+ content is disabled, adult titles are excluded from the schedule. Changing the 18+ preference refreshes schedule content when necessary.

Schedule data is cached briefly to reduce repeated API requests while still keeping release information reasonably current.

Release times are displayed using the user's browser and device time settings.

---

## 11. My List and History

Open **My List** to view anime previously opened in AniZone.

This feature works as local viewing history rather than a synced AniList or MyAnimeList account list.

### How titles are added

When an anime detail page is opened, AniZone stores a compact history entry containing information such as:

- Anime ID
- Title
- Cover image
- Score
- Format
- Time viewed

The most recently viewed titles appear first.

### History limit

AniZone keeps up to 100 history entries and removes duplicate entries for the same anime.

### Removing one item

Use the remove control on an anime card to delete that entry from local history.

### Clearing all history

Click **Clear History** and confirm the action.

### Persistence

History is saved in browser `localStorage`. It remains after refresh but does not automatically sync across browsers or devices.

---

## 12. News

Open **News** to view recent anime news stories from MyAnimeList.

The News page can show:

- Article image
- Publication date
- Headline
- Short excerpt
- Link to read the full story on MyAnimeList

### Refresh

Click **Refresh** to request updated news instead of relying only on cached results.

### Pagination

Use **Previous** and **Next** to browse additional news pages when available.

### Fallback behavior

If the news feed is temporarily unavailable, AniZone displays an error message and provides a direct link to MyAnimeList News.

News content is loaded from public external sources. Availability can be affected by rate limits, browser cross-origin restrictions, source changes, or network problems.

---

## 13. Title Language

Use the title-language selector in the top navigation bar to choose:

- English
- Romaji

AniZone uses the chosen title format where possible and falls back to another available title when the preferred version is missing.

The selected language persists locally.

---

## 14. Studios

Studio names on anime pages can be opened to browse anime associated with that studio.

Studio result pages support sorting and selected content filters. Adult titles remain excluded unless the 18+ setting permits them.

---

## 15. Data Sources

AniZone uses external services for metadata.

### AniList GraphQL

Used for most core features, including:

- Trending titles
- Top-rated titles
- Search
- Discover filters
- Anime details
- Studios
- Characters and voice actors
- Relations
- Recommendations
- Airing schedule

### Jikan / MyAnimeList data

Used for selected additional information such as:

- MyAnimeList score
- Opening and ending themes
- Some expanded anime metadata

### MyAnimeList public news

Used for the News page.

AniZone is not affiliated with AniList, MyAnimeList, Jikan, Netflix, Crunchyroll, or any saved third-party website.

---

## 16. Caching and Rate Limits

AniZone stores temporary API responses in `localStorage` to improve speed and reduce unnecessary requests.

Different information uses different cache durations. For example:

- Trending data refreshes more frequently
- Search data has a shorter cache
- Anime details remain cached longer
- Schedule data refreshes frequently
- MyAnimeList scores and additional information may remain cached longer

If AniList or Jikan is rate-limited, AniZone may use cached information where available.

A temporary rate-limit message does not necessarily mean the website is broken. Waiting before making more uncached requests may resolve it.

---

## 17. Saved Browser Data

AniZone may store the following locally:

- Active theme
- Selected title language
- 18+ preference
- Adult filter mode
- Voice actor language
- Saved watch websites
- Selected watch website
- My List/history
- Detail-page section preferences
- Temporary API caches

This data stays in the user's browser and is not sent to an AniZone account because the project does not include an account system.

Clearing browser site data resets these preferences and history.

---

## 18. Security and Privacy Notes

- Only HTTPS watch-site addresses are accepted.
- External links should open using safe browser behavior such as `noopener` where implemented.
- AniZone does not store passwords or payment information.
- AniZone does not provide user accounts.
- Saved preferences and history remain in the local browser.
- External APIs and websites receive normal browser requests when their content is loaded or opened.
- The website owner should review external links before publishing them as defaults.

The HTTPS check confirms the protocol only. It does not prove that a website is trustworthy, legal, private, or free of harmful content.

---

## 19. Troubleshooting

### The website opens but no anime appears

Possible causes:

- No internet connection
- AniList is temporarily unavailable
- AniList rate limiting
- Browser extensions blocking requests
- The page was opened as a local file and the browser blocked requests

Try running the site through a local HTTP server and reloading it.

### News is not loading

MyAnimeList may be unavailable, rate-limited, or blocking the browser request. Use the provided direct MyAnimeList News link and try Refresh later.

### MyAnimeList score or theme songs are missing

The anime may not have a MyAnimeList ID, Jikan may be unavailable, or the information may not exist in the source database.

### The Watch button opens the wrong website

1. Open Profile Settings.
2. Check the selected radio button.
3. Confirm that the saved address is correct.
4. Confirm that `{query}` is placed correctly if dynamic search is required.

### A saved website disappeared

AniZone only keeps valid HTTPS entries and limits the list to three. Clearing browser storage also removes custom entries.

### Settings do not persist

Check whether:

- The browser is in private/incognito mode
- Browser storage is disabled
- A privacy extension clears local storage
- Site data was manually deleted
- The website was opened from a different domain or port

Browser storage is separated by origin. For example, settings saved on `localhost:8000` are separate from settings saved on a GitHub Pages address.

### Times in Schedule appear incorrect

Check the device's date, time, and time-zone settings. Schedule times use the browser's local time conversion.

---

## 20. Customization for Developers

### Changing the default watch documentation link

In `app.js`, locate `DEFAULT_WATCH_SITES`:

```javascript
const DEFAULT_WATCH_SITES = Object.freeze([
    {
        id: 'setup-docs',
        name: 'Read Setup Docs',
        url: 'https://github.com/Legend-1125/Legend-1125.github.io'
    },
]);
```

Keep the address HTTPS.

### Changing or adding themes

Theme definitions are stored in the `themes` array inside `initThemes()` in `app.js`.

Each theme contains:

```javascript
{
    id: 'theme-id',
    label: 'Theme Name',
    color: '#HEXCOLOR',
    avatar: THEME_AVATAR_DATA.avatarName
}
```

The matching CSS theme variables are defined in `styles.css` using selectors such as:

```css
:root[data-theme="theme-id"] {
    /* theme variables */
}
```

### Changing the default 18+ behavior

The current build intentionally migrates new and older installations to an off-by-default adult setting. Do not remove those migration values unless you understand how existing browser preferences will be affected.

### Updating API behavior

Core AniList queries and cache settings are located in `app.js`. Be mindful of API rate limits when changing request frequency or cache durations.

---

## 21. Recommended Publishing Checklist

Before publishing AniZone:

- Confirm all three main files are uploaded.
- Test Home, Search, Discover, Schedule, News, and My List.
- Confirm 18+ is off in a fresh browser profile.
- Confirm the default watch entry points only to documentation.
- Test adding, selecting, and removing watch websites.
- Confirm only HTTPS links are accepted.
- Test `{query}` replacement.
- Test every theme and profile image.
- Test mobile and desktop navigation.
- Check external-source attribution and legal requirements for your region.
- Avoid presenting AniZone as officially connected to third-party services.

---

## 22. Quick Start for Users

1. Open AniZone.
2. Use Search or Discover to find an anime.
3. Open an anime card to view details.
4. Click the profile picture to select a theme.
5. In Profile Settings, save an HTTPS watch website.
6. Include `{query}` in the link if the website supports title searches.
7. Select the saved website using its radio button.
8. Use the dynamic **Watch on _Website Name_** button.
9. Open Schedule for weekly episode releases.
10. Open News for recent anime stories.
11. Open My List to revisit previously viewed anime.

---

## Disclaimer

AniZone is an independent anime information and discovery interface. It does not host video content and does not guarantee the accuracy, availability, legality, licensing status, security, or privacy practices of third-party websites. Users and publishers are responsible for complying with applicable laws and the terms of all external services.
