#!/usr/bin/env bun
/**
 * Quick read-only check that LINEAR_ACCESS_TOKEN is valid.
 * Run with: bun run check-token
 */

const token = process.env.LINEAR_ACCESS_TOKEN;
if (!token) {
  console.error("LINEAR_ACCESS_TOKEN not set");
  process.exit(1);
}

const response = await fetch("https://api.linear.app/graphql", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    query: `{
      viewer { id name active }
      organization { id name }
    }`,
  }),
});

if (!response.ok) {
  console.error(`HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}

const { data, errors } = (await response.json()) as {
  data?: { viewer: { id: string; name: string; active: boolean }; organization: { id: string; name: string } };
  errors?: Array<{ message: string }>;
};

if (errors?.length) {
  console.error("GraphQL errors:", errors.map((e) => e.message).join(", "));
  process.exit(1);
}

console.log(`Token valid — acting as "${data!.viewer.name}" (${data!.viewer.id}) in "${data!.organization.name}"`);
console.log(`  Active: ${data!.viewer.active}`);
console.log(`  Token prefix: ${token.slice(0, 12)}...`);
