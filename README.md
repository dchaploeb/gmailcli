# Gmail CLI Label Scanner

A Node.js script to scan Gmail inbox threads, count label occurrences, and
cache thread metadata for faster repeated runs.   This was an experiment and
a learning project; it should not be considered complete or polished, but
it worked for my purposes.

## Features

- Uses Gmail API to fetch inbox threads
- Caches thread label data for performance
- Detects stable threads to skip re-fetching
  (the definition of this is pretty specific to me; as distributed it
  considers all threads "stable" and will only download new threads from
  the API)
- Displays label usage counts in inbox
- Supports custom queries (e.g. unread or untagged thread estimates)

## Setup

1. Clone this repo
2. Run `npm install`
3. Add your `credentials.json` (from Google Cloud Console)
4. Run the script:

    ```
    node gmail-label-counts.js
    ```

5. Authorize on first run

## Files

 - .cache/: Local thread metadata cache
 - token.json: OAuth token (auto-generated after first run)
 - credentials.json: OAuth client secrets from Google (not included)

## Useful Queries
  - `label:inbox` inbox threads
  - `in:inbox is:unread` inbox + unread
  - `in:inbox -label:=p -label:=q -label:=it` useful for me!

## License
MIT
