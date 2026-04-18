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
  id?: string;
  label?: string;
  baseUrl: string;
  apiKey?: string;
  enabled?: boolean;
  extraHeaders?: Record<string, string>;
};

type AccountStat = {
  calls: number;
  errors: number;
  successes: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastStatus: number | null;
  lastUsedAt: number | null;
  lastError: string | null;
};

type PublicAccount = {
  id: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  extraHeaders: Record<string, string>;
  unhealthyUntil: number;
  stats: AccountStat;
};

const ACCOUNTS_KEY = "accounts";
const CURSOR_KEY = "cursor";
const STATS_KEY = "stats";

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

function createEmptyStat(): AccountStat {
  return {
    calls: 0,
    errors: 0,
    successes: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    lastStatus: null,
    lastUsedAt: null,
    lastError: null,
  };
}

function generateAccountId(): string {
  return `rt-${Math.floor(100000000 + Math.random() * 900000000)}`;
}

function sanitizeAccountInput(payload: AccountInput, fallbackApiKey: string): AccountRecord {
  const resolvedId = payload.id?.trim() || generateAccountId();
  if (!payload.baseUrl?.trim()) throw new Error("Account baseUrl is required");
  const resolvedApiKey = payload.apiKey?.trim() || fallbackApiKey.trim();
  if (!resolvedApiKey) throw new Error("Account apiKey is required");
  return {
    id: resolvedId,
    label: payload.label?.trim() || resolvedId,
    baseUrl: normalizeBaseUrl(payload.baseUrl),
    apiKey: resolvedApiKey,
    enabled: payload.enabled !== false,
    extraHeaders: payload.extraHeaders,
    unhealthyUntil: 0,
  };
}

function toPublicAccount(account: AccountRecord, stats: AccountStat): PublicAccount {
  return {
    id: account.id,
    label: account.label,
    baseUrl: account.baseUrl,
    enabled: account.enabled,
    extraHeaders: account.extraHeaders ?? {},
    unhealthyUntil: account.unhealthyUntil ?? 0,
    stats,
  };
}

