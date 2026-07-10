# Auth gateway

The optional `@getpaseo/auth-gateway` package adds organization login in front of a
self-hosted Paseo daemon. The daemon remains local-first and account-free by default;
operators opt into the gateway when a shared deployment needs individual sessions.

## Boundary

The gateway is a separate process and the only public route to the daemon:

```text
browser -> TLS proxy/tunnel -> auth gateway -> private Paseo daemon
```

It owns Google OAuth, Better Auth sessions, SQLite persistence, HTTP authorization,
and WebSocket upgrade authorization. It does not add user isolation inside the daemon.
Every admitted user remains a trusted operator with the daemon user's filesystem,
terminal, and agent authority.

The daemon must not retain a second public route that bypasses the gateway. Put both
containers on a private network and publish only the gateway's port.

## Configuration

| Variable                          | Purpose                                            |
| --------------------------------- | -------------------------------------------------- |
| `PASEO_AUTH_PUBLIC_URL`           | Public HTTPS origin, with no path                  |
| `PASEO_AUTH_UPSTREAM_URL`         | Private daemon origin, such as `http://paseo:6767` |
| `PASEO_AUTH_DATABASE_PATH`        | SQLite path; defaults to `/data/auth.sqlite`       |
| `PASEO_AUTH_GOOGLE_HOSTED_DOMAIN` | Required Google Workspace hosted domain            |
| `PASEO_AUTH_SESSION_HOURS`        | Fixed session lifetime; defaults to 12 hours       |
| `BETTER_AUTH_SECRET`              | At least 32 random characters                      |
| `GOOGLE_CLIENT_ID`                | Google OAuth web client ID                         |
| `GOOGLE_CLIENT_SECRET`            | Google OAuth web client secret                     |
| `GITHUB_CLIENT_ID`                | GitHub App client ID for account linking           |
| `GITHUB_CLIENT_SECRET`            | GitHub App client secret                           |
| `GITHUB_APP_ID`                   | App ID used to mint installation tokens            |
| `GITHUB_APP_INSTALLATION_ID`      | Installation ID for the organization               |
| `GITHUB_APP_PRIVATE_KEY`          | PEM text (or base64 PEM) for installation auth     |
| `PASEO_OFFICE_SHARED_SECRET`      | Internal identity/token broker bearer secret       |
| `PORT`                            | Gateway listen port; defaults to `8080`            |

The Google OAuth client needs this authorized redirect URI:

```text
<PASEO_AUTH_PUBLIC_URL>/api/auth/callback/google
```

When GitHub linking is configured, the GitHub App needs this callback URL:

```text
<PASEO_AUTH_PUBLIC_URL>/api/auth/callback/github
```

Google remains the login gate. GitHub is an explicitly linked secondary identity at
`/auth/account`; a GitHub account cannot create a Paseo account on its own.

`hd` is enforced against Google's verified hosted-domain claim. The gateway does not
trust a user-entered email suffix.

## Multiplayer commit attribution

The gateway maps a linked Better Auth user to the GitHub account row. Slack senders are
matched to that same user by the email returned by Chat SDK. The daemon asks the internal
identity endpoint for the co-author address before each turn. Linked users receive their
GitHub ID-based noreply address; unlinked users use the configured fallback
(`vivek@affil.ai` in the Affil deployment).

The daemon installs a managed `commit-msg` hook through process-scoped Git configuration.
It does not write hooks into project repositories. Each agent process already has a stable
`PASEO_AGENT_ID`, so the hook reads the attribution for the human who initiated the active
turn. Delegated child agents inherit their parent's current attribution. A later turn from
another Paseo or Slack user replaces the attribution before that turn starts.

Configure the daemon with:

| Variable                          | Purpose                                                 |
| --------------------------------- | ------------------------------------------------------- |
| `PASEO_IDENTITY_RESOLVER_URL`     | Gateway `/api/office/identity/resolve` URL              |
| `PASEO_IDENTITY_RESOLVER_SECRET`  | Same value as `PASEO_OFFICE_SHARED_SECRET`              |
| `PASEO_GITHUB_APP_TOKEN_URL`      | Gateway `/api/office/github/token` URL                  |
| `PASEO_GITHUB_APP_TOKEN_SECRET`   | Same value as `PASEO_OFFICE_SHARED_SECRET`              |
| `PASEO_ATTRIBUTION_DEFAULT_EMAIL` | Commit fallback when the requester has no linked GitHub |
| `PASEO_GITHUB_BOT_NAME`           | Commit author, normally `office-of-the-cto[bot]`        |
| `PASEO_GITHUB_BOT_EMAIL`          | GitHub noreply address for the app bot account          |

The GitHub App requires repository Contents write and Pull requests write. Installation
tokens are short lived and brokered on demand; the private key remains in the gateway.

## Container

Build from the repository root:

```bash
docker build -f docker/auth-gateway/Dockerfile -t paseo-auth-gateway .
```

Mount `/data` persistently. The gateway runs SQLite migrations on startup, stores OAuth
tokens encrypted, and exposes unauthenticated `GET /healthz` for the container platform.

## Proxy behavior

- Browser navigations without a session redirect to `/auth/login`.
- Unauthenticated API calls return JSON `401`.
- WebSocket upgrades are authenticated before the upstream socket opens.
- Cross-origin WebSocket upgrades and cross-origin mutations are rejected.
- Session cookies and client-supplied identity headers are stripped before proxying.
- The verified email is forwarded as `x-paseo-authenticated-user-email`. The existing
  Cloudflare-compatible email header is also populated while the web UI migrates to the
  generic header.

Better Auth routes live under `/api/auth/*`. Keep this path and `/auth/*` on the gateway;
do not route them to the daemon.

Users can end the current browser session at `/auth/logout`.
