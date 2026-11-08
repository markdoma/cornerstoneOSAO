using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.IdentityModel.Tokens;

namespace CornerstoneLabs.AoDelegation;

public sealed record AoIdentity(string UserId, string TenantId, string[] Roles, string[] Scopes);
public sealed record AoToolScope(string Scope);
public sealed class AoContextException(int status) : Exception("Invalid AO service or user context") { public int Status { get; } = status; }

// Register one instance. Load RSA keys from your secret store, never from the browser.
public sealed class AoJwtIssuer(RSA privateKey, string kid, IEnumerable<SecurityKey>? previousKeys = null)
{
    private readonly RsaSecurityKey key = new(privateKey) { KeyId = kid };
    private readonly JwtSecurityTokenHandler handler = new() { MapInboundClaims = false };
    private IEnumerable<SecurityKey> Keys => new SecurityKey[] { key }.Concat(previousKeys ?? []);
    public object Jwks() => new { keys = Keys.Select(k => {
        var jwk = JsonWebKeyConverter.ConvertFromSecurityKey(k);
        // Explicit public-only projection: no private RSA values leave HRIS.
        return new { kty = jwk.Kty, kid = k.KeyId, alg = "RS256", use = "sig", n = jwk.N, e = jwk.E };
    }) };
    public string Mint(AoIdentity user)
    {
        if (string.IsNullOrWhiteSpace(user.UserId) || string.IsNullOrWhiteSpace(user.TenantId)) throw new AoContextException(401);
        var now = DateTimeOffset.UtcNow;
        var payload = new JwtPayload("hris.internal", "ai-orchestrator.internal", null, now.UtcDateTime, now.AddMinutes(10).UtcDateTime, now.UtcDateTime) {
            ["sub"] = user.UserId, ["tenant_id"] = user.TenantId, ["roles"] = user.Roles,
            ["scopes"] = user.Scopes, ["jti"] = Guid.NewGuid().ToString("N")
        };
        return handler.WriteToken(new JwtSecurityToken(new JwtHeader(new SigningCredentials(key, SecurityAlgorithms.RsaSha256)), payload));
    }
    public (ClaimsPrincipal Principal, AoIdentity Identity) Verify(string token)
    {
        try {
            if (token.Length > 16000) throw new AoContextException(401);
            var principal = handler.ValidateToken(token, new TokenValidationParameters {
                ValidateIssuerSigningKey = true, IssuerSigningKeys = Keys, RequireSignedTokens = true,
                ValidateIssuer = true, ValidIssuer = "hris.internal", ValidateAudience = true,
                ValidAudience = "ai-orchestrator.internal", ValidateLifetime = true, RequireExpirationTime = true,
                ClockSkew = TimeSpan.Zero, ValidAlgorithms = [SecurityAlgorithms.RsaSha256]
            }, out var validated);
            var jwt = (JwtSecurityToken)validated;
            if (string.IsNullOrEmpty(jwt.Header.Kid) || jwt.Header.Typ != "JWT" || string.IsNullOrEmpty(jwt.Id) || !jwt.Payload.ContainsKey("iat") || jwt.Payload.Expiration is null || (jwt.ValidTo - jwt.Payload.IssuedAt).TotalSeconds > 600 || jwt.Payload.IssuedAt > DateTime.UtcNow) throw new AoContextException(401);
            using var doc = JsonDocument.Parse(jwt.Payload.SerializeToJson());
            var root = doc.RootElement;
            var user = new AoIdentity(root.GetProperty("sub").GetString()!, root.GetProperty("tenant_id").GetString()!, Strings(root.GetProperty("roles")), Strings(root.GetProperty("scopes")));
            if (string.IsNullOrWhiteSpace(user.UserId) || string.IsNullOrWhiteSpace(user.TenantId)) throw new AoContextException(401);
            return (principal, user);
        } catch { throw new AoContextException(401); }
    }
    private static string[] Strings(JsonElement value) => value.EnumerateArray().Select(x => x.GetString() ?? throw new AoContextException(401)).ToArray();
}

