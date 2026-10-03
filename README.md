# ig-publisher

Publishes approved Instagram carousels at a scheduled time (Instagram's own API scheduling doesn't work for this account, so a GitHub Actions cron does it).

- `queue/<folder>/` = `01.jpg…NN.jpg` (1080×1350), `caption.txt` (2 lines), `meta.json` `{publish_at, approved_by_amit, status}`.
- `.github/workflows/publish.yml` runs every 10 min (UTC cron): `bun scripts/publish-queue.mjs`. Manual run: Actions → publish → Run workflow (`dry_run` = build the containers only, publish nothing).
- Publishes only `status: pending` + `approved_by_amit: true` + `publish_at` passed; more than 6 h late → marked `late`, not posted, workflow fails (GitHub e-mails the failure). Idempotent: an existing post with the same first caption line is adopted, never duplicated.
- After success the images/caption are deleted from the working tree and `meta.json` gets `status: published` + `permalink`.
- Secrets: repo Actions secrets `IG_ACCESS_TOKEN`, `IG_USER_ID` only. Never in files, logs or chat. The token lasts 60 days — refresh before it expires (~2026-11-17).
- Add a post (from the main project): `bun scripts/ig-queue-add.mjs <slug> --at <ISO+offset> --approved-by-amit`, then commit + push.
- Tests (mock Instagram, no network/secrets): `bun test/run-tests.mjs`.
