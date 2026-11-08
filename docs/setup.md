# Set up Manta

[Back to Manta](../README.md)

## Hosting

One running container serves the website, OAuth callback, API and Discord Gateway client. Your computer can be off. Deploy the **Manta-Website** container for the complete product: it fetches a pinned version of this public backend and adds the dashboard. This repository alone provides the bot and API; its Dockerfile does not contain the dashboard. Use `WEB_DIR` to serve a separately checked-out website's built `dist` directory during development.

One Discord server and one service replica per database. Horizontal scaling and multi-server SaaS are not implemented. Keep the cloud service awake so its Discord Gateway connection stays active. The software has no subscription system; cloud hosting can still cost money.

## Environment variables

Set these values in the cloud host's secret/environment settings. Never commit real values.

| Variable | Value |
|---|---|
| `DISCORD_CLIENT_ID` | Discord application ID |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret |
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_GUILD_ID` | The one server ID this instance manages |
| `PUBLIC_URL` | Exact external HTTPS origin, no trailing slash |
| `SESSION_SECRET` | At least 32 random characters; keep stable. Rotation signs everyone out and requires recreating encrypted webhook connections |
| `DATA_DIR` | `/data`, backed by a persistent volume |
| `NODE_ENV` | `production` |
| `PORT` | Host-provided port or `3000` |
| `TRUST_PROXY_HOPS` | `1` only when behind one trusted reverse proxy; otherwise match your topology |
| `MESSAGE_CONTENT_ENABLED` | `false` by default; set `true` and enable the Discord intent for fuller transcript text |

Set the exact Discord OAuth2 redirect to **`https://YOUR_DOMAIN/auth/callback`**. Login requests only `identify`; the bot checks current membership and permissions on protected requests. Enable **Server Members Intent**. Presence Intent is unnecessary. Enable **Message Content Intent** only if using transcript text; access and review requirements are controlled by Discord.

Install in the server using `bot` and `applications.commands` scopes. Give the bot **View Channels, Send Messages, Embed Links, Read Message History, View Audit Log, Manage Channels, Manage Roles, Moderate Members, Kick Members and Ban Members**. Manage Roles is also required for channel permission overwrites. Place its role above members and self-service roles it manages. Do not grant Administrator. Give it access to the staff log channel and ticket category.

The dashboard requires **Manage Server**. Moderation additionally requires the actor's action-specific Discord permission; incident actions require Manage Channels; role panel publication requires Manage Roles; announcement scheduling/sending requires Manage Messages. A manager cannot moderate themselves, the owner, bots or members at/above their own role. Discord additionally enforces the bot's capabilities.

### Railway volume permissions

For Railway specifically, set `RAILWAY_RUN_UID=0` because its volumes are mounted as root. The supplied container entrypoint takes ownership of the data directory and then drops to the `node` user before running the app; the bot does not continue running as root. Leave the image's default start command unchanged. See [Railway volume permissions](https://docs.railway.com/volumes#permissions).

## First sign-in

Open the full app’s URL, sign in with Discord and configure staff channels, the support role, tracking exclusions and routines. Add integrations only after the bot shows as connected. The current [Vercel site](https://manta-website-six.vercel.app/) is a public website deployment; it does not run the bot.

[Operations and data limits](operations.md) · [Integration setup](integrations.md)
