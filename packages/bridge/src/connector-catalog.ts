// Public, secret-free template metadata shared by the API and dashboard.
export const connectorCatalog = [
  {
    id: 'node',
    label: 'Node.js / TypeScript',
    filename: 'ao-connector.mjs',
    source: 'node.mjs',
    target: 'Node.js 22+ · Next.js route handlers / Web Request',
    mount:
      'For Next.js, install the route.js file from the kit next to ao-connector.mjs in your route folder. Other Node routers can call POST with a Web Request and return its Response.',
    docs: 'https://nextjs.org/docs/app/api-reference/file-conventions/route',
  },
  {
    id: 'dotnet',
    label: 'C# / .NET',
    filename: 'AoConnector.cs',
    source: 'dotnet.cs',
    target: 'ASP.NET Core 8+ · no AO SDK required',
    mount:
      'Save AoConnector.cs in your backend. In Program.cs add using CornerstoneLabs.Ao; and app.MapAoAssistant(); after your existing authentication/authorization middleware. Implement GetVerifiedHostSession using your cookie/session scheme.',
    docs: 'https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/route-handlers',
  },
  {
    id: 'python',
    label: 'Python',
    filename: 'ao_connector.py',
    source: 'python.py',
    target: 'Python 3.11+ · FastAPI + httpx',
    mount:
      'Install fastapi and httpx if needed. Save ao_connector.py, then add from ao_connector import router and app.include_router(router) to your existing FastAPI app. Keep its session middleware and implement get_verified_host_session.',
    docs: 'https://fastapi.tiangolo.com/advanced/using-request-directly/',
  },
  {
    id: 'php',
    label: 'PHP',
    filename: 'ao_connector.php',
    source: 'php.php',
    target: 'PHP 8.1+ · cURL · plain PHP / Laravel route adapter',
    mount:
      'Save ao_connector.php and require_once it from your existing backend. Mount ao_session_response() at the configured POST path behind your session/auth middleware. The file includes plain PHP and Laravel response adapters. For Laravel with cached configuration, map settings through your normal config() service.',
    docs: 'https://laravel.com/docs/requests',
  },
  {
    id: 'go',
    label: 'Go',
    filename: 'ao_connector.go',
    source: 'go.go',
    target: 'Go 1.22+ · net/http · standard library only',
    mount:
      'Save ao_connector.go in an aoconnector package (or change it to your existing package). Create aoconnector.New(), then mount the returned handler with mux.Handle("POST "+os.Getenv("AO_SESSION_ENDPOINT"), connector) behind existing session middleware. Implement getVerifiedHostSession.',
    docs: 'https://pkg.go.dev/net/http',
  },
  {
    id: 'java',
    label: 'Java',
    filename: 'AoConnector.java',
    source: 'java.java',
    target: 'Java 17+ · Spring Boot 3.x · Jackson 2',
    mount:
      'Save AoConnector.java under your Spring Boot component-scan package and add its package declaration. Requires spring-boot-starter-web/Jackson 2. Keep your Spring Security/session/CSRF rules and implement getVerifiedHostSession. Other Java frameworks can use the HTTP contract tab.',
    docs: 'https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-requestmapping.html',
  },
  {
    id: 'http',
    label: 'HTTP / Other',
    filename: 'ao-http-contract.txt',
    source: 'http.txt',
    target: 'Any backend language · HTTPS + JSON',
    mount:
      'Implement this request/response contract in your existing authenticated backend. AO does not require a specific framework or an AO SDK.',
    docs: '',
  },
] as const;