public static class AoDelegationExtensions
{
    // getSession must authenticate the existing HRIS cookie scheme and authorize assistant access.
    public static void MapAoDelegation(this IEndpointRouteBuilder routes, AoJwtIssuer issuer, string applicationOrigin, Func<HttpContext, Task<AoIdentity?>> getSession)
    {
        routes.MapGet("/.well-known/jwks.json", (HttpContext ctx) => { ctx.Response.Headers.CacheControl = "public, max-age=300"; return Results.Json(issuer.Jwks()); });
        routes.MapGet("/api/internal/chat/session", async (HttpContext ctx) => {
            ctx.Response.Headers.CacheControl = "no-store";
            if ((ctx.Request.Headers.Origin.Count > 0 && ctx.Request.Headers.Origin != applicationOrigin) || (ctx.Request.Headers["Sec-Fetch-Site"].Count > 0 && ctx.Request.Headers["Sec-Fetch-Site"] != "same-origin")) return Results.StatusCode(403);
            var user = await getSession(ctx);
            return user is null ? Results.Unauthorized() : Results.Json(new { user_context_token = issuer.Mint(user), expiresAt = DateTimeOffset.UtcNow.AddMinutes(10) });
        });
    }
    public static T RequireAoScope<T>(this T endpoint, string scope) where T : IEndpointConventionBuilder { endpoint.Add(builder => builder.Metadata.Add(new AoToolScope(scope))); return endpoint; }
    public static AoIdentity AoUser(this HttpContext ctx) => ctx.Items[typeof(AoIdentity)] as AoIdentity ?? throw new AoContextException(401);
    public static IApplicationBuilder UseRequireInternalServiceContext(this IApplicationBuilder app, AoJwtIssuer issuer, string serviceToken)
    {
        if (serviceToken.Length < 32) throw new ArgumentException("Service token must be at least 32 characters");
        return app.Use(async (ctx, next) => {
            if (!ctx.Request.Path.StartsWithSegments("/internal/v1")) { await next(ctx); return; }
            try {
                var auth = ctx.Request.Headers.Authorization.ToString();
                if (!auth.StartsWith("Bearer ", StringComparison.Ordinal) || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(auth[7..])), SHA256.HashData(Encoding.UTF8.GetBytes(serviceToken)))) throw new AoContextException(401);
                var (principal, user) = issuer.Verify(ctx.Request.Headers["X-User-Context"].ToString());
                var required = ctx.GetEndpoint()?.Metadata.GetMetadata<AoToolScope>();
                if (required is null || !user.Scopes.Contains(required.Scope, StringComparer.Ordinal)) throw new AoContextException(403);
                foreach (var pair in ctx.Request.Query) CheckIdentity(pair.Key, pair.Value.ToString(), user);
                foreach (var pair in ctx.Request.RouteValues) CheckIdentity(pair.Key, pair.Value?.ToString(), user);
                if (ctx.Request.ContentLength > 131072) throw new AoContextException(413);
                if (ctx.Request.ContentLength > 0 || ctx.Request.Headers.ContainsKey("Transfer-Encoding")) {
                    if (ctx.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) != true) throw new AoContextException(415);
                    ctx.Request.EnableBuffering(bufferThreshold: 32768, bufferLimit: 131072);
                    try { using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ctx.RequestAborted); CheckJson(doc.RootElement, user); }
                    finally { ctx.Request.Body.Position = 0; }
                }
                ctx.User = principal; ctx.Items[typeof(AoIdentity)] = user;
                await next(ctx);
            } catch (AoContextException e) { ctx.Response.StatusCode = e.Status; }
              catch (JsonException) { ctx.Response.StatusCode = 400; }
              catch (IOException) { ctx.Response.StatusCode = 413; }
        });
    }
    private static void CheckIdentity(string name, string? value, AoIdentity user) {
        name = name.Replace("_", "").ToLowerInvariant();
        if ((name is "tenantid") && value != user.TenantId || (name is "sub" or "userid") && value != user.UserId) throw new AoContextException(403);
    }
    private static void CheckJson(JsonElement node, AoIdentity user) {
        if (node.ValueKind == JsonValueKind.Object) foreach (var p in node.EnumerateObject()) { CheckIdentity(p.Name, p.Value.ToString(), user); CheckJson(p.Value, user); }
        if (node.ValueKind == JsonValueKind.Array) foreach (var item in node.EnumerateArray()) CheckJson(item, user);
    }
}
