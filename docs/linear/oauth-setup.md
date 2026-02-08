# Linear OAuth App Setup

Guide for creating and configuring a Linear OAuth app for @-mentionable agents.

## Prerequisites

- Linear workspace with admin access
- ngrok or similar tunneling tool for local development

## Step 1: Create OAuth Application

1. Go to Linear Settings → API → OAuth Applications
2. Click "New OAuth Application"
3. Fill in:
   - **Name**: Your agent name (e.g., "Claude")
   - **Description**: What the agent does
   - **Callback URL**: `http://localhost:3000/callback` (for development)
   - **Webhook URL**: Your ngrok URL + `/webhook` (e.g., `https://xyz.ngrok-free.dev/webhook`)

4. Enable options:
   - **Client credentials** (for server-to-server auth)
   - **Webhooks** (to receive events)

5. Under Webhook Events, enable:
   - **Agent session events** (required for @mentions and delegation)
   - **Inbox notifications** (optional, for richer agent experience)
   - **Permission changes** (optional, for team access tracking)

6. Under Scopes/Permissions, ensure these are enabled:
   - **app:mentionable** (required — lets users @mention the agent)
   - **app:assignable** (required — lets users delegate/assign issues to the agent)

7. Save and note your:
   - `CLIENT_ID`
   - `CLIENT_SECRET`
   - `WEBHOOK_SECRET`

## Step 2: Get App Actor Token

The agent needs an **app actor token** (not a user token) so actions are attributed to "Claude" rather than you.

### Quick Method (Recommended)

From the `claude-linear-agent/` directory:

```bash
cd claude-linear-agent
bun run oauth
```

The script uses `client_credentials` grant to get an app actor token directly — no browser needed. It reads `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` from the root `.env` and writes the new `LINEAR_ACCESS_TOKEN` back there.

After refreshing, verify it works:

```bash
bun run check-token
```

### Manual Method

<details>
<summary>Click to expand manual steps</summary>

```bash
curl -X POST https://api.linear.app/oauth/token \
  -u "CLIENT_ID:CLIENT_SECRET" \
  -d "grant_type=client_credentials&scope=read,write,app:assignable,app:mentionable"
```

</details>

### Where tokens live

All credentials live in the **root** `.env` (`/limbic/.env`), not `claude-linear-agent/.env`:

```bash
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
LINEAR_WEBHOOK_SECRET=lin_wh_...
LINEAR_ACCESS_TOKEN=lin_oauth_...
```

The `bun run oauth` script writes `LINEAR_ACCESS_TOKEN` to the root `.env` automatically.

**Note:** App actor tokens expire after ~30 days. Run `bun run oauth` again to refresh.

## Step 3: Verify Setup

1. Quick token check (read-only, no side effects):
   ```bash
   cd claude-linear-agent
   bun run check-token
   # => Token valid — acting as "Claude" (...) in "iansinnott"
   ```

2. Test the Claude agent SDK query loop (same codepath as the server):
   ```bash
   bun run test-query "What is 2+2? Answer in one sentence."
   # => [1] type=system
   # => [2] type=assistant
   # =>   text: 2+2 equals 4.
   # => [3] type=result subtype=success
   ```

3. Start the dev server (runs both server + ngrok):
   ```bash
   bun run dev
   ```

4. Mention @Claude in a Linear issue and verify the webhook is received.

## Token Refresh

App actor tokens expire after ~30 days. To refresh:

```bash
cd claude-linear-agent
bun run oauth          # fetches new token, writes to root .env
bun run check-token    # verify it works
# then restart the server (new terminal or source .env first)
```

## Alternative: Authorization Code Flow with `actor=app`

