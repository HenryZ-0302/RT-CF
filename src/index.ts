import { DurableObject } from "cloudflare:workers";

export interface Env {
  AUTH_TOKEN: string;
  ACCOUNT_COOLDOWN_MS?: string;
  ROUTER_STATE: DurableObjectNamespace;
}

type AccountRecord = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  extraHeaders?: Record<string, string>;
  unhealthyUntil?: number;
};

type AccountInput = {
  id: string;
  label?: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  extraHeaders?: Record<string, string>;
};

const ACCOUNTS_KEY = "accounts";
const CURSOR_KEY = "cursor";

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function html(content: string, init: ResponseInit = {}): Response {
  return new Response(content, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...init.headers,
    },
  });
}

function getBearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? "";
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function ensureAuthorized(request: Request, token: string): Response | null {
  if (!token || getBearer(request) !== token) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function sanitizeAccountInput(payload: AccountInput): AccountRecord {
  if (!payload.id?.trim()) throw new Error("Account id is required");
  if (!payload.baseUrl?.trim()) throw new Error("Account baseUrl is required");
  if (!payload.apiKey?.trim()) throw new Error("Account apiKey is required");
  return {
    id: payload.id.trim(),
    label: payload.label?.trim() || payload.id.trim(),
    baseUrl: normalizeBaseUrl(payload.baseUrl),
    apiKey: payload.apiKey.trim(),
    enabled: payload.enabled !== false,
    extraHeaders: payload.extraHeaders,
    unhealthyUntil: 0,
  };
}

function redactAccount(account: AccountRecord) {
  return {
    id: account.id,
    label: account.label,
    baseUrl: account.baseUrl,
    enabled: account.enabled,
    extraHeaders: account.extraHeaders ?? {},
    unhealthyUntil: account.unhealthyUntil ?? 0,
  };
}

function summarizeAccounts(accounts: AccountRecord[]) {
  const now = Date.now();
  const enabled = accounts.filter((account) => account.enabled).length;
  const cooling = accounts.filter((account) => (account.unhealthyUntil ?? 0) > now).length;
  return {
    total: accounts.length,
    enabled,
    disabled: accounts.length - enabled,
    cooling,
  };
}

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RT Account Router</title>
  <style>
    :root { color-scheme: light dark; --bg:#0b1020; --card:#11182d; --muted:#8b96b2; --line:#26304a; --text:#eef2ff; --accent:#5b8cff; --accent-2:#2bd4a8; --danger:#ff6b6b; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:linear-gradient(180deg,#0b1020,#0f1530); color:var(--text); }
    .wrap { max-width:1080px; margin:0 auto; padding:32px 20px 80px; }
    .top { display:grid; gap:16px; grid-template-columns:1.2fr 0.8fr; margin-bottom:24px; }
    .card { background:rgba(17,24,45,0.92); border:1px solid var(--line); border-radius:18px; padding:20px; box-shadow:0 12px 30px rgba(0,0,0,0.2); }
    h1,h2,h3,p { margin:0; } h1 { font-size:28px; margin-bottom:8px; } h2 { font-size:16px; margin-bottom:14px; }
    p.sub { color:var(--muted); line-height:1.55; }
    .field,.grid { display:grid; gap:10px; } .grid.two { grid-template-columns:1fr 1fr; }
    input,textarea { width:100%; border:1px solid var(--line); background:#0b1122; color:var(--text); border-radius:12px; padding:12px 14px; font:inherit; }
    textarea { min-height:96px; resize:vertical; }
    .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; }
    button { border:0; border-radius:12px; padding:10px 14px; font:inherit; cursor:pointer; color:white; background:var(--accent); }
    button.secondary { background:#22304f; } button.danger { background:var(--danger); }
    .list { display:grid; gap:12px; margin-top:18px; }
    .item { border:1px solid var(--line); border-radius:14px; padding:16px; background:rgba(8,13,28,0.6); }
    .row { display:flex; justify-content:space-between; gap:12px; align-items:center; flex-wrap:wrap; }
    .meta { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
    .tag { padding:4px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--muted); }
    .tag.ok { color:var(--accent-2); border-color:rgba(43,212,168,0.4); } .tag.off { color:#ffb86b; border-color:rgba(255,184,107,0.35); }
    .muted { color:var(--muted); } .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .status { margin-top:12px; font-size:13px; color:var(--muted); min-height:18px; }
    .hidden { display:none !important; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:20px 0; }
    .stat { border:1px solid var(--line); border-radius:14px; background:rgba(8,13,28,0.6); padding:16px; }
    .stat b { display:block; font-size:22px; margin-bottom:4px; }
    .gate {
      min-height: 100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:20px;
    }
    .gate-card {
      width:100%;
      max-width:460px;
      background:rgba(17,24,45,0.96);
      border:1px solid var(--line);
      border-radius:22px;
      padding:28px;
      box-shadow:0 16px 40px rgba(0,0,0,0.28);
    }
    .gate-card h1 { text-align:center; margin-bottom:10px; }
    .gate-card p { text-align:center; color:var(--muted); line-height:1.6; }
    .gate-card .field { margin-top:20px; }
    .app-header {
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:12px;
      margin-bottom:18px;
    }
    .app-header .actions { margin-top:0; }
    @media (max-width:860px) { .top,.grid.two { grid-template-columns:1fr; } }
    @media (max-width:860px) { .stats { grid-template-columns:1fr 1fr; } }
  </style>
</head>
<body>
  <section id="gate" class="gate">
    <div class="gate-card">
      <h1>RT Account Router</h1>
      <p>先输入服务访问密码完成验证，再进入多账号轮询控制台。</p>
      <div class="field">
        <input id="token" type="password" placeholder="请输入服务访问密码" />
        <button id="gate-submit">进入控制台</button>
      </div>
      <div class="status" id="gate-status"></div>
    </div>
  </section>

  <div id="app" class="wrap hidden">
    <div class="app-header">
      <div>
        <h1>RT Account Router</h1>
        <p class="sub">只保留多账号轮询。账号加进去后，Worker 会按轮询顺序转发 <span class="mono">/v1/*</span> 请求，5xx 或网络错误时自动切下一个账号。</p>
      </div>
      <div class="actions">
        <button class="secondary" id="reload">刷新</button>
        <button class="danger" id="logout">退出</button>
      </div>
    </div>

    <section class="stats" id="summary">
      <div class="stat"><b id="sum-total">0</b><span class="muted">总账号</span></div>
      <div class="stat"><b id="sum-enabled">0</b><span class="muted">启用中</span></div>
      <div class="stat"><b id="sum-disabled">0</b><span class="muted">已停用</span></div>
      <div class="stat"><b id="sum-cooling">0</b><span class="muted">冷却中</span></div>
    </section>

    <div class="top">
      <section class="card">
        <h2>添加 / 编辑账号</h2>
        <p class="sub">填同一个账号 ID 会覆盖更新。这里直接维护上游帐号池。</p>
        <div class="status" id="status"></div>
      </section>
      <section class="card">
        <h2>当前状态</h2>
        <div class="field">
          <input id="current-token" type="password" placeholder="当前已验证密码" disabled />
        </div>
        <div class="status" id="meta-status"></div>
      </section>
    </div>
    <section class="card">
      <div class="grid two">
        <input id="id" placeholder="账号 ID，例如 openai-1" />
        <input id="label" placeholder="显示名称，可留空" />
      </div>
      <div class="grid two" style="margin-top:10px">
        <input id="baseUrl" placeholder="上游 Base URL，例如 https://api.openai.com" />
        <input id="apiKey" placeholder="上游 API Key" />
      </div>
      <div class="grid" style="margin-top:10px">
        <textarea id="extraHeaders" placeholder='可选额外请求头 JSON，例如 {"OpenAI-Organization":"org_xxx"}'></textarea>
      </div>
      <div class="actions">
        <button id="add-account">添加 / 覆盖账号</button>
        <button class="secondary" id="reload">刷新列表</button>
      </div>
    </section>
    <section class="card" style="margin-top:20px">
      <div class="row">
        <div>
          <h2>账号列表</h2>
          <p class="sub">这里只显示已保存账号，不暴露 API Key。可以直接启停、编辑、删除或检测。</p>
        </div>
      </div>
      <div class="list" id="accounts"></div>
    </section>
  </div>
  <script>
    const gateEl = document.getElementById("gate");
    const appEl = document.getElementById("app");
    const statusEl = document.getElementById("status");
    const gateStatusEl = document.getElementById("gate-status");
    const metaStatusEl = document.getElementById("meta-status");
    const listEl = document.getElementById("accounts");
    const tokenInput = document.getElementById("token");
    const currentTokenInput = document.getElementById("current-token");
    tokenInput.value = localStorage.getItem("rt-router-token") || "";
    currentTokenInput.value = tokenInput.value;
    function setStatus(target, message, isError = false) {
      target.textContent = message || "";
      target.style.color = isError ? "#ff8f8f" : "#8b96b2";
    }
    function getToken() { return tokenInput.value.trim(); }
    function parseExtraHeaders() {
      const raw = document.getElementById("extraHeaders").value.trim();
      if (!raw) return undefined;
      return JSON.parse(raw);
    }
    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { ...(options.headers || {}), authorization: "Bearer " + getToken() },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
      return data;
    }
    function setSummary(summary) {
      document.getElementById("sum-total").textContent = String(summary.total || 0);
      document.getElementById("sum-enabled").textContent = String(summary.enabled || 0);
      document.getElementById("sum-disabled").textContent = String(summary.disabled || 0);
      document.getElementById("sum-cooling").textContent = String(summary.cooling || 0);
    }
    function unlockApp() {
      gateEl.classList.add("hidden");
      appEl.classList.remove("hidden");
      currentTokenInput.value = getToken();
    }
    async function verify() {
      try {
        setStatus(gateStatusEl, "验证中...");
        const data = await api("/admin/verify");
        setSummary(data.summary || {});
        unlockApp();
        setStatus(gateStatusEl, "");
        setStatus(metaStatusEl, "验证通过。");
        await loadAccounts();
      } catch (error) {
        setStatus(gateStatusEl, error.message, true);
      }
    }
    function renderAccounts(accounts) {
      if (!accounts.length) { listEl.innerHTML = '<div class="muted">暂无账号。</div>'; return; }
      listEl.innerHTML = accounts.map((account) => {
        const headers = Object.keys(account.extraHeaders || {});
        return \`<article class="item">
          <div class="row">
            <div>
              <h3>\${account.label}</h3>
              <div class="muted mono" style="margin-top:6px">\${account.baseUrl}</div>
            </div>
            <div class="actions" style="margin-top:0">
              <button class="secondary" onclick="editAccount('\${account.id}')">编辑</button>
              <button class="secondary" onclick="testAccount('\${account.id}')">检测</button>
              <button class="secondary" onclick="toggleAccount('\${account.id}', \${!account.enabled})">\${account.enabled ? "停用" : "启用"}</button>
              <button class="danger" onclick="removeAccount('\${account.id}')">删除</button>
            </div>
          </div>
          <div class="meta">
            <span class="tag">\${account.id}</span>
            <span class="tag \${account.enabled ? "ok" : "off"}">\${account.enabled ? "启用中" : "已停用"}</span>
            <span class="tag">\${headers.length ? ("额外请求头 " + headers.length) : "无额外请求头"}</span>
            <span class="tag">\${account.unhealthyUntil && account.unhealthyUntil > Date.now() ? "冷却中" : "可参与轮询"}</span>
          </div>
        </article>\`;
      }).join("");
    }
    async function loadAccounts() {
      try {
        setStatus(statusEl, "正在加载账号列表...");
        const data = await api("/admin/accounts");
        renderAccounts(data.accounts || []);
        setSummary(data.summary || {});
        setStatus(statusEl, "账号列表已刷新。");
      } catch (error) {
        renderAccounts([]);
        setStatus(statusEl, error.message, true);
      }
    }
    async function addAccount() {
      try {
        const payload = {
          id: document.getElementById("id").value.trim(),
          label: document.getElementById("label").value.trim(),
          baseUrl: document.getElementById("baseUrl").value.trim(),
          apiKey: document.getElementById("apiKey").value.trim(),
          enabled: true,
          extraHeaders: parseExtraHeaders(),
        };
        await api("/admin/accounts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        setStatus(statusEl, "账号已保存。");
        document.getElementById("apiKey").value = "";
        await loadAccounts();
      } catch (error) {
        setStatus(statusEl, error.message, true);
      }
    }
    async function toggleAccount(id, enabled) {
      try {
        await api("/admin/accounts/" + encodeURIComponent(id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        setStatus(statusEl, enabled ? "账号已启用。" : "账号已停用。");
        await loadAccounts();
      } catch (error) {
        setStatus(statusEl, error.message, true);
      }
    }
    async function testAccount(id) {
      try {
        setStatus(statusEl, "正在检测账号...");
        const data = await api("/admin/accounts/" + encodeURIComponent(id) + "/test", { method: "POST" });
        setStatus(statusEl, "检测成功：" + (data.message || "可用"));
        await loadAccounts();
      } catch (error) {
        setStatus(statusEl, error.message, true);
      }
    }
    async function editAccount(id) {
      try {
        const data = await api("/admin/accounts/" + encodeURIComponent(id));
        const account = data.account;
        document.getElementById("id").value = account.id || "";
        document.getElementById("label").value = account.label || "";
        document.getElementById("baseUrl").value = account.baseUrl || "";
        document.getElementById("apiKey").value = "";
        document.getElementById("extraHeaders").value = JSON.stringify(account.extraHeaders || {}, null, 2);
        setStatus(statusEl, "已载入账号，可直接修改后保存。");
      } catch (error) {
        setStatus(statusEl, error.message, true);
      }
    }
    async function removeAccount(id) {
      if (!confirm("确认删除这个账号？")) return;
      try {
        await api("/admin/accounts/" + encodeURIComponent(id), { method: "DELETE" });
        setStatus(statusEl, "账号已删除。");
        await loadAccounts();
      } catch (error) {
        setStatus(statusEl, error.message, true);
      }
    }
    window.toggleAccount = toggleAccount;
    window.testAccount = testAccount;
    window.editAccount = editAccount;
    window.removeAccount = removeAccount;
    document.getElementById("gate-submit").addEventListener("click", () => {
      localStorage.setItem("rt-router-token", getToken());
      verify();
    });
    document.getElementById("add-account").addEventListener("click", addAccount);
    document.getElementById("reload").addEventListener("click", loadAccounts);
    document.getElementById("logout").addEventListener("click", () => {
      localStorage.removeItem("rt-router-token");
      tokenInput.value = "";
      currentTokenInput.value = "";
      appEl.classList.add("hidden");
      gateEl.classList.remove("hidden");
      renderAccounts([]);
      setSummary({ total: 0, enabled: 0, disabled: 0, cooling: 0 });
      setStatus(gateStatusEl, "已退出。");
    });
    if (getToken()) verify();
    else { renderAccounts([]); setSummary({ total: 0, enabled: 0, disabled: 0, cooling: 0 }); setStatus(gateStatusEl, "先输入服务访问密码。"); }
  </script>
</body>
</html>`;
}

async function readJsonBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/health") return json({ ok: true });
    if (pathname === "/" || pathname === "/admin/ui") return html(renderAdminPage());
    const stub = env.ROUTER_STATE.getByName("router");
    return stub.fetch(request);
  },
};

export class RouterState extends DurableObject<Env> {
  private accountsCache: AccountRecord[] | null = null;

  private async getAccounts(): Promise<AccountRecord[]> {
    if (this.accountsCache) return this.accountsCache;
    const saved = await this.ctx.storage.get<AccountRecord[]>(ACCOUNTS_KEY);
    this.accountsCache = Array.isArray(saved) ? saved : [];
    return this.accountsCache;
  }

  private async saveAccounts(accounts: AccountRecord[]): Promise<void> {
    this.accountsCache = accounts;
    await this.ctx.storage.put(ACCOUNTS_KEY, accounts);
  }

  private async getCursor(): Promise<number> {
    return (await this.ctx.storage.get<number>(CURSOR_KEY)) ?? 0;
  }

  private async setCursor(value: number): Promise<void> {
    await this.ctx.storage.put(CURSOR_KEY, value);
  }

  private getCooldownMs(): number {
    return Number(this.env.ACCOUNT_COOLDOWN_MS || 30000);
  }

  private async markHealthy(id: string): Promise<void> {
    const accounts = await this.getAccounts();
    const target = accounts.find((item) => item.id === id);
    if (!target) return;
    target.unhealthyUntil = 0;
    await this.saveAccounts(accounts);
  }

  private async markUnhealthy(id: string): Promise<void> {
    const accounts = await this.getAccounts();
    const target = accounts.find((item) => item.id === id);
    if (!target) return;
    target.unhealthyUntil = Date.now() + this.getCooldownMs();
    await this.saveAccounts(accounts);
  }

  private async probeAccount(account: AccountRecord): Promise<{ ok: boolean; status?: number; message: string }> {
    try {
      const response = await fetch(`${account.baseUrl}/v1/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${account.apiKey}`,
          ...(account.extraHeaders ?? {}),
        },
      });
      if (!response.ok) {
        await this.markUnhealthy(account.id);
        return { ok: false, status: response.status, message: `HTTP ${response.status}` };
      }
      await this.markHealthy(account.id);
      return { ok: true, status: response.status, message: "模型列表可用" };
    } catch (error) {
      await this.markUnhealthy(account.id);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async pickAccount(excluded: Set<string> = new Set()): Promise<AccountRecord | null> {
    const accounts = await this.getAccounts();
    const now = Date.now();
    const enabled = accounts.filter((item) => item.enabled && !excluded.has(item.id));
    const healthy = enabled.filter((item) => (item.unhealthyUntil ?? 0) <= now);
    const pool = healthy.length > 0 ? healthy : enabled;
    if (pool.length === 0) return null;
    const cursor = await this.getCursor();
    const account = pool[cursor % pool.length];
    await this.setCursor(cursor + 1);
    return account;
  }

  private buildUpstreamUrl(account: AccountRecord, requestUrl: URL): string {
    return `${account.baseUrl}${requestUrl.pathname}${requestUrl.search}`;
  }

  private withProxyHeaders(response: Response, accountId: string): Response {
    const headers = new Headers(response.headers);
    headers.set("x-router-account", accountId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private async proxyRequest(request: Request): Promise<Response> {
    const authError = ensureAuthorized(request, this.env.AUTH_TOKEN);
    if (authError) return authError;
    const requestUrl = new URL(request.url);
    if (!requestUrl.pathname.startsWith("/v1/")) {
      return json({ error: "Only /v1/* routes are supported" }, { status: 404 });
    }
    const requestBody = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
    const excluded = new Set<string>();
    while (true) {
      const account = await this.pickAccount(excluded);
      if (!account) return json({ error: "No available accounts" }, { status: 503 });
      try {
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${account.apiKey}`);
        headers.delete("host");
        if (account.extraHeaders) {
          for (const [key, value] of Object.entries(account.extraHeaders)) headers.set(key, value);
        }
        const upstream = await fetch(this.buildUpstreamUrl(account, requestUrl), {
          method: request.method,
          headers,
          body: requestBody,
          redirect: "manual",
        });
        if (upstream.status >= 500) {
          excluded.add(account.id);
          await this.markUnhealthy(account.id);
          if (excluded.size >= (await this.getAccounts()).filter((item) => item.enabled).length) {
            return this.withProxyHeaders(upstream, account.id);
          }
          continue;
        }
        await this.markHealthy(account.id);
        return this.withProxyHeaders(upstream, account.id);
      } catch (error) {
        excluded.add(account.id);
        await this.markUnhealthy(account.id);
        const enabledCount = (await this.getAccounts()).filter((item) => item.enabled).length;
        if (excluded.size >= enabledCount) {
          return json({ error: "All accounts failed", details: error instanceof Error ? error.message : String(error) }, { status: 502 });
        }
      }
    }
  }

  private async handleAdmin(request: Request): Promise<Response> {
    const authError = ensureAuthorized(request, this.env.AUTH_TOKEN);
    if (authError) return authError;
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/admin/verify" && request.method === "GET") {
      const accounts = await this.getAccounts();
      return json({ ok: true, summary: summarizeAccounts(accounts) });
    }
    if (pathname === "/admin/accounts" && request.method === "GET") {
      const accounts = await this.getAccounts();
      return json({ accounts: accounts.map(redactAccount), summary: summarizeAccounts(accounts) });
    }
    if (pathname === "/admin/accounts" && request.method === "POST") {
      const payload = sanitizeAccountInput(await readJsonBody<AccountInput>(request));
      const accounts = await this.getAccounts();
      const next = accounts.filter((item) => item.id !== payload.id);
      next.push(payload);
      await this.saveAccounts(next);
      return json({ ok: true, account: redactAccount(payload) }, { status: 201 });
    }
    const testMatch = pathname.match(/^\/admin\/accounts\/([^/]+)\/test$/);
    const itemMatch = pathname.match(/^\/admin\/accounts\/([^/]+)$/);
    const match = testMatch ?? itemMatch;
    if (!match) return json({ error: "Not found" }, { status: 404 });
    const accountId = decodeURIComponent(match[1]);
    const accounts = await this.getAccounts();
    const target = accounts.find((item) => item.id === accountId);
    if (!target) return json({ error: "Account not found" }, { status: 404 });
    if (request.method === "GET") {
      return json({ account: redactAccount(target) });
    }
    if (request.method === "POST" && testMatch) {
      const result = await this.probeAccount(target);
      return json(result, { status: result.ok ? 200 : 502 });
    }
    if (request.method === "DELETE") {
      await this.saveAccounts(accounts.filter((item) => item.id !== accountId));
      return json({ ok: true });
    }
    if (request.method === "PATCH") {
      const payload = await readJsonBody<Partial<AccountInput>>(request);
      if (typeof payload.label === "string") target.label = payload.label.trim() || target.label;
      if (typeof payload.baseUrl === "string" && payload.baseUrl.trim()) target.baseUrl = normalizeBaseUrl(payload.baseUrl);
      if (typeof payload.apiKey === "string" && payload.apiKey.trim()) target.apiKey = payload.apiKey.trim();
      if (typeof payload.enabled === "boolean") target.enabled = payload.enabled;
      if (payload.extraHeaders && typeof payload.extraHeaders === "object") target.extraHeaders = payload.extraHeaders;
      await this.saveAccounts(accounts);
      return json({ ok: true, account: redactAccount(target) });
    }
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/admin/")) {
      try {
        return await this.handleAdmin(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Bad request" }, { status: 400 });
      }
    }
    return this.proxyRequest(request);
  }
}
