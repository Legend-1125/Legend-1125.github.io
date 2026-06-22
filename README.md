# Legend-1125.github.io

# AniZone

AniZone is a premium, Netflix-inspired anime streaming companion application. It provides an elegant, highly visual interface to browse, discover, and track anime titles using the [Jikan API](https://jikan.moe/).

## Features

* **Cinematic Experience**: Designed with a dark, immersive "Netflix-style" interface featuring hero billboards, smooth transitions, and elegant typography.
* **Intelligent Discovery**: Advanced filtering system allowing users to search by genre, year, season, type, status, and rating.
* **Virtual Pagination**: Handles Jikan API quirks by deduplicating entries across API pages, ensuring a consistent grid experience.
* **Detailed Analytics**: View comprehensive anime details, including scores, synopsis, streaming links, and cast profiles.
* **Franchise Timeline**: Automatically traverses relation graphs to visualize a show's franchise timeline (prequels, sequels, side stories).
* **Personalization**: Local storage-based "My List" tracking to save your recent viewing history.
* **Responsive Design**: Optimized for desktop, tablet, and mobile viewing.

## Technology Stack

* **Core**: Vanilla JavaScript (ES6+), HTML5, CSS3.
* **Data**: [Jikan API (v4)](https://jikan.moe/) - The premier open-source API for MyAnimeList.
* **UI/UX**: Custom components, Intersection Observer for image lazy-loading, CSS transitions, and Flexbox/Grid layouts.

## Key Technical Implementation Details

* **Virtual Pagination Engine**: The application implements a buffer-based virtual pagination system. Because Jikan occasionally repeats entries across pages, the app handles raw API responses by deduplicating IDs and filling a cache until a display page of 24 unique items is achieved.
* **Routing & History**: Uses the browser's `History API` (`pushState`, `popstate`) to manage view states, ensuring that back/forward navigation correctly restores the grid state, detail page, or dashboard.
* **Franchise Traversal**: Performs a breadth-first search on anime relation endpoints, intelligently following series-specific relation types (e.g., Prequel, Sequel) to generate a chronological timeline, with retry logic for API rate limiting.
* **Custom Selects**: Replaces standard HTML `<select>` elements with fully styled, custom-owned dropdown panels to ensure consistent rendering and scrolling behavior across embedded webviews.

## Setup & Usage

1.  Clone the repository.
2.  Open `index.html` in any modern web browser.
3.  The app communicates directly with the Jikan API — no backend setup is required.

---
*Developed as a high-performance web interface for anime enthusiasts.*