<details>
<summary>Click to expand (fallback if client_credentials doesn't grant app scopes)</summary>

**When to use this:** If `client_credentials` doesn't support `app:mentionable` or `app:assignable` scopes (Linear has had bugs with certain scopes on `client_credentials`), use the authorization code flow with `actor=app`. This still creates an app actor token, but goes through the browser authorization step.

You might also need this if:
- Building a public app where many users authorize it
- Need to act on behalf of specific users with their permissions
- Building integrations that require user context (use without `actor=app`)

### Get Authorization Code

1. Navigate to your OAuth app's authorization URL (note `actor=app`):
   ```
   https://linear.app/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000/callback&response_type=code&scope=read,write,app:assignable,app:mentionable&actor=app
   ```

2. Authorize the app in your Linear workspace
3. You'll be redirected to `http://localhost:3000/callback?code=AUTHORIZATION_CODE`
4. Copy the `code` parameter (it expires quickly!)

### Exchange Code for Tokens

```typescript
const response = await fetch("https://api.linear.app/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: "YOUR_CLIENT_ID",
    client_secret: "YOUR_CLIENT_SECRET",
    redirect_uri: "http://localhost:3000/callback",
    code: "AUTHORIZATION_CODE",
  }),
});

const tokens = await response.json();
console.log(tokens);
// { access_token: "lin_oauth_...", refresh_token: "lin_refresh_...", ... }
```

### Refresh User Tokens

User tokens come with a refresh token. Use it to get new access tokens:

```typescript
const response = await fetch("https://api.linear.app/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: "YOUR_CLIENT_ID",
    client_secret: "YOUR_CLIENT_SECRET",
    refresh_token: "YOUR_REFRESH_TOKEN",
  }),
});
```

</details>

## OAuth Scopes Reference

Scopes must be enabled **both** in the OAuth app settings UI **and** requested in the token exchange. If either is missing, the scope won't be granted.

| Scope | Purpose | Required for agents? |
|-------|---------|---------------------|
| `read` | Read access to workspace data | Yes |
| `write` | Write access (mutations) | Yes |
| `app:mentionable` | Allows users to @mention the agent | **Yes** |
| `app:assignable` | Allows users to assign/delegate issues to the agent | **Yes** |
| `issues:create` | Create new issues and attachments | No (covered by `write`) |
| `comments:create` | Create new issue comments | No (covered by `write`) |
| `admin` | Full admin-level access | No |
| `initiative:read` | Read initiative data | No |
| `initiative:write` | Read/write initiative data | No |
| `customer:read` | Read customer data | No |
| `customer:write` | Read/write customer data | No |
| `timeSchedule:write` | Create/modify time schedules | No |

The minimum scopes for our agent: **`read,write,app:assignable,app:mentionable`**

## Troubleshooting

### "One or more app users lack the required scope"

This error appears in the **Linear UI** when a user tries to @mention the agent in a comment. It means the agent's app user doesn't have `app:mentionable` enabled.

**Fix:**
1. Go to the OAuth app settings in Linear
2. Ensure `app:mentionable` (and `app:assignable`) scopes are enabled
3. Re-run `bun run oauth` to get a new token with the updated scopes
4. Restart the server

**Root cause:** The scopes need to be enabled at two levels:
- The OAuth app configuration in Linear's UI (checkboxes/toggles)
- The `scope` parameter in the `client_credentials` token request

If `client_credentials` doesn't support `app:mentionable`, you may need the authorization code flow with `actor=app` instead (see Legacy section below, but use `actor=app` not `actor=application`).

### 401 after refreshing token

If `bun run oauth` succeeds but the server still gets 401s:

1. **Shell env overrides `.env` files.** If `LINEAR_ACCESS_TOKEN` was ever `export`ed in your shell, that stale value takes precedence over the `.env` file. Fix: open a **new terminal**, or run `source ~/code/limbic/.env` to reload.

2. **Server needs a restart.** Env vars are read at boot. After refreshing the token, restart the server (`ctrl+c` then `bun run dev`).

3. **Multiple `.env` files.** Bun loads `.env` from cwd + parent directories. Make sure there's only one `LINEAR_ACCESS_TOKEN` definition — it should be in the root `.env` (`/limbic/.env`), not `claude-linear-agent/.env`. Use `bun run check-token` to verify what bun actually sees.

### Token expired

App actor tokens expire after ~30 days. Run `bun run oauth` to refresh. The script updates the root `.env` automatically. Then restart the server.

### Agent hangs at "Working" with no logs after "Starting agent run"

The agent SDK `query()` hangs silently if given a non-existent `cwd`. Check the `cwd` field in the "Starting agent run" log — if the path doesn't exist on the machine running the server, that's the problem.

The default `REPO_PATH` is derived from the git root. Override it via env if needed:
```bash
REPO_PATH=/path/to/repo bun run dev
```

To test the query loop in isolation: `bun run test-query "hello"`

### Agent shows as "unresponsive"

The first activity must be emitted within 10 seconds of receiving a `created` webhook event. After that, activities can be sent for up to 30 minutes before the session goes stale. A stale session can be recovered by sending another activity.

## Important Notes

- OAuth apps can only be created via the Linear UI (no API)
- The `app:mentionable` and `app:assignable` scopes make the app appear in @-mention autocomplete
- Once you subscribe to `AgentSessionEvent` webhooks, customers see Agent Session UI immediately
- You must respond with an activity within 10 seconds of receiving a `created` event
- The "app user" is the dedicated workspace member created for your OAuth app — it represents the agent identity (e.g., "Claude") and does not count as a billable seat
