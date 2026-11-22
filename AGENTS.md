# Working in this repo

The public privacy-policy site (`index.html` for iOS, `android.html` for Android) and `latest.json`, published to GitHub Pages on every push to `main`. Everything here is public.

- Shared agent rules: `agents/README.md` in the private research checkout beside this one. Docs-only changes go straight to `main`; pull with `--ff-only` first, since the `latest-json` workflow commits every 10 minutes. Never force-push.
- Never edit `latest.json` by hand: the `latest-json` workflow owns it (see README.md).
- Change a policy page together with the game's bundled `Privacy.md` in the matching app repo. Self-tests: `node --test tools/*.test.mjs`.
