# Stock Farmer privacy site

The GitHub Pages site at https://hunterttp.github.io/stock-farmer-privacy/: the privacy policies (`index.html` for iOS, `android.html` for Android) and `latest.json`, which the iOS game's TestFlight builds read to offer an update.

`.github/workflows/pages.yml` publishes the site on every push to `main` (Pages source: GitHub Actions).

## latest.json

Nobody edits `latest.json` by hand. `.github/workflows/latest-json.yml` runs every 10 minutes (and on demand from the Actions tab, optionally as a dry run). It runs `tools/latest-json.mjs`, which asks the App Store Connect API for the app's builds and sets:

- `ios.dev`: the highest version Testing for the internal Dev group;
- `ios.beta`: the highest version Testing for the external Beta group, which is after Beta App Review.

If that changed, the job commits the file and republishes the site. Expiring a build in TestFlight moves its entry back to the previous installable build. A channel with no installable build keeps its entry. Other keys in the file are kept.

The key comes from three Actions secrets, `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_PRIVATE_KEY` (the `.p8` file's contents). Without them the job only leaves a notice. The logs show versions and build states only. Self-tests: `node --test tools/*.test.mjs`.
