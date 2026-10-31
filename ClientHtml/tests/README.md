Run from the ProxyCloud repository:

```powershell
node --test --test-reporter=spec ClientHtml/tests/zero-knowledge-file-operations.test.cjs
node --test --test-reporter=spec ClientHtml/tests/streaming-upload.test.cjs
```

Requires Node.js and the `playwright` package available through `node_modules` or `NODE_PATH`. On Windows the suite uses installed Microsoft Edge. Elsewhere it uses Playwright Chromium. Set `PLAYWRIGHT_EXECUTABLE_PATH` to select another Chromium browser executable. These are test dependencies only; the HTML client remains a standalone file.

The tests load the actual HTML in fresh browser contexts and exercise its rendered file cards, toolbar buttons, prompts, and destination confirmation. XHR is mocked and its packets are inspected; fetch, beacon, WebSocket, service workers, and other browser requests cannot access a real server. Only synthetic files and test passphrases are used. Transport encryption is replaced with an identity function inside each test context so command IDs and payloads can be asserted; path/content encryption code is unchanged.

Coverage includes enabled/disabled mode, available/missing keys, restored sessions, files/folders/mixed selections, and mode changes during destination selection. The temporary restriction only disables controls; direct JavaScript calls and queued/in-flight requests are not blocked. A test confirms the operation and request paths remain unchanged. Browsing, upload/download requests, deletion, folder creation, and favorites are also exercised. This does not validate a real server or end-to-end file transfer.

`streaming-upload.test.cjs` covers stateful cipher continuation, 1 MB upload chunking, bounded `Blob.slice()` reads, ZK ciphertext/decryption equality, server-ack backpressure, progress stages, 507 cleanup, cancellation, and transport failure without automatic retry. Live measurements on a disk-backed file showed 4 MB chunks causing 200-260 ms main-thread tasks, 2 MB causing about 128 ms, and 1 MB staying around 79 ms, so the live upload chunk size is 1 MB. It uses synthetic files and mocked XHR; it does not contact a real proxy or cloud server. Large-file timing and responsiveness measurements should be repeated manually against a test account.

Optional: set `TEST_SCREENSHOT_PATH` to an absolute PNG path to capture the restricted toolbar during the allowed-operations test.
