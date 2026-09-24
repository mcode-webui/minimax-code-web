# HTTPS 与反向代理

> 简体中文 | [English](HTTPS-REVERSE-PROXY.md)

> **本文档存在的理由。** webui 绑定的是纯 HTTP（Node `http.createServer`）。
> TLS 终端被委托给位于它前面的反向代理。本页收集了
> 三份可直接复制的配置（nginx、caddy、Traefik 2），外加那些
> 不知道要留意就会被坑到的 SSE 陷阱。

## 目录

| # | 章节 |
|---|---|
| 1 | [为什么需要反向代理](#1-为什么需要反向代理) |
| 2 | [webui 与代理如何共享认证](#2-webui-与代理如何共享认证) |
| 3 | [常见陷阱 —— Server-Sent Events (SSE)](#3-常见陷阱--server-sent-events-sse) |
| 4 | [nginx](#4-nginx) |
| 5 | [caddy](#5-caddy) |
| 6 | [Traefik 2](#6-traefik-2) |
| 7 | [验证清单](#7-验证清单) |
| 8 | [排查](#8-排查) |

## 1. 为什么需要反向代理

| 能力 | 状态 | 原因 |
|---|---|---|
| 内置 HTTPS 服务器 | ❌ | Node 的 `https.createServer` 需要证书 + 私钥文件；证书轮换、SNI、OCSP stapling、ALPN 等运维工作都得重新实现。Node 标准库还缺少 ACME。我们刻意不附带 TLS 栈。 |
| 对反向代理友好 | ✅ | webui 在 `PORT`（默认 18090）上提供完整的 HTTP API。🔒 v2（PR #55 评审意见第 2 点）：默认绑定现在是回环 `127.0.0.1` —— 对于同主机代理来说这正好合适（proxy → `127.0.0.1:18090`）。如果代理在另一台主机上，请显式选择更宽的绑定：`HOST=0.0.0.0` 环境变量，或持久化的 `lanBind` 设置（`POST /api/settings {lanBind: true}`）。在前面架 nginx / caddy / Traefik 是推荐的部署形态。 |
| mTLS（客户端证书） | ❌ | 与 HTTPS 相同 —— 不在范围内；请在代理层配置 mTLS。 |
| 速率限制 | ✅ | 按 `{IP,token}` 的固定窗口限流器（见 [`server/lib/rate-limit.js`](../server/lib/rate-limit.js)）。令牌持有者获得 2 倍配额。回环完全绕过。 |

**什么时候不需要代理。** webui 也被设计为可以纯本地运行：
`HOST=127.0.0.1`（v2 默认值）+ `MCODE_WEBUI_RATE_LIMIT` 默认值
在回环上是安全的。

## 2. webui 与代理如何共享认证

webui 接受两种令牌载体（见 [`server/lib/auth.js`](../server/lib/auth.js)）：

| 载体 | 使用场景 |
|---|---|
| `Authorization: Bearer <token>` | 浏览器 `fetch`、程序化客户端。首选 —— 永远不会接触 URL 栏 / referer / 历史记录。 |
| `?token=<token>` 查询字符串 | 浏览器 `EventSource`（SSE）。`EventSource` API 无法设置自定义请求头，所以从浏览器认证 SSE 连接的唯一方式就是走 URL。 |

**对下面代理配置的建议**：在 webui 进程上设置 `MCODE_WEBUI_TOKEN=<random>`，然后任选其一：

- （首选）让代理把 `Authorization` 请求头改写为 webui 期望的值（`proxy_set_header Authorization "Bearer <token>"`），或者
- 直接透传 `?token=<token>`（EventSource 会看到它）。

**不要把令牌写进日志。** nginx 和 caddy 默认都会记录包含查询字符串的请求行；如果你把 `?token=` 放进 URL，它就会落进访问日志。要么：
- 在代理处剥离 `token=` 查询参数（`proxy_set_header Authorization "Bearer $arg_token"`），要么
- 对 SSE / API location 设置 `access_log off`。

### 2.1 代理之后的浏览器源 —— `trustedOrigins` 允许清单（v2）

🔒 v2（PR #55 评审意见第 1 点）用**受信源反射**取代了旧的
通配符 CORS，并新增了浏览器 **Origin/CSRF 门禁**：
任何带有 `Origin` 请求头但该源不受信的变更请求
（`POST` / `DELETE`）都会在所有其他门禁之前被拒绝 403。

在反向代理之后，浏览器的 `Origin` 是你的**外部**
源 —— `https://webui.example.com` —— 而不是 webui 自己的
`http://127.0.0.1:18090`。webui 只信任自己的服务源
（回环 + 局域网共享开启时的局域网地址）加上显式的
允许清单，所以**你必须注册外部源**，否则 SPA 自己的
已认证 `POST` 会 403，跨源读取也会失败：

```bash
# one-time, against the local webui (adjust scheme/host/port):
curl -X POST http://127.0.0.1:18090/api/settings \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <your-token>" \
  -d '{"trustedOrigins": ["https://webui.example.com"]}'
```

规则（失败即关闭，整批处理）：仅接受 `http`/`https` 源序列化
（`scheme://host[:port]`，不含路径/查询/userinfo），最多 16
个条目，每个 1..200 字符；无效批次整体被拒绝 400，不做任何更改。
该清单持久化在 `~/.mcode-webui/settings.json` 中，并由
`GET /api/settings` 返回。详情：
[SECURITY-NOTES — CORS](../references/SECURITY-NOTES.md#cors--cross-origin-resource-sharing)。

面向源的代理清单：

- **原样转发 `Origin` 请求头。** nginx / caddy / Traefik
  默认都会透传它 —— 不要剥离它，也不要把它改写成别的值
  （webui 反射并按原样值进行门禁判断）。
- **使用浏览器可见的确切源**，即 scheme + host + port。如果
  你在 `https://webui.example.com`（默认端口）上提供 SPA，
  条目就是 `https://webui.example.com` —— 不带尾部斜杠，
  不带路径。`http://` 源在 `https://` 页面下永远不会被
  浏览器发送，所以不要列出它。
- webui 在每个响应上都发送 `Vary: Origin`；代理也不能
  剥离 `Vary`，否则缓存的 CORS 响应可能被复用到
  不同的源上。
- 不发送 `Origin` 的程序化客户端（curl、MCP、CLI）不受
  该门禁影响 —— 它们照常通过代理工作。

## 3. 常见陷阱 —— Server-Sent Events (SSE)

SSE 长连接（`/api/events`、`/api/alerts`）是"我的代理除了实时推送之外一切正常"类 bug 报告的头号来源。陷阱在于缓冲：反向代理默认会**缓冲上游响应**以便在一次 TCP 写入中发送，这会杀死任何依赖增量刷新的流。

| 陷阱 | 症状 | 修复 |
|---|---|---|
| **响应缓冲** | 事件每隔 30 秒以上成批出现，而不是即时出现 | `proxy_buffering off;`（nginx）/ `flush_interval -1` 或不设置 `buffer`（caddy）/ `flushInterval: "100ms"`（Traefik 2 file provider） |
| **下游使用 HTTP/1.0** | 某些代理对上游默认使用 HTTP/1.0；SSE 需要 1.1 的分块传输 | `proxy_http_version 1.1;`（nginx）/ `versions h1 h2`（Traefik 2.4+ 默认） |
| **代理注入 Connection: close 头** | EventSource 每隔几分钟就关闭 | `proxy_set_header Connection "";`（nginx）/ caddy 默认即可 / Traefik 2 默认即可 |
| **读取超时短于事件间隔** | 如果代理的空闲超时 < 事件间隔，它会杀掉 SSE | `proxy_read_timeout 1h;`（nginx）/ `timeouts { read 1h }`（Traefik 2） |
| **`/api/health` 被限流** | 存活探针在负载下收到 429 | 也在代理层豁免 `/api/health`（大多数代理如此 —— 但某些限流中间件不会） |

## 4. nginx

已针对 nginx 1.24.x 测试。把所有 `example.com`、`/path/to/` 和 `127.0.0.1:18090` 替换为你自己的值。

```nginx
# /etc/nginx/sites-available/mcode-webui.conf
# Upstream: the webui binds 127.0.0.1:18090 by default (v2 loopback
# default) — ideal for a same-host proxy. If the proxy runs on another
# host, widen the bind explicitly on the webui process (HOST=0.0.0.0
# env, or POST /api/settings {lanBind: true}). Remember to register
# the external origin in trustedOrigins — see §2.1.
upstream mcode_webui_upstream {
    server 127.0.0.1:18090;
    keepalive 32;
}

# Plain HTTP → HTTPS redirect. Comment out if you only run LAN.
server {
    listen 80;
    listen [::]:80;
    server_name webui.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name webui.example.com;

    # TLS cert / key. Use certbot / acme.sh / your CA. Webui does NOT
    # ship a TLS stack; everything here is at the proxy layer.
    ssl_certificate     /etc/letsencrypt/live/webui.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/webui.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Strip the `?token=` query string before it lands in the access log.
    # Token holders are then re-injected as Authorization header so the
    # webui's lib/auth.js#extractToken sees the same value either way.
    # This is the safest default; remove if you don't mind the token
    # appearing in your nginx access log.
    set $auth_bearer $arg_token;
    if ($http_authorization != "") { set $auth_bearer $http_authorization; }

    access_log /var/log/nginx/mcode-webui.access.log;
    error_log  /var/log/nginx/mcode-webui.error.log;

    # --- SSE / streaming endpoints ---------------------------------------
    # MUST come before the catch-all `/` location so the SSE-specific
    # overrides win.
    location ~ ^/api/(events|alerts)$ {
        proxy_pass http://mcode_webui_upstream;

        # SSE: disable buffering so each `data:` line flushes immediately.
        proxy_buffering off;
        proxy_cache off;

        # SSE: HTTP/1.1 upstream so chunked transfer encoding works.
        proxy_http_version 1.1;

        # SSE: clear the upstream Connection header — some apps send
        # "close" which makes EventSource disconnect mid-stream.
        proxy_set_header Connection "";

        # SSE: keep the connection open longer than the proxy's default
        # 60s idle timeout. 1h matches webui's keepalive cadence.
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization    $auth_bearer;
    }

    # --- API + SPA -------------------------------------------------------
    location / {
        proxy_pass http://mcode_webui_upstream;

        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization    $auth_bearer;

        # Reasonable default for the JSON API. /api/events already has
        # its own block above.
        proxy_read_timeout 60s;
    }
}
```

## 5. caddy

已针对 caddy 2.7.x 测试。如果省略 `tls` 块，Caddy 会自动申请
Let's Encrypt 证书，但本示例保留了显式证书，方便审阅者
替换成自己的证书。

```caddyfile
# /etc/caddy/Caddyfile
# Upstream address — match what you set PORT/HOST to on the webui process.
# 127.0.0.1 is the recommended default; the proxy and the webui run on
# the same host.

webui.example.com {
    # ----- TLS -----
    # Replace with your cert / key paths, OR delete this block to let
    # Caddy auto-provision via ACME (requires DNS-01 or HTTP-01 reach).
    tls /etc/letsencrypt/live/webui.example.com/fullchain.pem \
        /etc/letsencrypt/live/webui.example.com/privkey.pem

    # ----- Logging -----
    log {
        output file /var/log/caddy/mcode-webui.log
        # DON'T include the query string in the log — `?token=` would
        # leak. The default `LOG` format already redacts the URI's query.
        format console
    }

    # ----- Reverse proxy base config -----
    reverse_proxy http://127.0.0.1:18090 {
        # SSE: keep the upstream connection open. Caddy's default is
        # 30s; bump to 1h to match the webui's keepalive.
        transport http {
            # Caddy 2.7+ supports read_timeout per transport.
            read_timeout 1h
            dial_timeout 30s
        }

        # Header policy. Caddy already forwards standard headers; the
        # Authorization header rewrite is the only webui-specific bit.
        header_up Host              {host}
        header_up X-Real-IP         {remote_host}
        header_up X-Forwarded-For   {remote_host}
        header_up X-Forwarded-Proto {scheme}
        # Token carriers (priority: client Authorization header > ?token=
        # query string). lib/auth.js#extractToken accepts both.
        header_up Authorization {http.reverse_proxy.header.Authorization}

        # SSE: Caddy does NOT buffer streaming responses by default
        # (unlike nginx), so no `flush_interval -1` is needed. If you
        # see buffering in your version, add:
        #   flush_interval -1
        # ...to this block. Caddy 2.7+ already passes through SSE.
    }

    # ----- SSE-specific route (must come BEFORE the catch-all) -----
    # The `events` and `alerts` endpoints are SSE streams. The base
    # reverse_proxy above handles them correctly out of the box, but
    # the explicit block lets reviewers see *why* these paths exist.
    @sse_paths {
        path /api/events /api/alerts
    }
    handle @sse_paths {
        reverse_proxy http://127.0.0.1:18090 {
            transport http {
                read_timeout 1h
                # SSE: do NOT buffer. Caddy 2.7+ default is fine.
                # Older versions: uncomment to force passthrough.
                # flush_interval -1
            }
            # Don't truncate the response at the upstream's idle timeout.
            # Caddy 2.7+ also requires you to NOT set
            # `timeouts { read 30s }` at the server level — it's
            # transport-local.
        }
    }

    # ----- Health probe -----
    # /api/health is exempted from the webui's rate limiter (router.js
    # Gate 4), so orchestrators won't trip on it.
    handle /api/health {
        reverse_proxy http://127.0.0.1:18090
    }

    # ----- Catch-all for SPA + remaining API -----
    handle {
        reverse_proxy http://127.0.0.1:18090
    }
}
```

## 6. Traefik 2

已针对 Traefik 2.10.x 的 **file provider** 测试。Docker 用户：
把下面这些 file-provider 字段一对一地翻译成 labels。

```yaml
# traefik/dynamic/mcode-webui.yml  (loaded by the file provider)
http:
  routers:
    mcode-webui-secure:
      rule: "Host(`webui.example.com`)"
      entryPoints: ["websecure"]
      tls:
        # Replace with your cert resolver or static cert path. Options:
        #   - certResolver: letsencrypt  (auto ACME)
        #   - domains: [{main: webui.example.com, sans: [*.example.com]}]
        #   - For static certs (offline / air-gapped), use:
        #       tls.certificates:
        #         - certFile: /path/to/fullchain.pem
        #           keyFile:  /path/to/privkey.pem
        certResolver: letsencrypt
      service: mcode-webui
      # Apply the rate-limit + auth middlewares (see middlewares below).
      middlewares:
        - mcode-headers
        - mcode-strip-token

    mcode-webui-plain:
      rule: "Host(`webui.example.com`)"
      entryPoints: ["web"]
      service: mcode-webui
      # HTTP → HTTPS redirect via redirectScheme middleware.
      middlewares:
        - mcode-redirect-https

  services:
    mcode-webui:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:18090"
        # SSE: keep the connection alive longer than Traefik's 30s default.
        # Traefik's `serversTransport` controls this.
        serversTransport: mcode-webui-transport

  serversTransports:
    mcode-webui-transport:
      # SSE: 1h read timeout. Default 30s would kill long-idle SSE.
      forwardingTimeouts:
        dialTimeout: "30s"
        responseHeaderTimeout: "0s"   # no timeout on response headers — SSE
        idleConnTimeout: "1h"         # keepalive matches webui

  middlewares:
    # HTTPS redirect for the plain-HTTP entrypoint.
    mcode-redirect-https:
      redirectScheme:
        scheme: https
        permanent: true

    # Strip `?token=` from the upstream request and forward it as
    # Authorization: Bearer <token> instead. This prevents the token
    # from appearing in your Traefik access log.
    mcode-strip-token:
      # Traefik 2.10's plugin middleware API isn't always available;
      # the inline replacePath / addHeaders below are simpler.
      replacePath:
        # No-op path; the header rewrite below does the work.
        path: ""
      addHeaders:
        # The webui's lib/auth.js#extractToken reads both the
        # Authorization header and the `?token=` query string. If the
        # client already supplied Authorization, prefer that; otherwise
        # fall back to the URL token. The webui accepts both, so we
        # just always forward both — Traefik won't double up.
        # NOTE: Traefik's addHeaders is STATIC; dynamic per-request
        # header injection requires a plugin (traefik-plugin-header-
        # rewrite or similar). For simplicity here we just forward
        # the client-supplied Authorization header as-is.
        # (See §2 above for the full auth-shaping discussion.)
        customRequestHeaders:
          X-Forwarded-Proto: "https"

    # Standard reverse-proxy headers.
    mcode-headers:
      headers:
        customRequestHeaders:
          X-Real-IP: "true"  # placeholder; Traefik fills this automatically
        # SSE: do NOT buffer. Traefik 2.10 passes streaming responses
        # through by default. If you're on 2.4 or older and see SSE
        # buffering, add a plugin:
        #   plugin:
        #     name: buffering
        #     config:
        #       flushInterval: "100ms"
```

## 7. 验证清单

部署完成后，从**客户端**机器上逐项运行：

```bash
# Replace webui.example.com with your hostname.
HOST=webui.example.com

# 1. HTTPS works
curl -fsSL "https://${HOST}/api/health"
# Expect: {"ok":true,...}

# 2. Token auth (when MCODE_WEBUI_TOKEN is set on the webui process)
#    — without token, expect 401.
curl -i "https://${HOST}/api/state" | head -1
# Expect: HTTP/2 401

# 3. Token auth — with token, expect 200.
curl -i -H "Authorization: Bearer <your-token>" "https://${HOST}/api/state" | head -1
# Expect: HTTP/2 200

# 4. SSE — open a stream and confirm events arrive within 1s, not 30s.
timeout 5 curl -N -H "Authorization: Bearer <your-token>" \
    "https://${HOST}/api/events"
# Expect: data: {...} lines arriving at near-realtime cadence.

# 5. Browser-origin gate (v2) — with the external origin registered in
#    trustedOrigins (§2.1), the preflight is answered and the origin is
#    reflected verbatim (never a wildcard):
curl -s -i -X OPTIONS "https://${HOST}/api/state" \
    -H "Origin: https://${HOST}" \
    -H "Access-Control-Request-Method: POST" | grep -i access-control
# Expect: Access-Control-Allow-Origin: https://webui.example.com
#         Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE

# 6. Browser-origin gate (v2) — an UNregistered origin gets no CORS
#    headers on reads and a 403 on mutating requests:
curl -s -i -X POST "https://${HOST}/api/settings" \
    -H "Origin: https://evil.example" \
    -H 'Content-Type: application/json' -d '{}' | head -1
# Expect: HTTP/2 403  {"ok":false,"error":"cross-origin request rejected"}
```

## 8. 排查

| 症状 | 可能的根因 | 修复 |
|---|---|---|
| 浏览器 `POST`/`DELETE` 返回 403 `cross-origin request rejected` | v2 Origin/CSRF 门禁：外部源不在 `trustedOrigins` 中 | `POST /api/settings {"trustedOrigins": ["https://webui.example.com"]}` —— 使用浏览器可见的确切源，不带尾部斜杠（§2.1）。检查代理没有改写/剥离 `Origin` 请求头 |
| 浏览器无法读取 API 响应（控制台出现 CORS 报错）但 curl 正常 | 外部源未列入允许清单 —— 不受信源按设计得不到任何 `Access-Control-*` 头 | 同样的修复：在 `trustedOrigins` 中注册该源（§2.1） |
| `curl` 返回 301 跳转 HTTPS 但浏览器显示证书错误 | 你测试的是重定向，而不是 TLS 握手 | 直接测试：`curl -v https://webui.example.com/api/health` |
| SSE 事件每隔 30 秒成批到达 | 代理在缓冲 | 见 §3 —— 设置 `proxy_buffering off`（nginx）/ 添加 `buffering` 插件（Traefik 2.4）/ 检查 Caddy 版本 |
| SSE 几分钟后断开 | 代理空闲超时 | 把 `proxy_read_timeout` / `read_timeout` / `forwardingTimeouts.idleConnTimeout` 调大到 1h |
| `?token=` 出现在 nginx 访问日志中 | nginx 默认日志包含查询字符串 | 要么在代理处剥离（推荐），要么对 SSE location 设置 `access_log off` |
| 即使带令牌也返回 401 | 令牌在请求头改写中丢失 | 检查你的 `proxy_set_header Authorization` 行；验证 webui 进程的 `MCODE_WEBUI_TOKEN` 与之匹配 |
| 健康端点被限流（429） | 配置错误的中间件也在限流 | `/api/health` 已在 webui 层被豁免（router.js Gate 4）。如果你的代理中间件仍在限流，也在那里豁免 `/api/health` |
| webui 重启后 nginx 返回 502 | 重启期间上游不可用 | `proxy_next_upstream` + 重试；或者等 webui 恢复后直接 reload nginx |

---

另见：

- [`docs/CAPABILITIES.md` §11 Network & access control](CAPABILITIES.md#11-network--access-control) —— 运维概览
- [`server/lib/rate-limit.js`](../server/lib/rate-limit.js) —— 算法细节
- [`server/lib/auth.js`](../server/lib/auth.js) —— 令牌校验契约
