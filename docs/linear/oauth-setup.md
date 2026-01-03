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

## Step 2: OAuth Token Exchange

After the app is created, you need to exchange an authorization code for access tokens.

### Get Authorization Code

1. Navigate to your OAuth app's authorization URL:
   ```
   https://linear.app/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:3000/callback&response_type=code&scope=read,write
   ```

2. Authorize the app in your Linear workspace
3. You'll be redirected to `http://localhost:3000/callback?code=AUTHORIZATION_CODE`
4. Copy the `code` parameter (it expires quickly!)

### Exchange Code for Tokens

Use Bun/Node to exchange the code:

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

### Save Tokens

Add to your `.env` file:

```bash
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
LINEAR_WEBHOOK_SECRET=lin_wh_...
LINEAR_ACCESS_TOKEN=lin_oauth_...
LINEAR_REFRESH_TOKEN=lin_refresh_...
```

## Step 3: Verify Setup

1. Check the @Claude user exists:
   ```bash
   curl -s https://api.linear.app/graphql \
     -H "Authorization: Bearer $LINEAR_ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"query": "{ viewer { id name email } }"}' | jq
   ```

2. Start your webhook server:
   ```bash
   bun --watch run server.ts
   ```

3. Mention @Claude in a Linear issue and verify the webhook is received.

## Token Refresh

Access tokens expire. Use the refresh token to get new ones:

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

const tokens = await response.json();
// Update your .env with new access_token
```

## Important Notes

- OAuth apps can only be created via the Linear UI (no API)
- The `app:mentionable` and `app:assignable` scopes make the app appear in @-mention autocomplete
- Once you subscribe to `AgentSessionEvent` webhooks, customers see Agent Session UI immediately
- You must respond with an activity within 10 seconds of receiving a `created` event
