# Developing the Agent Interaction

Once your agent is installed and authenticated, it can begin participating in workflows inside Linear. Agents become active participants through the Agent Session and Agent Activity system—primitives that make agent behavior visible, contextual, and collaborative for end users.

The following sections walk through how your agent will receive instructions though webhooks, how it should communicate back through Agent Activities, and how the Agent Session lifecycle helps track it all.

You can use the [GraphQL schema explorer](https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects) to look up the object types used in agent webhook payloads.

## Agent session

`AgentSession` tracks the lifecycle of an agent run. Session states let the user know if the agent is currently working, waiting for user input, in an error state, or has finished work. An `AgentSession` is created automatically when an agent is mentioned or delegated an issue. 

### Session states

Agent sessions can have one of 5 states: `pending`, `active`, `error`, `awaitingInput`, `complete`. These will be visible to users.

You don’t need to manage agent session state manually. Linear tracks session lifecycle automatically based on the last emitted activity. 

### Session external URL

You can set an `externalUrl` on an `AgentSession` so users can open the current session on your web dashboard. Doing so also prevents a new session from being marked unresponsive.

Use the [`agentSessionUpdate`](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/objects/Mutation?query=agentSessionUpdate#agentSessionUpdate) mutation to set this value. Pass `null` to remove it.

![Agent Session UI showing an Open button that links to the session’s external URL, allowing users to view the session in the agent provider’s dashboard.](https://webassets.linear.app/images/ornj730p/production/9798151670026c1394872ed26256d22cb7271fc2-1698x302.png?q=95&auto=format&dpr=2)

### Session webhooks

An `AgentSession` webhook is sent to notify your agent when it's mentioned, delegated an issue through assignment, or when a user provides additional prompts.

To receive these events, enable the agent session events webhooks category in your OAuth application configuration. 

You must return a response from your webhook receiver within 5 seconds. 

> [!NOTE]
> Once you subscribe to `AgentSessionEvent` webhooks, customers will begin seeing Agent Session UI in Linear. This happens as soon as the event category is enabled, even if you’re only listening for debugging purposes.
> 
> If you receive a `created` event, you are expected to send an activity or update your external URL within 10 seconds to avoid the session being marked as unresponsive.

`AgentSessionEvent` webhooks only send events to your specific agent. 

There will be two types of actions in the `AgentSessionEvent` category, denoted by the action field of the payload:

**Action** | Behavior
--- | ---
`created` | A new Agent Session has been created (triggered by a user mention or delegation). You should start a new agent loop in response. To construct a prompt for your agent, you can utilize the `promptContext` field, a formatted string containing the session’s relevant context, such as issue details, comments, and guidance. Structured data can also be found in the `agentSession.issue`, `agentSession.comment`, `previousComments`, or `guidance` fields. (Guidance refers to any instructions configured at the workspace, parent team, or team level—such as preferred repositories or task constraints.)

Your agent can use this context to determine what action to take.
`prompted` | A user sent a new message into an existing Agent Session. You should insert that message into the conversation history and take action. You should mainly pay attention to the `agentActivity` field’s body, as the user’s input is usually located there.

For a detailed reference of all Agent Session webhook fields, see the [AgentSessionEventWebhookPayload schema](https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/AgentSessionEventWebhookPayload).

### Proactively creating sessions

If your agent was not delegated or mentioned but you would like to proactively create an agent session, you can do so via the SDK or API with the `agentSessionCreateOnIssue` or `agentSessionCreateOnComment` mutations.

## Agent activity

Agents communicate progress by emitting semantic agent activities to an `AgentSession`. These activities can represent thoughts, tool calls, prompts for clarification, final responses, or errors.

### Sending agent activities

Agents should communicate progress by emitting Agent Activities to Linear. These activities can represent thoughts, actions, prompts for clarification, final responses, or errors.

You can emit activities using either the TypeScript SDK or a direct GraphQL mutation:

**TypeScript SDK**

```ts
const { success, agentActivity } = await linearClient.createAgentActivity({
  agentSessionId: "...",
  content: {
    type: "...", 
    ... // other payload fields - see below
  },
});
```

**GraphQL**

```graphql
# Operation
mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity {
      ...
    }
  }
}

# Variables
{
	"input": {
		"agentSessionId": "...",
        # Shape of `content` varies by activity `type`
		"content": {
			"type": "...",
			... # other payload fields - see below
		} 
	}
}
```

To include mentions in Agent Activity content, use plain Linear URLs in Markdown. These will be converted into mentions in the UI. For example:

> [!NOTE]
> https://linear.app/linear/profiles/user, I've created a new Linear issue for tracking the documentation work: https://linear.app/linear/issue/LIN-123/docs-issue — please review.

Renders as: "**@user**, I've created a new Linear issue for tracking the documentation work: **@LIN-123 docs issue** — please review.". 

More on mentions in [Adding mentions in Markdown](https://linear.app/developers/graphql?noRedirect=1#adding-mentions-in-markdown).

### Activity content payload

Your agent may emit one of five allowed activity types. These are validated server-side, and invalid shapes will be rejected. Unless otherwise noted, all fields shown are required. Markdown is supported in `body` fields.

<details>
<summary>thought</summary>
A thought or internal note.

```json
{
  "content": {
    "type": "thought",
    "body": "The user asked about the weather."
  }
}
```
</details>

<details>
<summary>elicitation</summary>
Requests clarification or confirmation from the user.

```json
{
  "content": {
    "type": "elicitation",
    "body": "Where are you located? I will find the current weather for you"
  }
}
```
</details>

<details>
<summary>action</summary>
Describes a tool invocation. You may optionally include a result if the action has completed.

Without result (starting an action):

```json
{
  "content": {
    "type": "action",
    "action": "Searching",
    "parameter": "San Francisco Weather",
    // "result": undefined (optional)
  }
}
```

With result (after completion):

```json
{
  "content": {
    "type": "action",
    "action": "Searched",
    "parameter": "San Francisco Weather",
    "result": "12°C, mostly clear" // Markdown OK
  }
}
```
</details>

<details>
<summary>response</summary>
Indicates work has been completed or a final result is available.

```json
{
  "content": {
    "type": "response",
    "body": "The weather in San Francisco is currently **foggy**, no surprise there."
  }
}
```
</details>

<details>
<summary>error</summary>
Used to report an error or failure.

```json
{
  "content": {
    "type": "error",
    "body": "Out of credits. [Pay up!](https://agent.com/pay)"
  }
}
```
</details>

Additionally, you may see references to a `prompt` type `AgentActivity`. That is a user-generated message, usually as a follow-up prompt or responding to an elicitation. These are the messages that emit a `prompted` webhook to you on creation.

An agent cannot generate a `prompt` type activity.

### Signals

Signals are optional metadata that modify how an [Agent Activity](https://linear.app/developers/agent-interaction#agent-activity) should be interpreted or handled by the recipient. They provide additional context about the sender’s intent—guiding how the activity should be processed or responded to.

For details on available signals and sample usage, see [Signals](https://linear.app/developers/agent-signals).

### Ephemeral activities

When creating an agent activity, you may optionally mark it as `ephemeral`. Ephemeral activities are displayed temporarily, and will be replaced when the next activity arrives from the agent. This could be helpful when displaying temporary states. 

Only `thought` or `action` type activities can be marked ephemeral. 

![Video](https://webassets.linear.app/files/ornj730p/production/41b5d7ff8f2c38b270844c9e6ac56c34eeea9cd0.mp4)

## Agent plans

> [!NOTE]
> The Agent Plan API is currently in a technology preview and may change as we continue development and refine the experience.

Agent Plans allow your agent to provide a session-level checklist of tasks it's working on, designed to evolve during execution. Agents can freely add, modify, or remove entries as they discover new tasks or complete existing ones. 

They’re especially useful when the agent is working through multi-step tasks and needs a way to keep users informed on current and upcoming actions.

The plan is a full array of steps, where each step has a `content` string and a `status`:

```graphql
agentSession.plan = Array<{
  content: string,
  status: "pending" | "inProgress" | "completed" | "canceled"
}>
```

> [!NOTE]
> **Note**: When updating a plan, agents must replace it the existing plan in its entirety. They cannot update the status of just one item.

To update a session’s plan, use the [`agentSessionUpdate` mutation](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/objects/Mutation#agentSessionUpdate):

```graphql
mutation AgentSessionUpdate($agentSessionId: String!, $data: AgentSessionUpdateInput!, ) {
  agentSessionUpdate(id: $agentSessionId, input: $data) {
    success
  }
}

# Variable
{
	data: {
		plan: [
			{
				content: "Update @linear/sdk to v61.0.0 and run npm install",
				status: "inProgress",
			},
			{
				content: "Implement agent plan mutations",
				status: "pending"
			},
			...
		]
	}
}
```

## Recommendations

For recommendations on improving agent interaction—like managing delegation and status updates—continue to [best practices](https://linear.app/developers/agent-best-practices).