function summarizeAccounts(accounts: AccountRecord[], statsMap: Record<string, AccountStat>) {
  const now = Date.now();
  const enabled = accounts.filter((account) => account.enabled).length;
  const cooling = accounts.filter((account) => (account.unhealthyUntil ?? 0) > now).length;
  const stats = Object.values(statsMap);
  return {
    total: accounts.length,
    enabled,
    disabled: accounts.length - enabled,
    cooling,
    calls: stats.reduce((sum, item) => sum + item.calls, 0),
    successes: stats.reduce((sum, item) => sum + item.successes, 0),
    errors: stats.reduce((sum, item) => sum + item.errors, 0),
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
    :root {
      color-scheme: light dark;
      --muted: #8b96b2;
      --line: #26304a;
      --text: #eef2ff;
      --accent: #5b8cff;
      --accent-2: #2bd4a8;
      --danger: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #0b1020, #0f1530);
      color: var(--text);
    }
    .hidden { display: none !important; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 28px 20px 80px; }
    .gate {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .gate-card, .card {
      background: rgba(17, 24, 45, 0.94);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.26);
    }
    .gate-card { width: 100%; max-width: 460px; padding: 28px; }
    .gate-card h1, .header h1 { margin: 0 0 8px; font-size: 28px; }
    .gate-card p, .muted { color: var(--muted); line-height: 1.6; }
    .field, .grid { display: grid; gap: 10px; }
    .grid.two { grid-template-columns: 1fr 1fr; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: #0b1122;
      color: var(--text);
      border-radius: 12px;
      padding: 12px 14px;
      font: inherit;
    }
    textarea { min-height: 96px; resize: vertical; }
    button {
      border: 0;
      border-radius: 12px;
      padding: 10px 14px;
      font: inherit;
      cursor: pointer;
      color: white;
      background: var(--accent);
    }
    button.secondary { background: #22304f; }
    button.danger { background: var(--danger); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
    .top { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 16px; margin-bottom: 16px; }
    .card { padding: 20px; }
    .status { min-height: 18px; font-size: 13px; color: var(--muted); margin-top: 10px; }
    .stats { display: grid; grid-template-columns: repeat(7, 1fr); gap: 12px; margin-bottom: 16px; }
    .stat, .mini { border: 1px solid var(--line); border-radius: 14px; background: rgba(8, 13, 28, 0.62); padding: 14px; }
    .stat b, .mini b { display: block; font-size: 20px; margin-bottom: 4px; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin: 18px 0 14px; }
    .check { width: 16px; height: 16px; accent-color: var(--accent); }
    .dashboard { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
    .account-card { border: 1px solid var(--line); border-radius: 18px; background: rgba(8, 13, 28, 0.72); padding: 18px; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
    .meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .tag { padding: 4px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); color: var(--muted); }
    .tag.ok { color: var(--accent-2); border-color: rgba(43, 212, 168, 0.35); }
    .tag.off { color: #ffb86b; border-color: rgba(255, 184, 107, 0.35); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .account-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 14px; }
    .list-empty { border: 1px dashed var(--line); border-radius: 18px; padding: 28px; color: var(--muted); text-align: center; }
    @media (max-width: 1100px) { .stats { grid-template-columns: repeat(4, 1fr); } }
    @media (max-width: 860px) { .top, .grid.two, .dashboard, .account-grid, .stats { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 560px) { .top, .grid.two, .dashboard, .account-grid, .stats { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <section id="gate" class="gate">
    <div class="gate-card">
      <h1>RT Account Router</h1>
      <p>先输入服务访问密码完成验证，再进入多账号轮询控制台。</p>
      <div class="field" style="margin-top:18px">
        <input id="token" type="password" placeholder="请输入服务访问密码" />
        <button id="gate-submit">进入控制台</button>
      </div>
      <div class="status" id="gate-status"></div>
    </div>
  </section>

  <main id="app" class="wrap hidden">
    <div class="header">
      <div>
        <h1>RT Account Router</h1>
        <p class="muted">只保留多账号轮询。这里按账号维度管理上游池，并展示请求仪表盘。</p>
      </div>
      <div class="actions" style="margin-top:0">
        <button class="secondary" id="reload">刷新</button>
        <button class="danger" id="logout">退出</button>
      </div>
    </div>

    <section class="stats">
      <div class="stat"><b id="sum-total">0</b><span class="muted">总账号</span></div>
      <div class="stat"><b id="sum-enabled">0</b><span class="muted">启用中</span></div>
      <div class="stat"><b id="sum-disabled">0</b><span class="muted">已停用</span></div>
      <div class="stat"><b id="sum-cooling">0</b><span class="muted">冷却中</span></div>
      <div class="stat"><b id="sum-calls">0</b><span class="muted">总请求</span></div>
      <div class="stat"><b id="sum-successes">0</b><span class="muted">成功</span></div>
      <div class="stat"><b id="sum-errors">0</b><span class="muted">失败</span></div>
    </section>

    <div class="top">
      <section class="card">
        <h2 style="margin:0 0 8px;font-size:16px">添加 / 编辑账号</h2>
        <p class="muted" style="margin:0 0 14px">账号 ID 和 API Key 都可留空。留空时会自动生成 ID，并默认复用当前站点验证密码。</p>
        <div class="grid two">
          <input id="id" placeholder="账号 ID（可留空，默认 rt-123456789）" />
          <input id="label" placeholder="显示名称，可留空" />
        </div>
        <div class="grid two" style="margin-top:10px">
          <input id="baseUrl" placeholder="上游 Base URL，例如 https://api.openai.com" />
          <input id="apiKey" placeholder="上游 API Key（可留空，默认复用当前密码）" />
        </div>
        <div class="grid" style="margin-top:10px">
          <textarea id="extraHeaders" placeholder='可选额外请求头 JSON，例如 {"OpenAI-Organization":"org_xxx"}'></textarea>
        </div>
        <div class="actions">
          <button id="add-account">添加 / 覆盖账号</button>
          <button class="secondary" id="clear-form">清空表单</button>
        </div>
        <div class="status" id="status"></div>
      </section>

      <section class="card">
        <h2 style="margin:0 0 8px;font-size:16px">当前状态</h2>
        <p class="muted" style="margin:0 0 14px">当前已通过验证的访问密码只用于浏览器会话。API 检测会使用下面的测试模型。</p>
        <div class="field">
          <input id="current-token" type="password" disabled />
          <input id="api-test-model" placeholder="API 检测模型，默认 gpt-4.1-mini" />
        </div>
        <div class="status" id="meta-status"></div>
      </section>
    </div>

    <section class="card">
      <div class="row">
        <div>
          <h2 style="margin:0 0 8px;font-size:16px">账号仪表盘</h2>
          <p class="muted" style="margin:0">支持选择、批量启停、批量检测，以及查看每个账号的运行统计。</p>
        </div>
      </div>
      <div class="toolbar">
        <label class="muted" style="display:flex;align-items:center;gap:8px">
          <input id="select-all" class="check" type="checkbox" />
          全选账号
        </label>
        <div class="actions" style="margin-top:0">
          <button class="secondary" id="export-accounts">导出</button>
          <button class="secondary" id="import-accounts">导入</button>
          <button class="secondary" id="batch-enable">批量启用</button>
          <button class="secondary" id="batch-disable">批量停用</button>
        </div>
      </div>
      <div id="accounts" class="dashboard"></div>
    </section>
  </main>
  <script>
    const gateEl = document.getElementById("gate");
    const appEl = document.getElementById("app");
    const statusEl = document.getElementById("status");
    const gateStatusEl = document.getElementById("gate-status");
    const metaStatusEl = document.getElementById("meta-status");
    const listEl = document.getElementById("accounts");
    const tokenInput = document.getElementById("token");
    const currentTokenInput = document.getElementById("current-token");
    const apiTestModelInput = document.getElementById("api-test-model");
    const selectedIds = new Set();
    let currentAccounts = [];
    tokenInput.value = localStorage.getItem("rt-router-token") || "";
    currentTokenInput.value = tokenInput.value;
    apiTestModelInput.value = localStorage.getItem("rt-router-api-test-model") || "gpt-4.1-mini";
    function setStatus(target, message, isError = false) {
      target.textContent = message || "";
      target.style.color = isError ? "#ff8f8f" : "#8b96b2";
    }
    function getToken() {
      return tokenInput.value.trim();
    }
    function getApiTestModel() {
      return (apiTestModelInput.value || "").trim() || "gpt-4.1-mini";
    }
    function parseExtraHeaders() {
      const raw = document.getElementById("extraHeaders").value.trim();
      if (!raw) return undefined;
      return JSON.parse(raw);
    }
    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          ...(options.headers || {}),
          authorization: "Bearer " + getToken(),
        },
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
      document.getElementById("sum-calls").textContent = String(summary.calls || 0);
      document.getElementById("sum-successes").textContent = String(summary.successes || 0);
      document.getElementById("sum-errors").textContent = String(summary.errors || 0);
    }
    function unlockApp() {
      gateEl.classList.add("hidden");
      appEl.classList.remove("hidden");
      currentTokenInput.value = getToken();
    }
    async function verify() {
      try {
        localStorage.setItem("rt-router-token", getToken());
        setStatus(gateStatusEl, "验证中...");
        const data = await api("/admin/verify");
        setSummary(data.summary || {});
        unlockApp();
        setStatus(gateStatusEl, "");
        setStatus(metaStatusEl, "验证通过。");
        await loadAccounts();
        await probeAllAccounts();
      } catch (error) {
        setStatus(gateStatusEl, error.message, true);
      }
    }
    function clearForm() {
      document.getElementById("id").value = "";
      document.getElementById("label").value = "";
      document.getElementById("baseUrl").value = "";
      document.getElementById("apiKey").value = "";
      document.getElementById("extraHeaders").value = "";
    }
    function syncSelectAll() {
      const selectAll = document.getElementById("select-all");
      selectAll.checked = currentAccounts.length > 0 && currentAccounts.every((account) => selectedIds.has(account.id));
    }
    function renderAccounts(accounts) {
      currentAccounts = accounts;
      if (!accounts.length) {
        listEl.innerHTML = '<div class="list-empty">暂无账号。</div>';
        syncSelectAll();
        return;
      }
      listEl.innerHTML = accounts.map((account) => {
        const headers = Object.keys(account.extraHeaders || {});
        const checked = selectedIds.has(account.id) ? "checked" : "";
        return \`
          <article class="account-card">
            <div class="row">
              <div style="display:flex;gap:10px;align-items:flex-start">
                <input class="check" type="checkbox" data-account-check="\${account.id}" \${checked} />
                <div>
                  <h3 style="margin:0;font-size:17px">\${account.label}</h3>
                  <div class="muted mono" style="margin-top:6px">\${account.baseUrl}</div>
                </div>
              </div>
              <div class="actions" style="margin-top:0">
                <button class="secondary" onclick="editAccount('\${account.id}')">编辑</button>
                <button class="secondary" onclick="testAccount('\${account.id}')">API 检测</button>
                <button class="secondary" onclick="toggleAccount('\${account.id}', \${!account.enabled})">\${account.enabled ? "停用" : "启用"}</button>
                <button class="danger" onclick="removeAccount('\${account.id}')">删除</button>
              </div>
            </div>
            <div class="meta">
              <span class="tag">\${account.id}</span>
              <span class="tag \${account.enabled ? "ok" : "off"}">\${account.enabled ? "启用中" : "已停用"}</span>
              <span class="tag">\${headers.length ? ("额外请求头 " + headers.length) : "无额外请求头"}</span>
              <span class="tag">\${account.unhealthyUntil && account.unhealthyUntil > Date.now() ? "冷却中" : "可参与轮询"}</span>
              <span class="tag">\${account.stats.lastStatus ? ("上次状态 " + account.stats.lastStatus) : "尚无请求"}</span>
            </div>
            <div class="account-grid">
              <div class="mini"><b>\${account.stats.calls}</b><span class="muted">请求</span></div>
              <div class="mini"><b>\${account.stats.successes}</b><span class="muted">成功</span></div>
              <div class="mini"><b>\${account.stats.errors}</b><span class="muted">失败</span></div>
              <div class="mini"><b>\${account.stats.avgDurationMs}ms</b><span class="muted">均耗时</span></div>
            </div>
            <div class="muted" style="margin-top:12px;font-size:12px">
              \${account.stats.lastUsedAt ? ("最近使用：" + new Date(account.stats.lastUsedAt).toLocaleString()) : "最近使用：暂无"}
              \${account.stats.lastError ? (" ｜ 最近错误：" + account.stats.lastError) : ""}
            </div>
          </article>
        \`;
      }).join("");
      document.querySelectorAll("[data-account-check]").forEach((input) => {
        input.addEventListener("change", (event) => {
          const id = event.target.getAttribute("data-account-check");
          if (!id) return;
          if (event.target.checked) selectedIds.add(id);
          else selectedIds.delete(id);
          syncSelectAll();
        });
      });
      syncSelectAll();
    }
    async function loadAccounts() {
      try {
        setStatus(statusEl, "正在加载账号列表...");
        const data = await api("/admin/accounts");
        const ids = new Set((data.accounts || []).map((account) => account.id));
        [...selectedIds].forEach((id) => { if (!ids.has(id)) selectedIds.delete(id); });
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
        setStatus(statusEl, "正在做 API 检测...");
        const data = await api("/admin/accounts/" + encodeURIComponent(id) + "/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "chat", model: getApiTestModel() }),
        });
        setStatus(statusEl, "API 检测成功：" + (data.message || "可用"));
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
        selectedIds.delete(id);
        setStatus(statusEl, "账号已删除。");
        await loadAccounts();
      } catch (error) {
        setStatus(statusEl, error.message, true);
      }
    }
    async function batchToggle(enabled) {
      if (!selectedIds.size) {
        setStatus(statusEl, "先选择账号。", true);
        return;
      }
      try {
        await api("/admin/accounts/batch", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [...selectedIds], enabled }),
        });
        setStatus(statusEl, enabled ? "批量启用完成。" : "批量停用完成。");
        await loadAccounts();
      } catch (error) {
        setStatus(statusEl, error.message, true);
      }
    }
    async function probeAllAccounts() {
      try {
        setStatus(metaStatusEl, "正在自动检测账号存活...");
        const data = await api("/admin/accounts/test-all", { method: "POST" });
        setStatus(metaStatusEl, "自动检测完成：" + (data.okCount || 0) + "/" + (data.total || 0) + " 可用。");
        await loadAccounts();
      } catch (error) {
        setStatus(metaStatusEl, error.message, true);
      }
    }
    function downloadJson(filename, data) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    }
    async function exportAccounts() {
      try {
        const data = await api("/admin/accounts/export");
        downloadJson("rt-account-router-accounts.json", data);
        setStatus(statusEl, "账号已导出。");
      } catch (error) {
        setStatus(statusEl, error.message, true);
      }
    }
    async function importAccounts() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const payload = JSON.parse(text);
          const data = await api("/admin/accounts/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          setStatus(statusEl, "导入完成：" + (data.imported || 0) + " 个账号。");
          await loadAccounts();
        } catch (error) {
          setStatus(statusEl, error.message, true);
        }
      };
      input.click();
    }
    window.toggleAccount = toggleAccount;
    window.testAccount = testAccount;
    window.editAccount = editAccount;
    window.removeAccount = removeAccount;
    document.getElementById("gate-submit").addEventListener("click", verify);
    document.getElementById("add-account").addEventListener("click", addAccount);
    document.getElementById("reload").addEventListener("click", loadAccounts);
    document.getElementById("clear-form").addEventListener("click", clearForm);
    document.getElementById("export-accounts").addEventListener("click", exportAccounts);
    document.getElementById("import-accounts").addEventListener("click", importAccounts);
    document.getElementById("batch-enable").addEventListener("click", () => batchToggle(true));
    document.getElementById("batch-disable").addEventListener("click", () => batchToggle(false));
    apiTestModelInput.addEventListener("change", () => {
      localStorage.setItem("rt-router-api-test-model", getApiTestModel());
    });
    document.getElementById("select-all").addEventListener("change", (event) => {
      const checked = event.target.checked;
      currentAccounts.forEach((account) => {
        if (checked) selectedIds.add(account.id);
        else selectedIds.delete(account.id);
      });
      renderAccounts(currentAccounts);
    });
    document.getElementById("logout").addEventListener("click", () => {
      localStorage.removeItem("rt-router-token");
      tokenInput.value = "";
      currentTokenInput.value = "";
      selectedIds.clear();
      appEl.classList.add("hidden");
      gateEl.classList.remove("hidden");
      renderAccounts([]);
      setSummary({ total: 0, enabled: 0, disabled: 0, cooling: 0, calls: 0, successes: 0, errors: 0 });
      setStatus(gateStatusEl, "已退出。");
    });
    if (getToken()) verify();
    else {
      renderAccounts([]);
      setSummary({ total: 0, enabled: 0, disabled: 0, cooling: 0, calls: 0, successes: 0, errors: 0 });
      setStatus(gateStatusEl, "先输入服务访问密码。");
    }
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
  private statsCache: Record<string, AccountStat> | null = null;

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

  private async getStatsMap(): Promise<Record<string, AccountStat>> {
    if (this.statsCache) return this.statsCache;
    const saved = await this.ctx.storage.get<Record<string, AccountStat>>(STATS_KEY);
    this.statsCache = saved && typeof saved === "object" ? saved : {};
    return this.statsCache;
  }

  private async saveStatsMap(statsMap: Record<string, AccountStat>): Promise<void> {
    this.statsCache = statsMap;
    await this.ctx.storage.put(STATS_KEY, statsMap);
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

  private async recordProxyResult(id: string, status: number, durationMs: number, errorMessage?: string): Promise<void> {
    const statsMap = await this.getStatsMap();
    const current = statsMap[id] ?? createEmptyStat();
    current.calls += 1;
    current.lastStatus = status;
    current.lastUsedAt = Date.now();
    current.totalDurationMs += durationMs;
    current.avgDurationMs = current.calls > 0 ? Math.round(current.totalDurationMs / current.calls) : 0;
    if (status >= 200 && status < 500) {
      current.successes += 1;
      current.lastError = null;
    } else {
      current.errors += 1;
      current.lastError = errorMessage ?? `HTTP ${status}`;
    }
    statsMap[id] = current;
    await this.saveStatsMap(statsMap);
  }

  private async getAccountsWithStats(): Promise<PublicAccount[]> {
    const [accounts, statsMap] = await Promise.all([this.getAccounts(), this.getStatsMap()]);
    return accounts.map((account) => toPublicAccount(account, statsMap[account.id] ?? createEmptyStat()));
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
        await this.recordProxyResult(account.id, response.status, 0, `HTTP ${response.status}`);
        return { ok: false, status: response.status, message: `HTTP ${response.status}` };
      }
      await this.markHealthy(account.id);
      await this.recordProxyResult(account.id, response.status, 0);
      return { ok: true, status: response.status, message: "模型列表可用" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markUnhealthy(account.id);
      await this.recordProxyResult(account.id, 502, 0, message);
      return { ok: false, message };
    }
  }

  private async apiTestAccount(account: AccountRecord, model: string): Promise<{ ok: boolean; status?: number; message: string }> {
    try {
      const response = await fetch(`${account.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${account.apiKey}`,
          ...(account.extraHeaders ?? {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          max_tokens: 8,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        await this.recordProxyResult(account.id, response.status, 0, text || `HTTP ${response.status}`);
        return { ok: false, status: response.status, message: text || `HTTP ${response.status}` };
      }
      await this.recordProxyResult(account.id, response.status, 0);
      return { ok: true, status: response.status, message: `模型 ${model} 可用` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordProxyResult(account.id, 502, 0, message);
      return { ok: false, message };
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
      const startedAt = Date.now();
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
          await this.recordProxyResult(account.id, upstream.status, Date.now() - startedAt, `HTTP ${upstream.status}`);
          if (excluded.size >= (await this.getAccounts()).filter((item) => item.enabled).length) {
            return this.withProxyHeaders(upstream, account.id);
          }
          continue;
        }
        await this.markHealthy(account.id);
        await this.recordProxyResult(account.id, upstream.status, Date.now() - startedAt);
        return this.withProxyHeaders(upstream, account.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        excluded.add(account.id);
        await this.markUnhealthy(account.id);
        await this.recordProxyResult(account.id, 502, Date.now() - startedAt, message);
        const enabledCount = (await this.getAccounts()).filter((item) => item.enabled).length;
        if (excluded.size >= enabledCount) {
          return json({ error: "All accounts failed", details: message }, { status: 502 });
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
      const [accounts, statsMap] = await Promise.all([this.getAccounts(), this.getStatsMap()]);
      return json({ ok: true, summary: summarizeAccounts(accounts, statsMap) });
    }

    if (pathname === "/admin/accounts" && request.method === "GET") {
      const [accounts, statsMap, records] = await Promise.all([
        this.getAccounts(),
        this.getStatsMap(),
        this.getAccountsWithStats(),
      ]);
      return json({ accounts: records, summary: summarizeAccounts(accounts, statsMap) });
    }

    if (pathname === "/admin/accounts" && request.method === "POST") {
      const payload = sanitizeAccountInput(await readJsonBody<AccountInput>(request), this.env.AUTH_TOKEN);
      const accounts = await this.getAccounts();
      const next = accounts.filter((item) => item.id !== payload.id);
      next.push(payload);
      await this.saveAccounts(next);
      const statsMap = await this.getStatsMap();
      return json({ ok: true, account: toPublicAccount(payload, statsMap[payload.id] ?? createEmptyStat()) }, { status: 201 });
    }

    if (pathname === "/admin/accounts/export" && request.method === "GET") {
      const accounts = await this.getAccounts();
      return json({
        exportedAt: Date.now(),
        accounts: accounts.map((account) => ({
          id: account.id,
          label: account.label,
          baseUrl: account.baseUrl,
          apiKey: account.apiKey,
          enabled: account.enabled,
          extraHeaders: account.extraHeaders ?? {},
        })),
      });
    }

    if (pathname === "/admin/accounts/import" && request.method === "POST") {
      const payload = await readJsonBody<{ accounts?: AccountInput[] }>(request);
      const incoming = Array.isArray(payload.accounts) ? payload.accounts : [];
      const accounts = await this.getAccounts();
      const next = [...accounts];
      let imported = 0;

      for (const item of incoming) {
        const normalized = sanitizeAccountInput(item, this.env.AUTH_TOKEN);
        const index = next.findIndex((existing) => existing.id === normalized.id);
        if (index >= 0) next[index] = normalized;
        else next.push(normalized);
        imported += 1;
      }

      await this.saveAccounts(next);
      return json({ ok: true, imported });
    }

    if (pathname === "/admin/accounts/batch" && request.method === "PATCH") {
      const payload = await readJsonBody<{ ids: string[]; enabled: boolean }>(request);
      const ids = new Set(payload.ids ?? []);
      const accounts = await this.getAccounts();
      let changed = 0;
      for (const account of accounts) {
        if (!ids.has(account.id)) continue;
        account.enabled = payload.enabled;
        changed += 1;
      }
      await this.saveAccounts(accounts);
      return json({ ok: true, changed });
    }

    if (pathname === "/admin/accounts/test-all" && request.method === "POST") {
      const accounts = await this.getAccounts();
      const targets = accounts.filter((account) => account.enabled);
      const results = await Promise.all(targets.map((account) => this.probeAccount(account)));
      const okCount = results.filter((item) => item.ok).length;
      return json({ ok: okCount === targets.length, total: targets.length, okCount });
    }

    const testMatch = pathname.match(/^\/admin\/accounts\/([^/]+)\/test$/);
    const itemMatch = pathname.match(/^\/admin\/accounts\/([^/]+)$/);
    const match = testMatch ?? itemMatch;
    if (!match) return json({ error: "Not found" }, { status: 404 });

    const accountId = decodeURIComponent(match[1]);
    const accounts = await this.getAccounts();
    const target = accounts.find((item) => item.id === accountId);
    if (!target) return json({ error: "Account not found" }, { status: 404 });

    if (request.method === "GET" && itemMatch) {
      const statsMap = await this.getStatsMap();
      return json({ account: toPublicAccount(target, statsMap[target.id] ?? createEmptyStat()) });
    }

    if (request.method === "POST" && testMatch) {
      const payload = await readJsonBody<{ mode?: "health" | "chat"; model?: string }>(request);
      const result = payload.mode === "chat"
        ? await this.apiTestAccount(target, payload.model?.trim() || "gpt-4.1-mini")
        : await this.probeAccount(target);
      return json(result, { status: result.ok ? 200 : 502 });
    }

    if (request.method === "DELETE" && itemMatch) {
      await this.saveAccounts(accounts.filter((item) => item.id !== accountId));
      const statsMap = await this.getStatsMap();
      delete statsMap[accountId];
      await this.saveStatsMap(statsMap);
      return json({ ok: true });
    }

    if (request.method === "PATCH" && itemMatch) {
      const payload = await readJsonBody<Partial<AccountInput>>(request);
      if (typeof payload.label === "string") target.label = payload.label.trim() || target.label;
      if (typeof payload.baseUrl === "string" && payload.baseUrl.trim()) target.baseUrl = normalizeBaseUrl(payload.baseUrl);
      if (typeof payload.apiKey === "string" && payload.apiKey.trim()) target.apiKey = payload.apiKey.trim();
      if (typeof payload.enabled === "boolean") target.enabled = payload.enabled;
      if (payload.extraHeaders && typeof payload.extraHeaders === "object") target.extraHeaders = payload.extraHeaders;
      await this.saveAccounts(accounts);
      const statsMap = await this.getStatsMap();
      return json({ ok: true, account: toPublicAccount(target, statsMap[target.id] ?? createEmptyStat()) });
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
