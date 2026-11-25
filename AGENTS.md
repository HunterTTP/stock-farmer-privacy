# Working in this repo

**Read `../stock-farm-research/agents/README.md` first.** The shared owner rules and coordinator playbook (`agents/ORCHESTRATION.md`) and the update-signaling decision (`../stock-farm-research/decisions/0009-update-signaling.md`) live in that private research repo beside this one. This file holds only what is specific to this repo, and `CLAUDE.md` and `GEMINI.md` import it. Everything here is public.

If `../stock-farm-research` is missing (a cloud agent with only this repo), work on a branch, never force-push or rewrite `main`, never edit `latest.json`, and run `node --test tools/*.test.mjs` before handing back.

- Docs-only and policy changes go straight to `main`; pull with `--ff-only` first, since the `latest-json` workflow commits every 10 minutes. Never force-push or amend pushed commits.
- Never edit `latest.json` by hand: `.github/workflows/latest-json.yml` owns it (see [README.md](README.md) and `../stock-farm-research/decisions/0009-update-signaling.md`).
- Change a policy page (`index.html` for iOS, `android.html` for Android) together with the game's bundled `Privacy.md` in the matching app repo. Self-tests: `node --test tools/*.test.mjs`.
