#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

const COOKIE_NAME = process.env.CODEXAPP_LOGIN_COOKIE_NAME || "codexapp_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const host = process.env.CODEXAPP_HOST || "127.0.0.1";
const port = Number(process.env.CODEXAPP_PORT || 12903);
const upstream = new URL(process.env.CODEXAPP_UPSTREAM || "http://127.0.0.1:12910");
const username = requiredEnv("CODEXAPP_USERNAME");
const password = requiredEnv("CODEXAPP_PASSWORD");
const sessionSecret = requiredEnv("CODEXAPP_SESSION_SECRET");
const appEntryPath = "/";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function timingSafeEqualString(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue));
  const right = Buffer.from(String(rightValue));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

function base64urlJson(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function makeSession(user) {
  const payload = base64urlJson({
    u: user,
    exp: Date.now() + SESSION_TTL_MS,
    n: crypto.randomBytes(16).toString("base64url"),
  });
  return `${payload}.${sign(payload)}`;
}

function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      cookies.set(key, value);
    }
  }
  return cookies;
}

function isValidSession(req) {
  const token = parseCookies(req.headers.cookie).get(COOKIE_NAME);
  if (!token) {
    return false;
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !timingSafeEqualString(signature, sign(payload))) {
    return false;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.u === username && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function isSecureRequest(req) {
  return req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
}

function setCookieHeader(token, secure) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res, location, extraHeaders = {}) {
  send(res, 302, { Location: location, ...extraHeaders }, "");
}

function ignoreConnectionError() {}

function loginPage({ error = "", next = "/" } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex App Login</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f8;
      --panel: #ffffff;
      --text: #111111;
      --muted: #666666;
      --border: #d9d9d9;
      --focus: #111111;
      --error: #b42318;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101112;
        --panel: #171819;
        --text: #f5f5f5;
        --muted: #a3a3a3;
        --border: #303235;
        --focus: #f5f5f5;
        --error: #ff8a80;
      }
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(100%, 380px);
      padding: 28px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 18px 55px rgba(0, 0, 0, 0.08);
    }
    h1 {
      margin: 0 0 6px;
      font-size: 24px;
      line-height: 1.15;
      font-weight: 720;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 22px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
    }
    label {
      display: block;
      margin: 14px 0 7px;
      color: var(--text);
      font-size: 13px;
      font-weight: 650;
    }
    input {
      width: 100%;
      height: 44px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0 12px;
      background: transparent;
      color: var(--text);
      font: inherit;
      outline: none;
    }
    input:focus {
      border-color: var(--focus);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 18%, transparent);
    }
    button {
      width: 100%;
      height: 44px;
      margin-top: 20px;
      border: 0;
      border-radius: 6px;
      background: var(--text);
      color: var(--panel);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .error {
      margin: 0 0 14px;
      color: var(--error);
      font-size: 13px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <main>
    <h1>Codex App</h1>
    <p>登录后进入 Codex Desktop Linux 工作台.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(next)}" />
      <label for="username">用户名</label>
      <input id="username" name="username" autocomplete="username" value="${escapeHtml(username)}" required />
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">登录</button>
    </form>
  </main>
</body>
</html>`;
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("REQUEST_BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeNext(value) {
  const next = String(value || "/");
  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/";
  }
  return next;
}

function proxyHeaders(req) {
  const headers = { ...req.headers };
  headers.host = upstream.host;
  delete headers.connection;
  delete headers["proxy-connection"];
  delete headers["keep-alive"];
  delete headers["transfer-encoding"];
  delete headers["content-length"];
  delete headers.cookie;
  return headers;
}

function upstreamUrlFor(req) {
  if (req.url === "/" || req.url === "") {
    return new URL(appEntryPath, upstream);
  }
  return new URL(req.url, upstream);
}

function proxyHttp(req, res) {
  req.on("error", ignoreConnectionError);
  res.on("error", ignoreConnectionError);

  const target = upstreamUrlFor(req);
  const client = target.protocol === "https:" ? https : http;
  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: proxyHeaders(req),
  };

  const upstreamReq = client.request(options, (upstreamRes) => {
    upstreamRes.on("error", ignoreConnectionError);
    const headers = { ...upstreamRes.headers };
    delete headers["content-security-policy"];
    res.writeHead(upstreamRes.statusCode || 502, headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on("error", (error) => {
    send(res, 502, { "Content-Type": "text/plain; charset=utf-8" }, error.message);
  });
  upstreamReq.on("socket", (socket) => {
    socket.on("error", ignoreConnectionError);
  });

  req.pipe(upstreamReq);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    send(res, 200, { "Content-Type": "application/json" }, JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/login" && req.method === "GET") {
    send(res, 200, { "Content-Type": "text/html; charset=utf-8" }, loginPage({ next: normalizeNext(url.searchParams.get("next")) }));
    return;
  }

  if (url.pathname === "/login" && req.method === "POST") {
    try {
      const form = parseForm(await readBody(req));
      const ok = timingSafeEqualString(form.username || "", username)
        && timingSafeEqualString(form.password || "", password);
      if (!ok) {
        send(res, 401, { "Content-Type": "text/html; charset=utf-8" }, loginPage({
          error: "用户名或密码不正确.",
          next: normalizeNext(form.next),
        }));
        return;
      }
      redirect(res, normalizeNext(form.next), {
        "Set-Cookie": setCookieHeader(makeSession(username), isSecureRequest(req)),
      });
    } catch (error) {
      send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, error.message);
    }
    return;
  }

  if (url.pathname === "/logout") {
    redirect(res, "/login", { "Set-Cookie": clearCookieHeader() });
    return;
  }

  if (!isValidSession(req)) {
    redirect(res, `/login?next=${encodeURIComponent(req.url || "/")}`);
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    proxyHttp(req, res);
    return;
  }

  proxyHttp(req, res);
}

function handleUpgrade(req, socket, head) {
  socket.on("error", ignoreConnectionError);

  if (!isValidSession(req)) {
    socket.write("HTTP/1.1 302 Found\r\nLocation: /login\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const target = upstreamUrlFor(req);
  const client = target.protocol === "https:" ? https : http;
  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: {
      ...proxyHeaders(req),
      connection: "Upgrade",
      upgrade: req.headers.upgrade || "websocket",
    },
  };

  const upstreamReq = client.request(options);
  upstreamReq.on("socket", (upstreamSocket) => {
    upstreamSocket.on("error", ignoreConnectionError);
  });
  upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    upstreamSocket.on("error", () => {
      socket.destroy();
    });
    upstreamSocket.on("close", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      upstreamSocket.destroy();
    });
    socket.write(
      `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`
      + Object.entries(upstreamRes.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")
      + "\r\n\r\n"
    );
    if (upstreamHead.length) {
      socket.write(upstreamHead);
    }
    if (head.length) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamReq.on("error", () => socket.destroy());
  upstreamReq.end();
}

const server = http.createServer((req, res) => {
  req.socket.on("error", ignoreConnectionError);
  res.socket?.on("error", ignoreConnectionError);
  handleRequest(req, res).catch((error) => {
    send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, error.stack || error.message);
  });
});

server.on("clientError", (_error, socket) => {
  socket.destroy();
});
server.on("upgrade", handleUpgrade);
server.listen(port, host, () => {
  console.log(`Codex App login proxy listening on http://${host}:${port}`);
});
