# ProxyCloud – Architecture Decision Records

## ADR-001 – Proxy Sees Only Ciphertext

**Status:** Accepted

**Context:** The proxy must route traffic between clients and CloudServer across the internet without the proxy operator gaining access to user data.

**Decision:** All payload bytes relayed through `/data` are end-to-end encrypted by `EncryptedMessaging` before reaching the proxy. The proxy forwards raw bytes and has no access to decryption keys.

**Consequences:** The proxy is a zero-knowledge relay. Users can use third-party proxy instances without trusting the proxy operator. Any future feature requiring server-side message processing would break this guarantee and must be carefully evaluated.

---

## ADR-002 – HTTP REST Endpoints Instead of WebSocket

**Status:** Accepted

**Context:** The proxy serves browser clients that may be behind firewalls or NATs that block WebSocket upgrades. A REST polling model is more universally compatible.

**Decision:** Use two HTTP endpoints (`GET /data` for polling, `POST /data` for sending). Clients poll on a short interval to receive forwarded messages.

**Consequences:** Introduces polling latency vs. a push model. Acceptable for configuration and pairing flows. Real-time messaging uses the direct EncryptedMessaging channel once pairing is complete.

---

## ADR-003 – Named Pipe as the Preferred Local Transport

**Status:** Accepted

**Context:** When the proxy and RouterServer run on the same machine, TCP loopback adds unnecessary overhead and requires a listening port.

**Decision:** Support named-pipe transport (`pipe://router`) as the default for co-located proxy+router deployments. TCP is available for remote deployments.

**Consequences:** Named-pipe connections are faster and have no port-conflict risk. The deployment topology (co-located vs. separate) must be explicit in configuration.

---

## ADR-004 – Separate `ProxyAPISupport` Library

**Status:** Accepted

**Context:** Proxy logic is needed in multiple hosts (standalone ProxyCloud, embedded in CloudServerWebUI, potentially others).

**Decision:** Extract all proxy protocol logic into `ProxyAPISupport`. The host projects (`ProxyCloud`) are thin wrappers that supply configuration and ASP.NET Core hosting.

**Consequences:** Reusable library. Changes to proxy protocol only need to be made in one place. Library consumers must coordinate version updates.
