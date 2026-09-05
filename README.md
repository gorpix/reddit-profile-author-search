# Reddit Profile Author Search

A userscript that restores publicly searchable posts and comments directly inside Reddit profiles that hide their activity history.

## Added

- A neutral **Search Author** button beside Reddit's **Feed options** control.
- Automatic `author:"username"` searches for hidden profile activity.
- Separate native results for Reddit's **Posts** and **Comments** tabs using `type=posts` and `type=comments`.
- Reddit's own result components, styling, links, sorting, and continuous loading inside the existing profile feed.
- Safe fallback to Reddit's original hidden-history notice when no results are available or loading fails.

Only public content returned by Reddit Search is shown. The script does not expose private or deleted content.

## Installation

1. Install Tampermonkey, Violentmonkey, or Greasemonkey.
2. [Install the userscript](https://raw.githubusercontent.com/gorpix/reddit-profile-author-search/main/reddit-profile-author-search.user.js).
3. Open another user's Reddit profile. Hidden public results are inserted into the existing **Posts** and **Comments** tabs automatically.
