#if AO_CONNECTED
using CornerstoneLabs.Ao;

// This is host-owned code, not part of AO's downloadable connector. It maps the
// existing app's authenticated session and native API token to AO's contract.
static class IntegrationAdapter {
    public static LabState State { get; set; } = null!;
    public static Task<AoHostSession?> GetVerifiedHostSession(HttpContext context) {
        if (State.WebLogin(context) is not { } login || State.IssueApiToken(login.Id) is not { } grant)
            return Task.FromResult<AoHostSession?>(null);
        return Task.FromResult<AoHostSession?>(new(
            login.User, LabState.Tenant, grant.Token, grant.Expiry,
            () => Task.FromResult(State.Active(login.Id)),
            access => { State.TrackWidget(login.Id, access.Token, access.ExpiresAt); return Task.CompletedTask; }
        ));
    }
}
#endif
