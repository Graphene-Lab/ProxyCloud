# ProxyAPISupport – Developer Guide

## Initialisation

Call `Communication.Initialize` once at application startup (e.g., in `Program.cs`):

```csharp
ProxyAPISupport.Communication.Initialize(
	privateKey:   "<base64-private-key>",   // Proxy identity key
	entryPoint:   "localhost",              // RouterServer address
	connectivity: true
);
```

Map the HTTP endpoints with the ASP.NET Core `WebApplication`:

```csharp
ProxyAPISupport.MapEndpoints.Map(app);
```

## Local Connection Modes

Set `Communication.DefaultEntryLocalPoint` before calling `Initialize` to control how the proxy connects to the router:

```csharp
// In-process or same-machine via Named Pipe (fastest, recommended when co-located)
Communication.DefaultEntryLocalPoint = LocalEntryPoint.Pipe;

// HTTP loopback (router on same host, different process)
Communication.DefaultEntryLocalPoint = LocalEntryPoint.LocalhostHttp;

// TCP loopback
Communication.DefaultEntryLocalPoint = LocalEntryPoint.LocalhostTcp;
```

CloudServerWebUI uses `LocalhostHttp` by default:

```csharp
CloudSupport.ConnectionType = ProxyAPISupport.Communication.LocalEntryPoint.LocalhostHttp;
```

## QR Code Web Client

The `/proxyinfo?qr` endpoint serves a self-contained HTML page (`CryptoCloudClientWeb.html`) fetched from GitHub. This provides a browser-based client for pairing devices when a native app is unavailable.

## Logging

The `/data?log=<message>&scope=<name>` endpoint writes log entries to files in `LogRepository` (default: `My Documents`). The `scope` parameter is validated with `[a-zA-Z0-9_]+` to prevent path injection.

## Project Structure

```
ProxyAPISupport/
├── Communication.cs       – Proxy initialisation, EncryptedMessaging context
├── CommunicationServer.cs – Server-side proxy communication handler
├── MapEndpoints.cs        – ASP.NET Core HTTP endpoint handlers
├── PairedTable.cs         – Client↔server routing table
├── Util.cs                – Host detection, info page generation
├── README.md
└── docs/
	├── overview.md
	├── developer-guide.md
	├── security-policy.md
	└── adr.md
```

## Integration with CloudServerWebUI

`CloudServerWebUI/Program.cs` integrates the proxy directly:

```csharp
CloudSupport.ConnectionType = ProxyAPISupport.Communication.LocalEntryPoint.LocalhostHttp;
// ...
ProxyAPISupport.Communication.Initialize(proxyPrivateKey, proxyEntryPoint);
ProxyAPISupport.MapEndpoints.Map(app);
```

## Testing

1. Start CloudServerWebUI in debug mode.
2. Open `https://localhost:<port>/proxyinfo?ping` — should return `ok`.
3. Open `https://localhost:<port>/proxyinfo?qr` — should serve the browser QR client.
4. Use the browser client to pair a test device.
