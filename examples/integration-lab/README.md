# Run the AO demo with Docker

Use **Taskroom** if you don't have an app to connect. It has its own login, API, and sample tasks. You will install the same connector and embed code that a real application developer receives.

## 1. Start the demo app

First complete [Run with Docker](../../README.md#run-with-docker) and sign in to AO. Then, from the **repository root**, run:

```sh
docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile integration-lab build integration-lab
docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile mcp --profile integration-lab up -d --wait
```

Open [Taskroom](http://localhost:3003). Sign in as **Alice** with password `lab-demo-only` and check that her tasks load. **Bob** uses the same demo password and has his own tasks. Demo records reset when the app restarts.

## 2. Publish a demo assistant in AO

1. In the [AO dashboard](http://localhost:3000), use a workspace dedicated to the demo. Go to **MCP Bridges → Set up bridge**.
2. Turn on **Use demo app settings**, choose **Taskroom**, and enter `integration-lab` as the external tenant ID. The preset fills in the API URL, browser origin, and `/api/ao/session` path.
3. Save the [Taskroom OpenAPI file](http://localhost:3003/openapi.json) and upload it under **API definition**. Select and enable `list_tasks` as a read. To try a write, also enable `create_task` as a write.
4. Click **Validate bridge configuration**, **Publish reviewed bridge**, and **Create agent, publish and deploy**. Choose **C# / .NET**, download the install kit, and save the server integration key shown by AO.

## 3. Install the kit in Taskroom

Make the following changes in `examples/integration-lab/`:

1. Copy `AoConnector.cs` from the kit into this folder. Replace the example `GetVerifiedHostSession` method with:

   ```csharp
   static Task<AoHostSession?> GetVerifiedHostSession(HttpContext context) =>
       IntegrationAdapter.GetVerifiedHostSession(context);
   ```

   Taskroom already provides the login adapter and mounts the session route when the connector and credentials are present.

2. Copy the kit's `.env.ao.example` values into this folder's `.env`. Set `AO_INTEGRATION_KEY` to the saved key and set `AO_ORIGIN=http://127.0.0.1:4000` so the Taskroom container can reach AO. Keep `AO_WIDGET_ORIGIN=http://localhost:4000` for the browser.
3. Copy the kit's `Widget.html` into this folder. Taskroom inserts it into the page automatically.

From the **repository root**, rebuild the demo:

```sh
docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile integration-lab up -d --build --no-deps integration-lab
```

## 4. Test the assistant

1. Open [Taskroom](http://localhost:3003) while signed out. The assistant should be hidden.
2. Sign in as Alice. Open **Test permitted API tools** in the assistant and run `list_tasks` with `{}`. If you enabled `create_task`, run it with `{"body":{"title":"Rehearsal task"}}`, approve the change, and check the task list.
3. Sign out, then sign in as Bob. Verify that he sees only his own tasks. These tool tests work without an OpenAI API key.

## Alternative demo with a built-in connector

Use **Taskboard** for a shorter setup that skips installing the connector file. From the repository root, run:

```sh
docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile mcp --profile demo up -d --wait
```

1. In a separate AO workspace for Taskboard, open **Set up bridge**. Turn on **Use demo app settings** and choose **Taskboard**. Enter a demo tenant ID such as `taskboard-demo`. Import the [Taskboard OpenAPI file](http://localhost:3002/openapi.json), review the tools, and publish the assistant as above.
2. In the **repository root** `.env`, set `SAMPLE_TENANT_ID` to the same demo tenant ID, then set `SAMPLE_DEPLOYMENT_ID` and `SAMPLE_INTEGRATION_KEY` from AO.
3. Run the Taskboard startup command again. Open [Taskboard](http://localhost:3002), click **Sign in as Alice**, and test a read in the assistant.

## Stop the demo

From the repository root, stop AO and any enabled demo while keeping the AO database:

```sh
docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile "*" stop
```

To start AO alone again, use the standard [Docker startup command](../../README.md#run-with-docker).
