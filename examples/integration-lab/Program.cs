using System.Security.Cryptography;
#if AO_CONNECTED
using CornerstoneLabs.Ao;
#endif

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 4096);
var app = builder.Build();
var hostOrigin = Environment.GetEnvironmentVariable("AO_APPLICATION_ORIGIN") ?? "http://localhost:3003";
var state = new LabState();
app.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping.Register(() => state.Clear());
app.Use(async (context, next) => {
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    await next(context);
});
app.UseStaticFiles();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapGet("/openapi.json", () => Results.File(Path.Combine(app.Environment.WebRootPath, "openapi.json"), "application/json"));
app.MapGet("/", async () => {
    var page = await File.ReadAllTextAsync(Path.Combine(app.Environment.WebRootPath, "index.html"));
    var widgetPath = Path.Combine(app.Environment.ContentRootPath, "Widget.html");
    return Results.Content(page.Replace("<!-- AO_WIDGET -->", File.Exists(widgetPath) ? await File.ReadAllTextAsync(widgetPath) : ""), "text/html; charset=utf-8");
});
app.MapPost("/login", (HttpContext request, Login credentials) => {
    if (request.Request.Headers.Origin != hostOrigin) return Results.StatusCode(403);
    // Deliberately public demo credentials; there are no real accounts or records in this app.
    if (credentials.User is not ("alice" or "bob") || credentials.Password != "lab-demo-only") return Results.Unauthorized();
    var login = state.SignIn(credentials.User);
    request.Response.Cookies.Append(LabState.CookieName, login, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = hostOrigin.StartsWith("https://"), MaxAge = TimeSpan.FromHours(1), Path = "/" });
    return Results.Ok(new { user = credentials.User });
});
app.MapGet("/me", (HttpContext request) => state.WebLogin(request) is { } login ? Results.Ok(new { user = login.User, tenant = LabState.Tenant }) : Results.Unauthorized());
app.MapPost("/logout", async (HttpContext request) => {
    if (request.Request.Headers.Origin != hostOrigin) return Results.StatusCode(403);
    var widgets = state.SignOut(request);
    request.Response.Cookies.Delete(LabState.CookieName, new CookieOptions { Path = "/" });
#if AO_CONNECTED
    await Task.WhenAll(widgets.Select(async token => { try { await AoConnector.RevokeAoSession(token); } catch { /* AO expiry is a fallback. */ } }));
#else
    await Task.CompletedTask;
#endif
    return Results.Ok(new { ok = true });
});

// The browser uses the existing login cookie. The bridge uses the same API with
// the app's delegated user bearer token. Invalid bearer credentials never fall back to cookies.
IResult? Authorize(HttpContext request, bool write, out string user) {
    user = state.ApiUser(request) ?? "";
    if (user.Length == 0) return Results.Unauthorized();
    if (write && !request.Request.Headers.ContainsKey("Authorization") && request.Request.Headers.Origin != hostOrigin) return Results.StatusCode(403);
    return null;
}
app.MapGet("/api/tasks", (HttpContext request) => Authorize(request, false, out var user) ?? Results.Ok(state.List(user)));
app.MapPost("/api/tasks", (HttpContext request, TaskInput input) => {
    if (Authorize(request, true, out var user) is { } denied) return denied;
    if (input.Title is not { Length: > 0 and <= 100 } || string.IsNullOrWhiteSpace(input.Title)) return Results.BadRequest(new { error = "Use a title of 1–100 characters." });
    return Results.Ok(state.Create(user, input.Title.Trim()));
});
app.MapPatch("/api/tasks/{id}", (HttpContext request, string id, TaskInput input) => {
    if (Authorize(request, true, out var user) is { } denied) return denied;
    if (input.Done is null) return Results.BadRequest(new { error = "Supply done." });
    return state.Update(user, id, input.Done.Value) is { } row ? Results.Ok(row) : Results.NotFound();
});
app.MapDelete("/api/tasks/{id}", (HttpContext request, string id) => {
    if (Authorize(request, true, out var user) is { } denied) return denied;
    return state.Delete(user, id) ? Results.Ok(new { ok = true }) : Results.NotFound();
});

#if AO_CONNECTED
IntegrationAdapter.State = state;
if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("AO_DEPLOYMENT_ID")) && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("AO_INTEGRATION_KEY")))
    app.MapAoAssistant();
