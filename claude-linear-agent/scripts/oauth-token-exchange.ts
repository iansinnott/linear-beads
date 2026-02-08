#!/usr/bin/env bun
/**
 * OAuth Token Helper
 *
 * Gets an app actor token using client_credentials grant.
 * This token acts as the OAuth app itself (e.g., Claude), not a user.
 *
 * Run with: bun run oauth
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

const OAUTH_APP_URL = "https://linear.app/iansinnott/settings/api/applications/4be21ae3-87f0-43a1-833f-114b7cc2c646";
// Write to root .env (where client credentials live), not claude-linear-agent/.env.
// Bun loads .env from cwd + parent dirs, and root takes precedence.
const ENV_PATH = path.join(import.meta.dir, "..", "..", ".env");

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("\n🔐 Linear OAuth - App Actor Token\n");
  console.log("This gets a token that acts as the OAuth app (Claude), not as you.\n");

  // Get credentials
  let clientId = process.env.LINEAR_CLIENT_ID;
  let clientSecret = process.env.LINEAR_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log("Find your credentials at:");
    console.log(`${OAUTH_APP_URL}\n`);
  }

  if (!clientId) {
    clientId = await prompt("Enter LINEAR_CLIENT_ID: ");
  } else {
    console.log(`Using LINEAR_CLIENT_ID from env: ${clientId.slice(0, 8)}...`);
  }

  if (!clientSecret) {
    clientSecret = await prompt("Enter LINEAR_CLIENT_SECRET: ");
  } else {
    console.log(`Using LINEAR_CLIENT_SECRET from env: ${clientSecret.slice(0, 8)}...`);
  }

  if (!clientId || !clientSecret) {
    console.error("\n❌ CLIENT_ID and CLIENT_SECRET are required");
    process.exit(1);
  }

  console.log("\n⏳ Getting app actor token (client_credentials)...\n");

  try {
    // Use HTTP Basic Auth as per OAuth spec
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const response = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "read,write,app:assignable,app:mentionable",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`\n❌ Token request failed (${response.status}):`);
      console.error(error);
      console.error("\nMake sure 'Client credentials' is enabled in your OAuth app settings:");
      console.error(OAUTH_APP_URL);
      process.exit(1);
    }

    const tokens = (await response.json()) as {
      access_token: string;
      token_type: string;
      expires_in?: number;
      scope?: string;
    };

    console.log("✅ Got app actor token!\n");

    // Verify the token works
    console.log("⏳ Verifying token...\n");

    const verifyResponse = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        query: "{ viewer { id name } }",
      }),
    });

    const verifyData = (await verifyResponse.json()) as {
      data?: { viewer: { id: string; name: string } };
    };

    if (verifyData.data?.viewer) {
      const { id, name } = verifyData.data.viewer;
      console.log("✅ Token verified! Acting as:");
      console.log(`   Name: ${name}`);
      console.log(`   ID: ${id}`);
    } else {
      console.log("⚠️  Could not verify token (but it may still work)");
    }

    // Write token to .env file
    let envContent = "";
    if (fs.existsSync(ENV_PATH)) {
      envContent = fs.readFileSync(ENV_PATH, "utf-8");
    }

    const tokenLine = `LINEAR_ACCESS_TOKEN=${tokens.access_token}`;
    const expiryComment = tokens.expires_in
      ? `# Token expires: ${new Date(Date.now() + tokens.expires_in * 1000).toISOString()}`
      : "";

    if (envContent.includes("LINEAR_ACCESS_TOKEN=")) {
      // Replace existing token
      envContent = envContent.replace(
        /^(# Token expires:.*\n)?LINEAR_ACCESS_TOKEN=.*/m,
        (expiryComment ? expiryComment + "\n" : "") + tokenLine
      );
    } else {
      // Append token
      const newLines = [
        ...(envContent.length > 0 && !envContent.endsWith("\n") ? ["\n"] : []),
        ...(expiryComment ? [expiryComment] : []),
        tokenLine,
        "",
      ];
      envContent += newLines.join("\n");
    }

    fs.writeFileSync(ENV_PATH, envContent);
    console.log(`\n✅ Wrote LINEAR_ACCESS_TOKEN to ${ENV_PATH}`);
    if (tokens.expires_in) {
      console.log(`   Expires: ${new Date(Date.now() + tokens.expires_in * 1000).toISOString()} (${tokens.expires_in / 86400} days)`);
    }

    console.log("\n🎉 Setup complete!\n");
  } catch (error) {
    console.error("\n❌ Error getting token:");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
