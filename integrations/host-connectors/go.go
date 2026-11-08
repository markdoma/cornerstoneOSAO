// Go 1.22+, standard library only. Save as ao_connector.go in your backend package.
package aoconnector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

type Access struct {
	Token        string    `json:"token"`
	ExpiresAt    time.Time `json:"expiresAt"`
	DeploymentID string    `json:"deploymentId"`
	WidgetOrigin string    `json:"widgetOrigin"`
}
type HostSession struct {
	UserID, TenantID, APIToken string
	ExpiresAt                  time.Time
	EmployeeID                 string
	ToolIDs                    *[]string // nil uses published tools; pointer to [] denies all tools.
	IsActive                   func(context.Context) bool
	OnIssued                   func(context.Context, Access) error // Track by host login for logout revocation.
}

// REQUIRED: replace with your existing verified session middleware + assistant permission.
// Resolve a native user API bearer token and active tenant server-side.
// Never read identity or credentials from incoming JSON/unverified claims.
func getVerifiedHostSession(r *http.Request) *HostSession { return nil }

type Connector struct {
	origin, app, widget, deployment, key, tenant string
	client                                       *http.Client
}

func exactOrigin(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil {
		return "", err
	}
	local := os.Getenv("AO_ALLOW_LOCALHOST") == "true" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
	if value == "" || u.User != nil || u.Host == "" || value != u.Scheme+"://"+u.Host || (u.Scheme != "https" && !(local && u.Scheme == "http")) {
		return "", errors.New("configure exact HTTPS origins")
	}
	return value, nil
}
func New() (*Connector, error) {
	origin, err := exactOrigin(os.Getenv("AO_ORIGIN"))
	if err != nil {
		return nil, err
	}
	app, err := exactOrigin(os.Getenv("AO_APPLICATION_ORIGIN"))
	if err != nil {
		return nil, err
	}
	widget := os.Getenv("AO_WIDGET_ORIGIN")
	if widget == "" {
		widget = origin
	}
	widget, err = exactOrigin(widget)
	if err != nil {
		return nil, err
	}
	deployment, key, tenant := os.Getenv("AO_DEPLOYMENT_ID"), os.Getenv("AO_INTEGRATION_KEY"), os.Getenv("AO_TENANT_ID")
	if deployment == "" || key == "" || tenant == "" {
		return nil, errors.New("configure deployment, key and tenant")
	}
	return &Connector{origin, app, widget, deployment, key, tenant, &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Connector) post(ctx context.Context, path, token string, payload any, revoking bool) ([]byte, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.origin+path, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if revoking {
		req.Header.Set("X-Host-Origin", c.app)
	}
	res, err := c.client.Do(req)
	if err != nil {
		return nil, errors.New("assistant unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, errors.New("assistant unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 16001))
	if err != nil || len(data) > 16000 {
		return nil, errors.New("invalid assistant response")
	}
	return data, nil
}
func (c *Connector) Revoke(ctx context.Context, widgetToken string) error {
	_, err := c.post(ctx, "/v1/widget/revoke", widgetToken, map[string]any{}, true)
	return err
}
func (c *Connector) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	fail := func(status int) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Assistant connection unavailable or unauthorized"})
	}
	if r.Method != "POST" {
		fail(405)
		return
	}
	if r.Header.Get("Origin") != c.app {
		fail(403)
		return
	}
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		fail(415)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 2049))
	if err != nil || len(raw) > 2048 {
		fail(413)
		return
	}
	body := map[string]json.RawMessage{}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if json.Unmarshal(raw, &body) != nil || body == nil {
		fail(400)
		return
	}
	if requested, ok := body["deploymentId"]; ok {
		var id string
		if json.Unmarshal(requested, &id) != nil || id != c.deployment {
			fail(403)
			return
		}
	}
	host := getVerifiedHostSession(r)
	if host == nil || host.UserID == "" || host.APIToken == "" || strings.ContainsAny(host.APIToken, "\r\n") || host.IsActive == nil || host.OnIssued == nil || !host.ExpiresAt.After(time.Now().Add(5*time.Second)) || !host.IsActive(r.Context()) {
		fail(401)
		return
	}
	if host.TenantID != c.tenant {
		fail(403)
		return
	}
	payload := map[string]any{"deploymentId": c.deployment, "userId": host.UserID, "tenantId": host.TenantID, "origin": c.app, "apiToken": host.APIToken, "apiTokenExpiresAt": host.ExpiresAt.UTC()}
	if host.EmployeeID != "" {
		payload["employeeId"] = host.EmployeeID
	}
	if host.ToolIDs == nil {
		payload["useDeploymentTools"] = true
	} else {
		payload["toolIds"] = *host.ToolIDs
	}
	data, err := c.post(r.Context(), "/v1/widget-sessions", c.key, payload, false)
	if err != nil {
		fail(502)
		return
	}
	var access Access
	if json.Unmarshal(data, &access) != nil || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(access.Token) || access.DeploymentID != c.deployment || access.WidgetOrigin != c.widget || !access.ExpiresAt.After(time.Now()) || access.ExpiresAt.After(host.ExpiresAt) || access.ExpiresAt.After(time.Now().Add(5*time.Minute)) {
		fail(502)
		return
	}
	revoke := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = c.Revoke(ctx, access.Token)
	}
	if !host.IsActive(r.Context()) {
		revoke()
		fail(401)
		return
	}
	if err := host.OnIssued(r.Context(), access); err != nil {
		revoke()
		fail(502)
		return
	}
	_ = json.NewEncoder(w).Encode(access)
}

// In your existing server, AFTER cookie/session middleware:
// connector, err := aoconnector.New(); if err != nil { panic("AO configuration invalid") }
// mux.Handle("POST "+os.Getenv("AO_SESSION_ENDPOINT"), connector)
// If file is in package main, change package declaration to main and omit prefix.
// On host logout: connector.Revoke(ctx, token) for every tracked widget access token.