#endif
app.Run();

record Login(string User, string Password);
record TaskInput(string? Title, bool? Done);
record TaskRow(string Id, string Title, bool Done);
record WebLogin(string Id, string User, DateTimeOffset ExpiresAt);

sealed class LabState {
    public const string CookieName = "lab_host_session";
    public const string Tenant = "integration-lab";
    readonly object gate = new();
    readonly Dictionary<string, WebLogin> logins = new();
    readonly Dictionary<string, (string LoginId, DateTimeOffset Expiry)> tokens = new();
    readonly Dictionary<string, Dictionary<string, DateTimeOffset>> widgets = new();
    readonly Dictionary<string, (string User, TaskRow Row)> tasks = new() {
        ["alice-demo"] = ("alice", new("alice-demo", "Review onboarding checklist", false)),
        ["bob-demo"] = ("bob", new("bob-demo", "Prepare the team briefing", false))
    };
    static string RandomToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    WebLogin? Find(string id) => logins.TryGetValue(id, out var login) && login.ExpiresAt > DateTimeOffset.UtcNow ? login : null;
    public string SignIn(string user) { lock (gate) { var id = RandomToken(); logins[id] = new(id, user, DateTimeOffset.UtcNow.AddHours(1)); return id; } }
    public WebLogin? WebLogin(HttpContext context) { lock (gate) return Find(context.Request.Cookies[CookieName] ?? ""); }
    public bool Active(string id) { lock (gate) return Find(id) is not null; }
    public (string Token, DateTimeOffset Expiry)? IssueApiToken(string id) {
        lock (gate) {
            if (Find(id) is not { } login) return null;
            var now = DateTimeOffset.UtcNow;
            foreach (var old in tokens.Where(t => t.Value.Expiry <= now).Select(t => t.Key).ToArray()) tokens.Remove(old);
            var expiry = now.AddMinutes(6);
            if (expiry > login.ExpiresAt) expiry = login.ExpiresAt;
            var token = RandomToken(); tokens[token] = (id, expiry); return (token, expiry);
        }
    }
    public void TrackWidget(string id, string token, DateTimeOffset expiry) {
        lock (gate) {
            if (Find(id) is null) throw new InvalidOperationException("Host login ended");
            if (!widgets.TryGetValue(id, out var list)) widgets[id] = list = new();
            foreach (var old in list.Where(t => t.Value <= DateTimeOffset.UtcNow).Select(t => t.Key).ToArray()) list.Remove(old);
            list[token] = expiry;
        }
    }
    public string? ApiUser(HttpContext request) {
        lock (gate) {
            if (!request.Request.Headers.TryGetValue("Authorization", out var authorization)) return WebLogin(request)?.User;
            var value = authorization.ToString();
            if (!value.StartsWith("Bearer ", StringComparison.Ordinal) || !tokens.TryGetValue(value[7..], out var grant) || grant.Expiry <= DateTimeOffset.UtcNow) return null;
            return Find(grant.LoginId)?.User;
        }
    }
    public string[] SignOut(HttpContext request) {
        lock (gate) {
            var id = request.Request.Cookies[CookieName] ?? ""; logins.Remove(id);
            foreach (var old in tokens.Where(t => t.Value.LoginId == id).Select(t => t.Key).ToArray()) tokens.Remove(old);
            return widgets.Remove(id, out var tracked) ? tracked.Keys.ToArray() : [];
        }
    }
    public TaskRow[] List(string user) { lock (gate) return tasks.Values.Where(t => t.User == user).Select(t => t.Row).ToArray(); }
    public TaskRow Create(string user, string title) { lock (gate) { var row = new TaskRow(Guid.NewGuid().ToString("N"), title, false); tasks[row.Id] = (user, row); return row; } }
    public TaskRow? Update(string user, string id, bool done) { lock (gate) { if (!tasks.TryGetValue(id, out var t) || t.User != user) return null; var row = t.Row with { Done = done }; tasks[id] = (user, row); return row; } }
    public bool Delete(string user, string id) { lock (gate) return tasks.TryGetValue(id, out var t) && t.User == user && tasks.Remove(id); }
    public void Clear() { lock (gate) { logins.Clear(); tokens.Clear(); widgets.Clear(); } }
}
