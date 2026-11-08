# Manta project instructions

The bot, API and persistent database live here. The frontend lives in `Fai1th/Manta-Website` and pins a full backend commit in its Dockerfile.

- Use Node 24+. Setup: `npm ci --ignore-scripts`. Verify changes with `npm test` and `npm run check`; API tests need loopback networking.
- Keep Discord permissions, actor/bot hierarchy, CSRF, per-user record isolation and input validation on the server. Never commit secrets or database files.
- Preserve pending announcements and unrestored incident snapshots during retention cleanup. Tests document this recovery requirement.
- This version manages one guild per service/database. Do not silently turn it into a multi-guild service or scale it to multiple replicas.
- The user requests committing and immediately pushing completed work. Verify meaningful changes before pushing, and do not force-push unrelated history.

## Optional local project memory

When available, read `D:/Obsidian/CS-Notes/Codex/Projects/Manta.md` and only its relevant linked notes. Verify remembered claims against current code and executed checks. Keep shared requirements and runnable verification in the repositories. Update the brief with evidence and commit after authorized work; never put credentials or production records in the vault. If the local vault is unavailable, continue from repository evidence and report that limitation.
