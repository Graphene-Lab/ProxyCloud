# ProxyAPISupport – Architecture Decision Records

## ADR-001 – Zero-Knowledge Proxy Design

**Status:** Accepted

**Context:** A traditional API proxy reads and potentially stores request/response payloads. For a private cloud service, this creates a privacy risk: the proxy operator could access user data.

**Decision:** All payloads are encrypted client-side before reaching the proxy. The proxy only routes messages; it never holds decryption keys.

**Consequences:** Strong privacy guarantees. Slightly more complex client implementation (must establish E2E keys before communicating via proxy). Debugging is harder since payloads cannot be inspected at the proxy.

---

## ADR-002 – Named Pipe as Default for Co-located Deployments

**Status:** Accepted

**Context:** When the proxy and the router run in the same process (e.g., both embedded in CloudServerWebUI), using TCP loopback adds unnecessary OS network stack overhead.

**Decision:** Support Named Pipe (`Pipe`) as a `LocalEntryPoint` option. When set, the proxy connects to the router via an in-process pipe instead of a TCP socket.

**Consequences:** Significant performance improvement for co-located deployments. Named pipes are not available on all platforms (limited on macOS); TCP loopback remains the fallback.

---

## ADR-003 – HTTP Endpoint Routing via Static MapEndpoints Class

**Status:** Accepted

**Context:** The proxy endpoints are minimal (3–4 routes). Using MVC/controllers would add unnecessary overhead and coupling.

**Decision:** `MapEndpoints` is a static class with `Task`-returning methods registered directly as minimal API delegates.

**Consequences:** Simple and dependency-free. All endpoint logic is in one file, making it easy to audit.

---

## ADR-004 – Type 2 QR Code via Proxy

**Status:** Accepted

**Context:** Full connection QR codes can exceed the data capacity of a single scannable QR image, especially on small screens.

**Decision:** Implement a "Type 2 QR" mechanism: the device generates a small primary QR code that references a token; the full connection data is fetched from the proxy via `GetEncryptedQR`.

**Consequences:** Smaller, more scannable QR codes. Requires the proxy to be reachable during the pairing flow.
