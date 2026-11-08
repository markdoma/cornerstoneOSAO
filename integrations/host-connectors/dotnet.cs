// ASP.NET Core 8+, save as AoConnector.cs. No AO SDK or NuGet package required.
// Register app.MapAoAssistant() after existing authentication/authorization middleware.
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace CornerstoneLabs.Ao;
public sealed record AoAccess(string Token, DateTimeOffset ExpiresAt, string DeploymentId, string WidgetOrigin);
public sealed record AoHostSession(string UserId, string TenantId, string ApiToken, DateTimeOffset ExpiresAt,
    Func<Task<bool>> IsActive, Func<AoAccess, Task> OnIssued, string? EmployeeId = null, string[]? ToolIds = null);
public static class AoConnector {
    static string Env(string name) => Environment.GetEnvironmentVariable(name) ?? throw new InvalidOperationException("Configure " + name);
    static string Origin(string name, string? fallback = null) {
        var value = Environment.GetEnvironmentVariable(name) ?? fallback ?? throw new InvalidOperationException("Configure " + name);
        var u = new Uri(value); bool local = Environment.GetEnvironmentVariable("AO_ALLOW_LOCALHOST") == "true" && (u.Host is "localhost" or "127.0.0.1" or "[::1]");
        if (u.GetLeftPart(UriPartial.Authority) != value || u.UserInfo != "" || (u.Scheme != "https" && !(local && u.Scheme == "http"))) throw new InvalidOperationException("Configure exact HTTPS origins");
        return value;
    }
    // REQUIRED: replace with your existing verified cookie/session + assistant authorization.
    // Resolve user, active tenant, native user API token and expiry server-side.
    // IsActive must recheck that same login/tenant. OnIssued must store access by
    // host login session for server-side logout revocation. Never trust browser JSON identity.
    static Task<AoHostSession?> GetVerifiedHostSession(HttpContext context) => Task.FromResult<AoHostSession?>(null);

    static readonly HttpClient Client = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(10) };
    static async Task<string> Post(string origin, string path, string token, object payload, string? hostOrigin = null) {
        using var message = new HttpRequestMessage(HttpMethod.Post, origin + path) { Content = JsonContent.Create(payload) };
        message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (hostOrigin is not null) message.Headers.Add("X-Host-Origin", hostOrigin);
        using var response = await Client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Assistant unavailable");
        using var stream = await response.Content.ReadAsStreamAsync(); using var buffer = new MemoryStream(); var chunk = new byte[1024]; int read;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while ((read = await stream.ReadAsync(chunk, timeout.Token)) > 0) { if (buffer.Length + read > 16000) throw new InvalidOperationException("Response too large"); buffer.Write(chunk, 0, read); }
        return System.Text.Encoding.UTF8.GetString(buffer.ToArray());
    }
    public static Task<string> RevokeAoSession(string token) => Post(Origin("AO_ORIGIN"), "/v1/widget/revoke", token, new {}, Origin("AO_APPLICATION_ORIGIN"));
    public static void MapAoAssistant(this IEndpointRouteBuilder routes) {
        var origin = Origin("AO_ORIGIN"); var appOrigin = Origin("AO_APPLICATION_ORIGIN"); var widgetOrigin = Origin("AO_WIDGET_ORIGIN", origin);
        var deployment = Env("AO_DEPLOYMENT_ID"); var key = Env("AO_INTEGRATION_KEY"); var tenant = Env("AO_TENANT_ID");
        routes.MapPost(Environment.GetEnvironmentVariable("AO_SESSION_ENDPOINT") ?? "/assistant/session", async (HttpContext context) => {
            context.Response.Headers.CacheControl = "no-store"; context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            if (context.Request.Headers.Origin != appOrigin) return Results.StatusCode(403);
            if (context.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) != true) return Results.StatusCode(415);
            AoAccess? issued = null;
            try {
                using var buffer = new MemoryStream(); var chunk = new byte[512]; int read;
                while ((read = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) > 0) { if (buffer.Length + read > 2048) return Results.StatusCode(413); buffer.Write(chunk, 0, read); }
                JsonDocument document;
                try { document = JsonDocument.Parse(buffer.Length == 0 ? "{}"u8.ToArray() : buffer.ToArray()); } catch (JsonException) { return Results.BadRequest(new { error = "Invalid JSON" }); }
                using var disposeDocument = document;
                if (document.RootElement.ValueKind != JsonValueKind.Object) return Results.BadRequest();
                if (document.RootElement.TryGetProperty("deploymentId", out var requested) && (requested.ValueKind != JsonValueKind.String || requested.GetString() != deployment)) return Results.StatusCode(403);
                var host = await GetVerifiedHostSession(context);
                if (host is null || string.IsNullOrWhiteSpace(host.UserId) || string.IsNullOrWhiteSpace(host.ApiToken) || host.ApiToken.Contains('\r') || host.ApiToken.Contains('\n') || host.ExpiresAt <= DateTimeOffset.UtcNow.AddSeconds(5) || !await host.IsActive()) return Results.Unauthorized();
                if (host.TenantId != tenant) return Results.StatusCode(403);
                var payload = new Dictionary<string, object?> { ["deploymentId"] = deployment, ["userId"] = host.UserId, ["tenantId"] = host.TenantId, ["origin"] = appOrigin, ["apiToken"] = host.ApiToken, ["apiTokenExpiresAt"] = host.ExpiresAt.UtcDateTime };
                if (host.EmployeeId is not null) payload["employeeId"] = host.EmployeeId;
                if (host.ToolIds is null) payload["useDeploymentTools"] = true; else payload["toolIds"] = host.ToolIds;
                var raw = await Post(origin, "/v1/widget-sessions", key, payload);
                var access = JsonSerializer.Deserialize<AoAccess>(raw, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (access is null || access.Token is null || !Regex.IsMatch(access.Token, "^[a-zA-Z0-9_-]{43}$") || access.DeploymentId != deployment || access.WidgetOrigin != widgetOrigin || access.ExpiresAt <= DateTimeOffset.UtcNow || access.ExpiresAt > host.ExpiresAt || access.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(5)) throw new InvalidOperationException("Invalid assistant response");
                issued = access;
                if (!await host.IsActive()) { await RevokeAoSession(access.Token); issued = null; return Results.Unauthorized(); }
                await host.OnIssued(access);
                return Results.Json(new { token = access.Token, expiresAt = access.ExpiresAt, deploymentId = access.DeploymentId, widgetOrigin = access.WidgetOrigin });
            } catch { if (issued is not null) { try { await RevokeAoSession(issued.Token); } catch { } } return Results.Json(new { error = "Assistant connection unavailable" }, statusCode: 502); }
        });
    }
}
// Program.cs: using CornerstoneLabs.Ao; ... app.UseAuthentication();
// app.UseAuthorization(); app.MapAoAssistant();
// On server logout: await AoConnector.RevokeAoSession(token) for every tracked token.
