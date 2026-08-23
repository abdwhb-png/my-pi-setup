# Design: Edgee Local Compression Bridge

**Date:** 2026-07-01  
**Status:** Approved  
**Context:** The user wants to integrate Edgee's token compression capabilities (input tool-result trimming and output brevity) locally into the Pi agent harness. The integration must preserve Pi's native architecture, require no per-provider routing configuration in Edgee's `edgee.toml`, and fall back gracefully if Edgee is not running.

---

## 1. Architecture Overview

```
                      +-------------------+
                      |     Pi Agent      |
                      +---------+---------+
                                |
                                | (before_provider_request)
                                v
                      +---------+---------+
                      |   Edgee Bridge    | <======+ (correlation)
                      |     Extension     |        |
                      +----+-----------+--+        |
                           |           ^           |
   (compress request)      |           |           |
   POST /v1/...            v           |           |
                      +----+-----------+--+        |
                      |    Edgee Local    |        |
                      |      Gateway      |        |
                      +---------+---------+        |
                                |                  |
                                | (forwards to)    |
                                v                  |
                      +---------+---------+        |
                      |    Local Mock     +--------+
                      |    HTTP Server    | (stores compressed payload)
                      +-------------------+
                                |
                                | (returns dummy response to Edgee)
                                v
                      +-------------------+
                      |   Edgee Bridge    | (retrieves compressed payload)
                      +---------+---------+
                                |
                                | (returns compressed payload to Pi)
                                v
                      +---------+---------+
                      |   CLIProxyAPI     | (port 8317 - final router)
                      +---------+---------+
```

---

## 2. Key Components

### 2.1 Pi Extension (`extensions/save-tokens/local-tool-result-compressor.ts`)
*   **Startup (`session_start`)**:
    *   Starts a local HTTP server using `Bun.serve` on port `8318`.
    *   Performs a quick health check on the local Edgee gateway (`http://127.0.0.1:8787`).
*   **Request Interception (`before_provider_request`)**:
    *   Generates a unique `correlationId`.
    *   Pushes the original payload to the local Edgee gateway on port `8787` with the header `X-Correlation-Id`.
    *   Blocks until the mock server receives and caches the compressed payload.
    *   Extracts the compressed payload, strips the temporary correlation header and the Edgee metadata (`compression` object), and returns it to Pi.
*   **Shutdown (`session_shutdown`)**:
    *   Stops the Bun HTTP server, freeing port `8318`.

### 2.2 Loopback Mock Server
*   Runs locally on `http://127.0.0.1:8318` within the extension process.
*   Acts as the upstream target configured in Edgee (`EDGEE_API_URL=http://localhost:8318`).
*   On receiving a request:
    1. Extracts the `X-Correlation-Id` header.
    2. Caches the body (which is the compressed request payload) in an in-memory `Map`.
    3. Resolves the blocking promise in the main handler.
    4. Returns a dummy OpenAI/Anthropic JSON response to Edgee.

---

## 3. Resiliency & Fail-safe

*   **Edgee Offline**: If `fetch` to port `8787` fails or times out (200ms threshold), the extension bypasses compression, logs a warning, and returns the original payload immediately.
*   **Port Collision**: If port `8318` is already in use, the extension disables itself gracefully and routes all requests directly to the final provider uncompressed.

---

## 4. Test Specifications

A test suite `extensions/save-tokens/local-tool-result-compressor.test.ts` will verify:
1.  **Mock Server Lifecycle**: The server starts and stops cleanly without leaving active ports.
2.  **Fallback Behavior**: When Edgee is down, the handler does not block and returns the uncompressed payload.
3.  **End-to-End Compression**: A simulated payload is successfully routed through a simulated Edgee proxy, compressed, and retrieved.
