// Java 17+, Spring Boot 3.x (spring-boot-starter-web/Jackson 2).
// Save as AoConnector.java under your application's component-scan package.
// Add YOUR package declaration above imports. No AO SDK/file import is required.
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

@RestController
public class AoConnector {
    public record Access(String token, String expiresAt, String deploymentId, String widgetOrigin) {}
    public record HostSession(String userId, String tenantId, String apiToken, Instant expiresAt,
                              BooleanSupplier isActive, Consumer<Access> onIssued,
                              String employeeId, List<String> toolIds) {}
    // REQUIRED: use your existing authenticated HttpSession/Spring Security context
    // AND assistant permission. Resolve active tenant and native user bearer token.
    // isActive must recheck the same login/tenant; onIssued must track access by
    // that host login session for logout revocation. Never trust request JSON identity.
    private HostSession getVerifiedHostSession(HttpServletRequest request) { return null; }

    private static String env(String key) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) throw new IllegalStateException("Configure " + key);
        return value;
    }
    private static String origin(String value) {
        URI u = URI.create(value);
        boolean local = "true".equals(System.getenv("AO_ALLOW_LOCALHOST")) && List.of("localhost", "127.0.0.1", "[::1]").contains(u.getHost() == null ? "" : u.getHost());
        if (u.getRawUserInfo() != null || u.getHost() == null || !value.equals(u.getScheme() + "://" + u.getRawAuthority()) || (!"https".equals(u.getScheme()) && !(local && "http".equals(u.getScheme())))) throw new IllegalStateException("Configure exact HTTPS origins");
        return value;
    }
    private final String ao = origin(env("AO_ORIGIN")), app = origin(env("AO_APPLICATION_ORIGIN"));
    private final String widget = origin(System.getenv("AO_WIDGET_ORIGIN") == null ? ao : env("AO_WIDGET_ORIGIN"));
    private final String deployment = env("AO_DEPLOYMENT_ID"), key = env("AO_INTEGRATION_KEY"), tenant = env("AO_TENANT_ID");
    private final ObjectMapper json = new ObjectMapper();
    private JsonNode post(String path, String token, Object payload, boolean revoke) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) URI.create(ao + path).toURL().openConnection();
        connection.setInstanceFollowRedirects(false); connection.setRequestMethod("POST");
        connection.setConnectTimeout(5000); connection.setReadTimeout(10000);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Content-Type", "application/json");
        if (revoke) connection.setRequestProperty("X-Host-Origin", app);
        connection.setDoOutput(true);
        try {
            try (var out = connection.getOutputStream()) { out.write(json.writeValueAsBytes(payload)); }
            if (connection.getResponseCode() != 200) throw new IllegalStateException("Assistant unavailable");
            try (InputStream in = connection.getInputStream()) {
                byte[] raw = in.readNBytes(16001);
                if (raw.length > 16000) throw new IllegalStateException("Response too large");
                return json.readTree(raw);
            }
        } finally { connection.disconnect(); }
    }
    public void revokeAoSession(String widgetToken) throws Exception { post("/v1/widget/revoke", widgetToken, Map.of(), true); }
    private ResponseEntity<?> result(int status, Object body) {
        return ResponseEntity.status(status).header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").body(body);
    }
    @PostMapping(value = "${AO_SESSION_ENDPOINT:/assistant/session}", consumes = "application/json")
    public ResponseEntity<?> assistantSession(HttpServletRequest request) {
        if (!app.equals(request.getHeader("Origin"))) return result(403, Map.of("error", "Invalid application origin"));
        Access issued = null;
        try {
            byte[] raw = request.getInputStream().readNBytes(2049);
            if (raw.length > 2048) return result(413, Map.of("error", "Request too large"));
            JsonNode body;
            try { body = json.readTree(raw.length == 0 ? "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8) : raw); }
            catch (Exception e) { return result(400, Map.of("error", "Invalid JSON")); }
            if (body == null || !body.isObject()) return result(400, Map.of("error", "Use a JSON object"));
            if (body.has("deploymentId") && (!body.get("deploymentId").isTextual() || !deployment.equals(body.get("deploymentId").asText()))) return result(403, Map.of("error", "Deployment denied"));
            HostSession host = getVerifiedHostSession(request);
            if (host == null || host.userId() == null || host.userId().isBlank() || host.apiToken() == null || host.apiToken().isBlank() || host.apiToken().contains("\r") || host.apiToken().contains("\n") || host.expiresAt() == null || host.isActive() == null || host.onIssued() == null || !host.expiresAt().isAfter(Instant.now().plusSeconds(5)) || !host.isActive().getAsBoolean()) return result(401, Map.of("error", "Sign in to use the assistant"));
            if (!tenant.equals(host.tenantId())) return result(403, Map.of("error", "Tenant denied"));
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("deploymentId", deployment); payload.put("userId", host.userId()); payload.put("tenantId", host.tenantId()); payload.put("origin", app); payload.put("apiToken", host.apiToken()); payload.put("apiTokenExpiresAt", host.expiresAt().toString());
            if (host.employeeId() != null) payload.put("employeeId", host.employeeId());
            if (host.toolIds() == null) payload.put("useDeploymentTools", true); else payload.put("toolIds", host.toolIds());
            Access access = json.treeToValue(post("/v1/widget-sessions", key, payload, false), Access.class);
            Instant expiry = Instant.parse(access.expiresAt());
            if (access.token() == null || !access.token().matches("[A-Za-z0-9_-]{43}") || !deployment.equals(access.deploymentId()) || !widget.equals(access.widgetOrigin()) || !expiry.isAfter(Instant.now()) || expiry.isAfter(host.expiresAt()) || expiry.isAfter(Instant.now().plusSeconds(300))) throw new IllegalStateException("Invalid assistant response");
            issued = access;
            if (!host.isActive().getAsBoolean()) { revokeAoSession(access.token()); issued = null; return result(401, Map.of("error", "Host session ended")); }
            host.onIssued().accept(access);
            return result(200, access);
        } catch (Exception e) {
            if (issued != null) { try { revokeAoSession(issued.token()); } catch (Exception ignored) {} }
            return result(502, Map.of("error", "Assistant connection unavailable"));
        }
    }
}
// Keep existing Spring Security/session/CSRF middleware. Supply the CSRF token
// header with loader data-csrf-header and data-csrf-meta if required;
// do not disable global CSRF protection. Revoke all tracked widget tokens on logout.
