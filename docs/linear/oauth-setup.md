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
   - **Agent session events** (required for @mentions)

6. Save and note your:
   - `CLIENT_ID`
   - `CLIENT_SECRET`
   - `WEBHOOK_SECRET`

## Step 2: Get App Actor Token

The agent needs an **app actor token** (not a user token) so actions are attributed to "Claude" rather than you.

### Quick Method (Recommended)

Set your credentials in env, then run:

```bash
export LINEAR_CLIENT_ID=your_client_id
export LINEAR_CLIENT_SECRET=your_client_secret
cd claude-linear-agent
bun run oauth
```

The script uses `client_credentials` grant to get an app actor token directly - no browser needed.

### Manual Method

<details>
<summary>Click to expand manual steps</summary>

```bash
curl -X POST https://api.linear.app/oauth/token \
  -u "CLIENT_ID:CLIENT_SECRET" \
  -d "grant_type=client_credentials&scope=read,write"
```

</details>

### Save Tokens

Add to your `.env` file:

```bash
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
LINEAR_WEBHOOK_SECRET=lin_wh_...
LINEAR_ACCESS_TOKEN=lin_oauth_...
```

**Note:** App actor tokens expire after 30 days. Run `bun run oauth` again to refresh.

## Step 3: Verify Setup

1. Check the token works (should show "Claude" as the viewer):
   ```bash
   curl -s https://api.linear.app/graphql \
     -H "Authorization: Bearer $LINEAR_ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"query": "{ viewer { id name } }"}' | jq
   ```

2. Start the dev server (runs both server + ngrok):
   ```bash
   cd claude-linear-agent
   bun run dev
   ```

3. Mention @Claude in a Linear issue and verify the webhook is received.

## Token Refresh

App actor tokens expire after 30 days. Simply run `bun run oauth` again to get a new token.

## Legacy: Authorization Code Flow

<details>
<summary>Click to expand (you probably don't need this)</summary>

**Note:** This flow is NOT needed for the agent use case. The agent needs an **app actor token** (via `client_credentials`) so actions are attributed to the app (Claude), not a user. The authorization code flow creates a **user token** that acts on behalf of whoever authorized it.

You might need this in the future if:
- Building a public app where many users authorize it
- Need to act on behalf of specific users with their permissions
- Building integrations that require user context

### Get Authorization Code

1. Navigate to your OAuth app's authorization URL:
   ```
   https://linear.app/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000/callback&response_type=code&scope=read,write
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

## Important Notes

- OAuth apps can only be created via the Linear UI (no API)
- The `app:mentionable` and `app:assignable` scopes make the app appear in @-mention autocomplete
- Once you subscribe to `AgentSessionEvent` webhooks, customers see Agent Session UI immediately
- You must respond with an activity within 10 seconds of receiving a `created` event
