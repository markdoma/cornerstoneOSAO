# Install the assistant in your app

Start with a running app, a test login, and a user-scoped HTTPS API. Ask the AO owner for the install ZIP for your backend and the server integration key. If you're also the AO owner, get these from **Deployments → Get embed code**. The key is shown when it is created or replaced.

## 1. Add the backend settings

Unzip the kit. Copy the settings from `.env.ao.example` into **your app's backend environment**. Set `AO_INTEGRATION_KEY` to the key the AO owner gave you. Keep the key and user API tokens on the server.

The kit fills in the URLs, tenant, deployment, and session path. If your backend uses a different address to reach AO, change `AO_ORIGIN`. Keep `AO_WIDGET_ORIGIN` set to the AO address the user's browser can reach.

## 2. Connect your existing login

Follow the kit's README to add its connector as a **POST** route on your app, usually `/assistant/session`. For Next.js, put the supplied `route.js` and `ao-connector.mjs` together in the route folder. If you use a different framework, choose its matching connector or use the **HTTP / Other** contract from the kit.

Fill in the login function marked in the connector. It has three jobs:

1. **Verify the current login.** Check the user's assistant permission and active tenant. Return the verified user ID, tenant ID, and a short-lived bearer token your API already accepts, with its expiry. The connector keeps the widget hidden until this works.
2. **Recheck that login.** Wire the active-session callback to check the same login, tenant, and permission again. Keep your existing session and CSRF middleware on the route.
3. **Handle logout.** Track the AO widget tokens issued for that login using the connector's callback. Revoke them with the connector's helper when the server logs the user out, and call `window.OrchestratorWidget?.logout()` in the browser.

Your existing API routes keep enforcing who can access each record. Use server-verified identity and permissions. Keep shared admin tokens and identity from browser form fields out of this flow.

## 3. Paste the widget and test

Paste `Widget.html` into the host page and restart your app. In a staging environment:

1. Visit the page signed out. The assistant should stay hidden.
2. Sign in and run a read in **Test permitted API tools**. Check the result against what that user can see in your app.
3. If you enabled a write, test it on a test record. Check that the assistant asks for approval and that only a confirmed action changes the record.
4. Sign out and check that the widget disappears. Sign in as a different user and check that they only see their own records.

## If the widget stays hidden

Check the session POST in your browser's Network tab.

- **404** means the route is missing or its path differs from the embed script.
- **401 or 403** means you should check login, assistant access, tenant, exact origin, and CSRF.
- **502** means you should check that your backend can reach AO and that it has the current integration key.

## If your app needs extra setup

- **CSRF header.** Keep your existing CSRF protection. Render the current session's CSRF token in a meta tag. Set `data-csrf-meta` to the tag name and `data-csrf-header` to your framework's header name on the embed script.
- **Content Security Policy.** Allow the AO widget origin for the loader script and iframe.
- **Multiple tenants.** Use one AO workspace per external tenant. Select the deployment and key on the server from the verified active tenant. On a tenant switch, revoke the old widget sessions and load the new deployment. Test with two tenants before rollout.
- **Refresh data after a write.** Listen for `orchestrator:action-completed` on `window` and refetch using the current login. The event fires after a successful confirmed write.

See [the demo](../examples/integration-lab/README.md) for a working example and the [HTTP contract](../integrations/host-connectors/http.txt) for other frameworks. Verify the connector in your staging app before enabling it in production. The PHP and Java templates still need runtime verification.
