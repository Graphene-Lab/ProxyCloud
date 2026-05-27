# ProxyCloud – Developer Guide

## Prerequisites

- .NET 9 SDK
- A running RouterServer instance (local or remote)
- A CloudServer instance connected to the same RouterServer

## Projects

### ProxyAPISupport (library)

Contains all reusable proxy logic. Reference this library from any ASP.NET Core host that needs to act as a CloudBox proxy.

**Initialisation:**

```csharp
// Call once at startup
Communication.Initialize(privateKey, entryPoint);
```

- `privateKey` — base-64 encoded 32-byte private key; the corresponding public key must be configured in CloudServer's `appsettings.json` as `ProxyPubKey`.
- `entryPoint` — hostname or IP of the RouterServer. Use `"pipe://router"` for named-pipe local connection, or a TCP hostname for remote.

**Connection modes:**

| Mode | `DefaultEntryLocalPoint` value | Use case |
|---|---|---|
| Named pipe | `LocalEntryPoint.Pipe` | Proxy and router on same machine (fast, no TCP overhead) |
| Localhost TCP | `LocalEntryPoint.LocalhostTcp` | Proxy and router on same machine, TCP |
| Remote TCP | `LocalEntryPoint.LocalhostHttp` (set `entryPoint`) | Proxy and router on different machines |

**HTTP endpoints (wired by `MapEndpoints`):**

| Verb | Path | Purpose |
|---|---|---|
| GET | `/` | Proxy status page (connection state, stats) |
| GET | `/data` | Client polls for data forwarded from the cloud server |
| POST | `/data` | Client sends data to be forwarded to the cloud server |

**`PairedTable`:**

A persistent key→value table backed by a local file. Used to associate `ClientId` with `ChatId` across sessions. Located in the application data directory.

### ProxyCloud (host)

Minimal ASP.NET Core host. `Startup.cs` reads configuration and calls `Communication.Initialize`. `Program.cs` builds and runs the host.

**Configuration (`appsettings.json`):**

```json
{
  "EntryPoint": "router.hostname.or.ip",
  "PrivateKey": "<base64 32-byte private key>",
  "IpsEnabledToUploadUpdates": "192.168.1.10 192.168.1.11"
}
```

- `IpsEnabledToUploadUpdates` — space-separated IP list allowed to push app updates to `AppSync.WebRepository`. Leave empty to disable uploads.

## Running Locally

```bash
cd ProxyCloud
dotnet run
```

The proxy listens on the port configured in `launchSettings.json` (default `5050`). In production, place a reverse proxy (nginx, Caddy) with TLS in front.

## Adding a New Purpose

1. Add the new value to `Communication.Purpose` in `ProxyAPISupport/Communication.cs`.
2. Add the corresponding handler in `MapEndpoints.cs`.
3. Mirror the same value in the client-side code that constructs proxy requests.

## Logging

Request logs are written to `<WebRootPath>/logs/` (`MapEndpoints.LogRepository`). Ensure the logs directory is writable and excluded from public static file serving.
