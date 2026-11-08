<?php
// PHP 8.1+, cURL extension. Mount this handler behind your EXISTING session middleware.
// Copy into your backend; call ao_session_response() from the configured POST route.
// It returns ['status' => int, 'body' => array, 'headers' => array].
function ao_verified_host_session(): ?array {
    // REQUIRED: resolve the EXISTING authenticated session + assistant permission.
    // Return userId, tenantId, apiToken, expiresAt (ISO UTC), isActive callable,
    // onIssued callable (store issued widget access by login session for logout).
    // Optional employeeId and toolIds ([] denies all tools).
    // Never read identity or credentials from browser request JSON.
    return null;
}
function ao_origin(string $name, ?string $fallback = null): string {
    $value = getenv($name) ?: $fallback;
    $u = $value ? parse_url($value) : false;
    $local = $u && getenv('AO_ALLOW_LOCALHOST') === 'true' && in_array($u['host'] ?? '', ['localhost', '127.0.0.1', '[::1]'], true);
    if (!$u || isset($u['user']) || isset($u['pass']) || isset($u['path']) || isset($u['query']) || isset($u['fragment']) || (($u['scheme'] ?? '') !== 'https' && !($local && ($u['scheme'] ?? '') === 'http'))) throw new RuntimeException('Configure exact HTTPS origins');
    return $value;
}
function ao_post(string $path, array $payload, string $token, ?string $appOrigin = null): array {
    $response = ''; $curl = curl_init(ao_origin('AO_ORIGIN') . $path);
    if (!$curl) throw new RuntimeException('Assistant unavailable');
    $headers = ['Authorization: Bearer ' . $token, 'Content-Type: application/json'];
    if ($appOrigin !== null) $headers[] = 'X-Host-Origin: ' . $appOrigin;
    curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($payload, JSON_THROW_ON_ERROR), CURLOPT_HTTPHEADER => $headers, CURLOPT_FOLLOWLOCATION => false, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 10, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_WRITEFUNCTION => function ($handle, $chunk) use (&$response) { if (strlen($response) + strlen($chunk) > 16000) return 0; $response .= $chunk; return strlen($chunk); }]);
    try {
        $ok = curl_exec($curl); $status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
        if ($ok === false || $status !== 200) throw new RuntimeException('Assistant unavailable');
        $data = json_decode($response, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($data)) throw new RuntimeException('Invalid assistant response');
        return $data;
    } finally { curl_close($curl); }
}
function ao_revoke_session(string $widgetToken): void {
    ao_post('/v1/widget/revoke', [], $widgetToken, ao_origin('AO_APPLICATION_ORIGIN'));
}
function ao_session_response(): array {
    $result = fn(int $status, array $body) => ['status' => $status, 'body' => $body, 'headers' => ['Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff', 'Content-Type' => 'application/json']];
    $issued = null;
    try {
        $origin = ao_origin('AO_APPLICATION_ORIGIN');
        $widget = ao_origin('AO_WIDGET_ORIGIN', ao_origin('AO_ORIGIN'));
        $deployment = getenv('AO_DEPLOYMENT_ID'); $key = getenv('AO_INTEGRATION_KEY'); $tenant = getenv('AO_TENANT_ID');
        if (!$deployment || !$key || !$tenant) throw new RuntimeException('Configure host environment');
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') return $result(405, ['error' => 'Use POST']);
        if (($_SERVER['HTTP_ORIGIN'] ?? '') !== $origin) return $result(403, ['error' => 'Invalid application origin']);
        if (!str_starts_with(strtolower($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json')) return $result(415, ['error' => 'Use application/json']);
        $raw = file_get_contents('php://input', false, null, 0, 2049);
        if ($raw === false || strlen($raw) > 2048) return $result(413, ['error' => 'Request too large']);
        try { $object = json_decode($raw ?: '{}', false, 32, JSON_THROW_ON_ERROR); }
        catch (JsonException $e) { return $result(400, ['error' => 'Invalid JSON']); }
        if (!is_object($object)) return $result(400, ['error' => 'Use a JSON object']);
        if (isset($object->deploymentId) && $object->deploymentId !== $deployment) return $result(403, ['error' => 'Deployment denied']);
        $host = ao_verified_host_session();
        if (!$host || empty($host['userId']) || empty($host['apiToken']) || strpbrk($host['apiToken'], "\r\n") !== false || !is_callable($host['isActive'] ?? null) || !is_callable($host['onIssued'] ?? null) || !($host['isActive'])()) return $result(401, ['error' => 'Sign in to use the assistant']);
        $expiry = new DateTimeImmutable($host['expiresAt']);
        if ($expiry->getTimestamp() <= time() + 5) return $result(401, ['error' => 'Host token expired']);
        if (($host['tenantId'] ?? null) !== $tenant) return $result(403, ['error' => 'Tenant denied']);
        $payload = ['deploymentId' => $deployment, 'userId' => $host['userId'], 'tenantId' => $tenant, 'origin' => $origin, 'apiToken' => $host['apiToken'], 'apiTokenExpiresAt' => $expiry->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z')];
        if (isset($host['employeeId'])) $payload['employeeId'] = $host['employeeId'];
        if (array_key_exists('toolIds', $host)) $payload['toolIds'] = $host['toolIds']; else $payload['useDeploymentTools'] = true;
        $access = ao_post('/v1/widget-sessions', $payload, $key);
        $end = new DateTimeImmutable($access['expiresAt']);
        if (!is_string($access['token'] ?? null) || !preg_match('/^[A-Za-z0-9_-]{43}$/D', $access['token']) || ($access['deploymentId'] ?? null) !== $deployment || ($access['widgetOrigin'] ?? null) !== $widget || $end->getTimestamp() <= time() || $end > $expiry || $end->getTimestamp() > time() + 300) throw new RuntimeException('Invalid assistant response');
        $issued = array_intersect_key($access, array_flip(['token', 'expiresAt', 'deploymentId', 'widgetOrigin']));
        if (!($host['isActive'])()) { ao_revoke_session($issued['token']); $issued = null; return $result(401, ['error' => 'Host session ended']); }
        ($host['onIssued'])($issued);
        return $result(200, $issued);
    } catch (Throwable $e) {
        if ($issued) { try { ao_revoke_session($issued['token']); } catch (Throwable $ignored) {} }
        return $result(502, ['error' => 'Assistant connection unavailable']);
    }
}
// Plain PHP route, AFTER existing app/session bootstrap:
// $r = ao_session_response(); http_response_code($r['status']);
// foreach ($r['headers'] as $k => $v) header($k . ': ' . $v);
// echo json_encode($r['body']);
// Laravel: register in routes/web.php with normal session/auth/CSRF middleware.
// In that route: $r = ao_session_response();
// return response()->json($r['body'], $r['status'], $r['headers']);
// Include this file with require_once; PHP's env() caching conventions may need
// your normal config() adapter instead of getenv(). Do not disable global CSRF.
// On server logout: ao_revoke_session($token) for every tracked widget session.
