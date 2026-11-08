# CornerstoneLabs AO

CornerstoneLabs AO connects an embedded AI assistant to your application's existing APIs through a managed MCP bridge.

## Run with Docker

**You need** Docker with the `docker compose` command, Node.js 22+ for first-time setup, and a local copy of this repository. Have an OpenAI API key ready if you want to chat with the assistant. You can test API tools without one.

1. Start Docker. Open a terminal in the repository root, where `docker-compose.yml` lives, and run:

   ```sh
   npm ci
   npm run setup:env
   npm run setup:bridge
   ```

2. Open the root `.env`. Set `MCP_BRIDGE_ENABLED=true`. For chat, set `OPENAI_API_KEY` to your key. Set `AO_DOCKER_UID` and `AO_DOCKER_GID` to the numbers returned by `id -u` and `id -g` so Docker can read the generated signing keys.

3. Build and start AO:

   ```sh
   docker compose build api
   docker compose --profile mcp up -d --wait
   ```

4. Open the [AO dashboard](http://localhost:3000). Select **Create an account** to make a workspace, or sign in if you already have one.

For later starts, run just the `up` command. To stop AO and keep your data, run `docker compose --profile mcp stop`.

## Try the demo

If you don't have an application running, follow the [demo installation guide](examples/integration-lab/README.md). It starts a sample app with its own login and task API so you can try the full integration. Demos are off by default.

## Connect your application

### Before you start

- Start your application and verify that a test user can sign in. You need access to edit and redeploy its backend and the page where the assistant will appear.
- Have a running HTTPS JSON API that the AO bridge can reach at a public address. The API must accept a short-lived bearer token for the signed-in user and enforce that user's tenant and record permissions.
- Have the application's browser origin (for example, `https://hris.example.com`), API base URL, server-verified tenant ID, and an OpenAPI JSON/YAML file or details for the endpoints you want to use.
- For a remotely hosted app, use an AO deployment reachable from both the app backend and the user's browser. The Docker URLs above are for local use.

### 1. Set up the assistant in AO

1. Open **MCP Bridges → Set up bridge**. Enter the app name, API base URL, browser origin, and tenant ID. Use a separate AO workspace for each external tenant.
2. Under **API definition**, upload OpenAPI or add a tool manually. Under **Review tools**, enable only the operations the assistant should use. Start with one read.
3. Under **Authentication**, keep `/assistant/session` or enter the same-origin POST path you will add to your app.
4. Click **Validate bridge configuration**, then **Publish reviewed bridge**. Enter an agent name and click **Create agent, publish and deploy**.
5. Select your backend language and click **Download install kit**. You can reopen the kit from **Deployments → Get embed code**. Save the server integration key when AO shows it. If someone else installs the kit, share the key separately through your secret-sharing process.

### 2. Install the kit in your application

1. Unzip the kit. Add its environment settings and the saved integration key to your **application backend**.
2. Use the kit's README to add the session route and connect it to your existing login and logout.
3. Paste `Widget.html` into your app page and restart the app. Sign in and run a read in **Test permitted API tools**. Check that the widget disappears on logout.

[Developer installation guide](docs/host-connectors.md) · [How AO works](docs/architecture.md) · [Bridge operation and troubleshooting](docs/mcp-bridge.md)
