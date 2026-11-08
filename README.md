# Manta

Discord server management and activity analytics, without RPGs, XP economies or minigames. Node.js 24+, discord.js, Express and a persistent SQLite database. The dashboard source is [Manta-Website](https://github.com/Fai1th/Manta-Website).

## Free and open source

Manta is licensed under the [MIT License](LICENSE). All included management and analytics features are available without a Manta subscription, license key or premium tier. You can use, modify and redistribute the source, including commercially, while preserving the license and copyright notice. Dependencies retain their own licenses.

There is no required paid Manta service. Run the container on compatible infrastructure you control or choose a hosting provider. Hosting, storage and domain costs are separate from the software; a reliable, permanently free cloud service is not guaranteed. Keep the persistent volume and always-running process required by this version. The `private: true` package field prevents accidental npm publication; it does not restrict the MIT license or GitHub source visibility.

## Architecture

One running container serves the website, OAuth callback, API and Discord Gateway client. Your computer can be off. Deploy the **Manta-Website** container for the complete product: it fetches a pinned version of this public backend and adds the dashboard. This repository alone provides the bot and API; its Dockerfile does not contain the dashboard. Use `WEB_DIR` to serve a separately checked-out website's `public` directory during development.

One Discord server and one service replica per database. Horizontal scaling and multi-server SaaS are not implemented. Keep the cloud service awake; static hosting and request-only serverless hosting cannot run this continuous Gateway client. The software has no subscription system; cloud hosting can still cost money.

## Features

- Moderation cases: warnings, timeouts/removal, kicks, bans/unbans, private staff notes, evidence links, reasons, searchable history and failure records.
- Member reports through slash commands, message context menus and the dashboard; staff assignment, escalation, resolution and appeals. Signed-in banned users can appeal their own cases through the website.
- Private support channels, staff support role, ticket closure, stale-ticket reminders and staff-only JSON transcript export.
- Activity counters for human messages, active members, voice presence, social voice presence, joins/leaves, activation, returning participation, channels and personal statistics. Activity counters never persist message bodies.
- Audit-log ingestion, sensitive-role/permission reviews, channel visibility and unsynced-category findings, configurable join-spike alerts.
- Manual slowmode/lockdown for selected text channels, durable snapshots, and retryable restoration after partial failure.
- Permission-free self-service roles and role menus, welcome guidance, scheduled announcements, weekly staff digests and inactivity review suggestions.
- Discord OAuth login, persistent expiring sessions, CSRF/origin checks, server-side permissions, actor/bot hierarchy checks, request deduplication, input validation, security headers and request throttling.

## Cloud configuration

Set these values in the cloud host's secret/environment settings. Never commit real values.

| Variable | Value |
|---|---|
| `DISCORD_CLIENT_ID` | Discord application ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret |
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_GUILD_ID` | The one server ID this instance manages |
| `PUBLIC_URL` | Exact external HTTPS origin, no trailing slash |
| `SESSION_SECRET` | At least 32 random characters; rotate to invalidate sessions |
| `DATA_DIR` | `/data`, backed by a persistent volume |
| `NODE_ENV` | `production` |
| `PORT` | Host-provided port or `3000` |
| `TRUST_PROXY_HOPS` | `1` only when behind one trusted reverse proxy; otherwise match your topology |
| `MESSAGE_CONTENT_ENABLED` | `false` by default; set `true` and enable the Discord intent for fuller transcript text |

Set the exact Discord OAuth2 redirect to **`https://YOUR_DOMAIN/auth/callback`**. Login requests only `identify`; the bot checks current membership and permissions on protected requests. Enable **Server Members Intent**. Presence Intent is unnecessary. Enable **Message Content Intent** only if using transcript text; access and review requirements are controlled by Discord.

Install in the server using `bot` and `applications.commands` scopes. Give the bot **View Channels, Send Messages, Embed Links, Read Message History, View Audit Log, Manage Channels, Manage Roles, Moderate Members, Kick Members and Ban Members**. Manage Roles is also required for channel permission overwrites. Place its role above members and self-service roles it manages. Do not grant Administrator. Give it access to the staff log channel and ticket category.

The dashboard requires **Manage Server**. Moderation additionally requires the actor's action-specific Discord permission; incident actions require Manage Channels; role panel publication requires Manage Roles; announcement scheduling/sending requires Manage Messages. A manager cannot moderate themselves, the owner, bots or members at/above their own role. Discord additionally enforces the bot's capabilities.

## Operations

After deployment, sign in and configure Settings, Roles & onboarding, and Automation. Staff logs and digest destinations should be private staff channels. Select a staff-only support role before opening tickets. Enable Discord's built-in AutoMod and raid protection separately; Manta complements them and does not replace their native pre-send filtering or CAPTCHA.

`GET /healthz` returns 503 when configured but disconnected, allowing the host to detect failures. A token-free instance serves the connection/setup experience through the website. A normal restart records a new connection event; Gateway disconnects are logged. Gateway events are not guaranteed to be recoverable across outages. Do not interpret message counts as read receipts or voice time as time speaking.

### Data and limits

- Only channels visible to `@everyone` are eligible for automatic activity counting. Bots, AFK voice and manually excluded channels are omitted. Public announcement channels may be counted. Private staff/ticket activity is not counted.
- Voice time is checkpointed each minute, split at UTC midnight; up to one checkpoint may be lost on a hard crash. Long sampling gaps are discarded. Social voice means at least two humans connected, not confirmed conversation.
- Activation/returning participation are approximations from observed join cohorts and UTC day buckets, **not** Discord's private visit-based retention. Existing members aren't retroactively treated as new joins. Rejoining starts a new cohort entry for that member.
- Default retention is 90 days, configurable 30–365. Old records and activity expire. Active incident snapshots and pending announcements remain until handled. Discord channels/messages are not deleted by retention.
- Transcript exports cap at 5,000 available messages, link attachments rather than archive them, and may lack content if Message Content access is disabled. Manta does not continuously archive chat text. Exported files contain private support data and should be handled accordingly.
- Channel lockdown denies Send Messages to `@everyone`; explicit allows can override it. It is not a full server freeze. Restoring a snapshot overwrites subsequent changes to the same setting. Review partial failures before proceeding.
- Crash-interrupted cases and announcements become `review_required`; they are never automatically retried, preventing duplicate punishments/messages. Review Discord state before manually recreating them. Weekly digest delivery is best effort and can repeat after a crash at the send boundary.
- Self-service roles must have no server-level permissions or channel permission grants. Checks run again at assignment. Staff must keep their configuration appropriate.
- Scheduled tasks run every minute while connected. The host must not sleep. Stale channel suggestions require previous observed activity; never-observed channels cannot be classified as inactive.

Back up the persistent volume using your host's snapshot service. For a manual SQLite file copy, stop the service first and preserve the database/WAL consistently. Restore to a separate test service before relying on a backup. Never attach a different guild to the same database; startup enforces the stored guild ID.

Rotate Discord credentials in the Developer Portal and update host secrets if exposed; redeploy afterward. Rotate SESSION_SECRET to invalidate all dashboard sessions. Keep the data volume and environment secrets out of Git.

## Development and verification

`npm ci --ignore-scripts`, `npm test`, `npm run check`. Node's built-in SQLite API may print an experimental warning depending on your Node version. No external database server or build tool is required.

Tests cover database counters, exclusions, retention, validation, hierarchy, anonymous/revoked access, CSRF/origin enforcement, request deduplication, session logout, private case isolation and failed Discord action recording. Live OAuth, real Discord permissions/Gateway delivery, cloud TLS/proxy cookies, Docker deployment and full assistive-technology testing still require an integration environment.

For Railway specifically, set `RAILWAY_RUN_UID=0` because its volumes are mounted as root. The supplied container entrypoint takes ownership of the data directory and then drops to the `node` user before running the app; the bot does not continue running as root. Leave the image's default start command unchanged. See [Railway volume permissions](https://docs.railway.com/volumes#permissions).

Official references: [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2), [Gateway intents](https://docs.discord.com/developers/events/gateway), [permissions](https://docs.discord.com/developers/topics/permissions), [discord.js](https://discord.js.org/docs/packages/discord.js/14.28.1).

## Integrations

The dashboard's Integrations screen configures GitHub public releases, YouTube uploads, Twitch live alerts, Reddit posts, Steam news, WordPress, Medium, Mastodon and standard RSS/Atom feeds. Zapier, Make and generic webhooks (including public n8n endpoints) receive hourly aggregate summaries. Up to 10 connections can run on one instance. These are polling adapters, not a promise of immediate or guaranteed delivery.

Feeds check every 15 minutes. The first successful check establishes a baseline and posts nothing; later checks post at most three newly observed entries per connection. IDs persist across restarts. Short-lived updates between checks or entries that fall out of the source's recent feed can be missed. If the process crashes after Discord accepts a message but before its ID is saved, that update can be repeated. Failures retry on the next interval and appear in the dashboard. Removed posting permissions stop delivery. Pause or remove connections in the dashboard; remove and recreate one to change its source or channel. A request already sent to a provider cannot be recalled.

Public HTTPS sources only: no embedded username/password, private network destinations or local n8n endpoints. Fetches validate and pin DNS results, revalidate redirects, reject feed DTD/entity declarations, and limit time and response size. Text is posted with mentions disabled. Password-protected feeds and private GitHub repositories are not supported. Providers may rate-limit or block public-feed access; Reddit and some Medium/WordPress installations are especially dependent on their access policies. Check connection status rather than assuming a feed is available.

For Twitch, create an application in the [Twitch developer console](https://dev.twitch.tv/console/apps), add `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` to the bot host's secret store, then enter the streamer's username in the dashboard. Manta obtains a server-side app token through the [client credentials flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#client-credentials-grant-flow) and polls [Get Streams](https://dev.twitch.tv/docs/api/reference/#get-streams). Credentials and tokens never go to the browser. This detects live streams, not video uploads or offline notifications.

Webhook destinations receive a JSON POST once an hour, beginning on the next bot cycle. The payload has `source`, `type: activity.summary`, `period: current UTC day`, `at`, and `data` containing `messages`, `activeMembers`, `voiceSeconds`, `joins` and `leaves`. It contains no member IDs, message text or moderation records. Use a Zapier Catch Hook, Make custom webhook, public n8n webhook, or another HTTPS JSON receiver; these services keep their own pricing and limits. This is outbound only; Manta does not accept incoming automation webhooks or grant third parties control over moderation. Destination URLs are encrypted in SQLite with AES-256-GCM using a key derived from `SESSION_SECRET` and are masked in API responses. Keep that secret stable and backed up securely: changing it requires recreating webhook connections. The selected Discord channel acts as the connection owner's permission scope, even when a webhook sends externally.

## Integration verification · 2026-11-08
Focused tests cover public-address restrictions, RSS/Atom/GitHub parsing, XML declarations, duplicate IDs, first-run baselines, pause/resume, failed-send retries, revoked posting permissions, encrypted/masked webhook URLs, aggregate-only payloads and Twitch host credentials. API tests verify anonymous/revoked staff denial, CSRF, validation, pause and removal. A read-only network smoke check successfully parsed GitHub releases (9), YouTube uploads (15), Steam news (10), WordPress news (10) and Reddit posts (20). These counts are test evidence, not product statistics. No live Discord posts, Twitch credentials, Make/Zapier/n8n receivers or private production data were used.
