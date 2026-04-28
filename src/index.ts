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

type AccountHealth = {
  checks: number;
  failures: number;
  lastOk: boolean | null;
  lastStatus: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  mode: "health" | "chat" | null;
};

type PublicAccount = {
  id: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  extraHeaders: Record<string, string>;
  unhealthyUntil: number;
  stats: AccountStat;
  health: AccountHealth;
};

const ACCOUNTS_KEY = "accounts";
const CURSOR_KEY = "cursor";
const STATS_KEY = "stats";
const HEALTH_KEY = "health";

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

function createEmptyHealth(): AccountHealth {
  return {
    checks: 0,
    failures: 0,
    lastOk: null,
    lastStatus: null,
    lastCheckedAt: null,
    lastError: null,
    mode: null,
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

function toPublicAccount(account: AccountRecord, stats: AccountStat, health: AccountHealth): PublicAccount {
  return {
    id: account.id,
    label: account.label,
    baseUrl: account.baseUrl,
    enabled: account.enabled,
    extraHeaders: account.extraHeaders ?? {},
    unhealthyUntil: account.unhealthyUntil ?? 0,
    stats,
    health,
  };
}

function summarizeAccounts(
  accounts: AccountRecord[],
  statsMap: Record<string, AccountStat>,
  healthMap: Record<string, AccountHealth> = {},
) {
  const now = Date.now();
  const enabled = accounts.filter((account) => account.enabled).length;
  const cooling = accounts.filter((account) => (account.unhealthyUntil ?? 0) > now).length;
  const stats = Object.values(statsMap);
  const successes = stats.reduce((sum, item) => sum + item.successes, 0);
  const calls = stats.reduce((sum, item) => sum + item.calls, 0);
  const health = accounts.map((account) => healthMap[account.id] ?? createEmptyHealth());
  const available = accounts.filter((account) => {
    const item = healthMap[account.id];
    return account.enabled && (account.unhealthyUntil ?? 0) <= now && item?.lastOk !== false;
  }).length;
  const actionRequired = accounts.filter((account) => {
    const item = healthMap[account.id];
    return account.enabled && ((account.unhealthyUntil ?? 0) > now || item?.lastOk === false);
  }).length;
  return {
    total: accounts.length,
    enabled,
    disabled: accounts.length - enabled,
    cooling,
    available,
    actionRequired,
    calls,
    successes,
    errors: stats.reduce((sum, item) => sum + item.errors, 0),
    healthChecks: health.reduce((sum, item) => sum + item.checks, 0),
    successRate: calls > 0 ? Math.round((successes / calls) * 100) : 0,
    avgDurationMs: calls > 0
      ? Math.round(stats.reduce((sum, item) => sum + item.totalDurationMs, 0) / calls)
      : 0,
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
      --panel: rgba(17, 24, 45, 0.94);
      --panel-soft: rgba(8, 13, 28, 0.62);
      --motion-fast: 150ms;
      --motion-med: 280ms;
      --motion-slow: 520ms;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(135deg, rgba(91, 140, 255, 0.10), transparent 34%),
        linear-gradient(215deg, rgba(43, 212, 168, 0.08), transparent 32%),
        linear-gradient(180deg, #0b1020, #0f1530);
      background-attachment: fixed;
      color: var(--text);
    }
    .hidden { display: none !important; }
    .wrap { max-width: 1320px; margin: 0 auto; padding: 28px 20px 80px; animation: pageIn var(--motion-slow) ease-out both; }
    .gate {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .gate-card, .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.26);
      transform: translateZ(0);
      transition: border-color var(--motion-med) ease, box-shadow var(--motion-med) ease, transform var(--motion-med) ease;
    }
    .gate-card { animation: panelIn var(--motion-slow) ease-out both; }
    .card:hover, .gate-card:hover {
      border-color: rgba(91, 140, 255, 0.42);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
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
      border-radius: 8px;
      padding: 12px 14px;
      font: inherit;
      transition: border-color var(--motion-fast) ease, box-shadow var(--motion-fast) ease, background var(--motion-fast) ease;
    }
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: rgba(91, 140, 255, 0.75);
      box-shadow: 0 0 0 3px rgba(91, 140, 255, 0.16);
      background: #0e1730;
    }
    textarea { min-height: 96px; resize: vertical; }
    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 14px;
      font: inherit;
      cursor: pointer;
      color: white;
      background: var(--accent);
      position: relative;
      overflow: hidden;
      transform: translateZ(0);
      transition: transform var(--motion-fast) ease, box-shadow var(--motion-fast) ease, filter var(--motion-fast) ease, background var(--motion-fast) ease;
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 10px 22px rgba(0, 0, 0, 0.22); filter: brightness(1.05); }
    button:active { transform: translateY(0) scale(0.98); box-shadow: none; }
    button:disabled { cursor: wait; }
    button.busy { pointer-events: none; opacity: 0.72; }
    button.busy::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.18), transparent);
      animation: sheen 1s linear infinite;
    }
    button.secondary { background: #22304f; }
    button.danger { background: var(--danger); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
    .top { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 16px; margin-bottom: 16px; }
    .card { padding: 20px; animation: panelIn var(--motion-slow) ease-out both; }
    .top .card:nth-child(1) { animation-delay: 80ms; }
    .top .card:nth-child(2) { animation-delay: 140ms; }
    .status { min-height: 18px; font-size: 13px; color: var(--muted); margin-top: 10px; transition: color var(--motion-fast) ease, opacity var(--motion-fast) ease; }
    .status.flash { animation: statusFlash 620ms ease-out; }
    .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 16px; }
    .stat, .mini {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
      padding: 14px;
      animation: panelIn var(--motion-slow) ease-out both;
      transition: border-color var(--motion-med) ease, transform var(--motion-med) ease, background var(--motion-med) ease;
    }
    .stat:hover, .mini:hover { transform: translateY(-2px); border-color: rgba(91, 140, 255, 0.36); background: rgba(10, 18, 38, 0.76); }
    .stat:nth-child(1) { animation-delay: 20ms; }
    .stat:nth-child(2) { animation-delay: 40ms; }
    .stat:nth-child(3) { animation-delay: 60ms; }
    .stat:nth-child(4) { animation-delay: 80ms; }
    .stat:nth-child(5) { animation-delay: 100ms; }
    .stat:nth-child(6) { animation-delay: 120ms; }
    .stat:nth-child(7) { animation-delay: 140ms; }
    .stat:nth-child(8) { animation-delay: 160ms; }
    .stat:nth-child(9) { animation-delay: 180ms; }
    .stat:nth-child(10) { animation-delay: 200ms; }
    .stat:nth-child(11) { animation-delay: 220ms; }
    .stat b, .mini b { display: block; font-size: 20px; margin-bottom: 4px; transition: transform var(--motion-fast) ease, color var(--motion-fast) ease; }
    .value-pop { animation: valuePop 360ms ease-out; color: #ffffff; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin: 18px 0 14px; }
    .check { width: 16px; height: 16px; accent-color: var(--accent); transition: transform var(--motion-fast) ease; }
    .check:checked { transform: scale(1.08); }
    .fleet-board { display: grid; grid-template-columns: 0.8fr 1.2fr; gap: 16px; margin-bottom: 16px; }
    .rank-list { display: grid; gap: 10px; }
    .rank-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; animation: rowIn 360ms ease-out both; }
    .bar { height: 8px; border-radius: 999px; background: #151d35; overflow: hidden; margin-top: 6px; }
    .bar i {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      transition: width 680ms cubic-bezier(0.22, 1, 0.36, 1);
      box-shadow: 0 0 16px rgba(43, 212, 168, 0.22);
    }
    .filters { display: grid; grid-template-columns: minmax(220px, 1fr) 170px 170px; gap: 10px; width: min(100%, 680px); }
    select {
      width: 100%;
      border: 1px solid var(--line);
      background: #0b1122;
      color: var(--text);
      border-radius: 8px;
      padding: 12px 14px;
      font: inherit;
      transition: border-color var(--motion-fast) ease, box-shadow var(--motion-fast) ease, background var(--motion-fast) ease;
    }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; min-width: 1040px; }
    th, td { padding: 12px 10px; border-bottom: 1px solid var(--line); text-align: left; font-size: 13px; vertical-align: middle; }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; background: rgba(8, 13, 28, 0.92); }
    tr:last-child td { border-bottom: 0; }
    tbody tr {
      animation: rowIn 360ms ease-out both;
      transition: background var(--motion-fast) ease, transform var(--motion-fast) ease;
    }
    tbody tr:hover { background: rgba(91, 140, 255, 0.07); transform: translateX(2px); }
    tbody tr.row-attention { background: rgba(255, 107, 107, 0.035); }
    tbody tr.row-available { background: rgba(43, 212, 168, 0.025); }
    .node-title { display: grid; gap: 4px; min-width: 220px; }
    .node-title b { font-size: 14px; }
    .node-url { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .inline-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; min-width: 260px; }
    .inline-actions button { padding: 7px 9px; font-size: 12px; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
    .meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .tag {
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid var(--line);
      color: var(--muted);
      transition: background var(--motion-fast) ease, border-color var(--motion-fast) ease, transform var(--motion-fast) ease;
    }
    .tag.ok { color: var(--accent-2); border-color: rgba(43, 212, 168, 0.35); animation: okPulse 2.8s ease-in-out infinite; }
    .tag.off { color: #ffb86b; border-color: rgba(255, 184, 107, 0.35); }
    .tag.bad { color: var(--danger); border-color: rgba(255, 107, 107, 0.35); animation: warnPulse 1.8s ease-in-out infinite; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .list-empty { border: 1px dashed var(--line); border-radius: 8px; padding: 28px; color: var(--muted); text-align: center; animation: panelIn var(--motion-slow) ease-out both; }
    @keyframes pageIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes panelIn {
      from { opacity: 0; transform: translateY(12px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes rowIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes valuePop {
      0% { transform: scale(0.96); }
      45% { transform: scale(1.08); }
      100% { transform: scale(1); }
    }
    @keyframes statusFlash {
      0% { opacity: 0.35; transform: translateY(-2px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    @keyframes sheen {
      from { transform: translateX(-100%); }
      to { transform: translateX(100%); }
    }
    @keyframes okPulse {
      0%, 100% { box-shadow: 0 0 0 rgba(43, 212, 168, 0); }
      50% { box-shadow: 0 0 14px rgba(43, 212, 168, 0.12); }
    }
    @keyframes warnPulse {
      0%, 100% { box-shadow: 0 0 0 rgba(255, 107, 107, 0); }
      50% { box-shadow: 0 0 14px rgba(255, 107, 107, 0.16); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 1ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: 1ms !important;
      }
    }
    @media (max-width: 1100px) { .stats { grid-template-columns: repeat(4, 1fr); } }
    @media (max-width: 860px) { .top, .grid.two, .fleet-board, .stats, .filters { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 560px) { .top, .grid.two, .fleet-board, .stats, .filters { grid-template-columns: 1fr; } }
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
      <div class="stat"><b id="sum-available">0</b><span class="muted">可参与轮询</span></div>
      <div class="stat"><b id="sum-action">0</b><span class="muted">需处理</span></div>
      <div class="stat"><b id="sum-enabled">0</b><span class="muted">启用中</span></div>
      <div class="stat"><b id="sum-disabled">0</b><span class="muted">已停用</span></div>
      <div class="stat"><b id="sum-calls">0</b><span class="muted">真实 API 请求</span></div>
      <div class="stat"><b id="sum-successes">0</b><span class="muted">成功</span></div>
      <div class="stat"><b id="sum-errors">0</b><span class="muted">失败</span></div>
      <div class="stat"><b id="sum-success-rate">0%</b><span class="muted">真实成功率</span></div>
      <div class="stat"><b id="sum-avg">0ms</b><span class="muted">真实均耗时</span></div>
      <div class="stat"><b id="sum-health-checks">0</b><span class="muted">健康检测</span></div>
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
        <p class="muted" style="margin:0 0 14px">检测只更新账号可用性，不再计入真实 API 请求数。API 检测会使用下面的测试模型。</p>
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
          <p class="muted" style="margin:0">真实调用统计和健康检测状态已分开，账号多时优先看这里。</p>
        </div>
      </div>
      <div class="fleet-board">
        <div class="mini">
          <b id="fleet-health-title">0 / 0</b>
          <span class="muted">可用账号 / 总账号</span>
          <div class="bar"><i id="fleet-health-bar" style="width:0%"></i></div>
        </div>
        <div class="mini">
          <b>调用分布</b>
          <div id="traffic-rank" class="rank-list" style="margin-top:10px"></div>
        </div>
      </div>
      <div class="toolbar">
        <div class="filters">
          <input id="account-search" placeholder="搜索账号、ID 或 Base URL" />
          <select id="status-filter">
            <option value="all">全部状态</option>
            <option value="available">可参与轮询</option>
            <option value="attention">需处理</option>
            <option value="disabled">已停用</option>
          </select>
          <select id="sort-mode">
            <option value="attention">需处理优先</option>
            <option value="calls">请求数最多</option>
            <option value="recent">最近使用</option>
            <option value="label">名称排序</option>
          </select>
        </div>
        <div class="actions" style="margin-top:0">
          <label class="muted" style="display:flex;align-items:center;gap:8px">
            <input id="select-all" class="check" type="checkbox" />
            全选
          </label>
          <button class="secondary" id="test-all">全部检测</button>
          <button class="secondary" id="export-accounts">导出</button>
          <button class="secondary" id="import-accounts">导入</button>
          <button class="secondary" id="batch-enable">批量启用</button>
          <button class="secondary" id="batch-disable">批量停用</button>
          <button class="danger" id="reset-stats">清空统计</button>
        </div>
      </div>
      <div id="accounts"></div>
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
    const searchInput = document.getElementById("account-search");
    const statusFilterInput = document.getElementById("status-filter");
    const sortModeInput = document.getElementById("sort-mode");
    const selectedIds = new Set();
    let currentAccounts = [];
    tokenInput.value = localStorage.getItem("rt-router-token") || "";
    currentTokenInput.value = tokenInput.value;
    apiTestModelInput.value = localStorage.getItem("rt-router-api-test-model") || "gpt-4.1-mini";
    function setStatus(target, message, isError = false) {
      target.textContent = message || "";
      target.style.color = isError ? "#ff8f8f" : "#8b96b2";
      target.classList.remove("flash");
      if (message) requestAnimationFrame(() => target.classList.add("flash"));
    }
    function setBusy(id, busy) {
      const button = document.getElementById(id);
      if (!button) return;
      button.classList.toggle("busy", busy);
      button.disabled = busy;
    }
    function setMetric(id, value) {
      const element = document.getElementById(id);
      const next = String(value);
      if (!element) return;
      if (element.textContent !== next) {
        element.textContent = next;
        element.classList.remove("value-pop");
        requestAnimationFrame(() => element.classList.add("value-pop"));
      }
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char]));
    }
    function fmtNumber(value) {
      const n = Number(value || 0);
      if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
      if (n >= 1000) return (n / 1000).toFixed(1) + "K";
      return String(n);
    }
    function accountState(account) {
      if (!account.enabled) return "disabled";
      if ((account.unhealthyUntil || 0) > Date.now() || account.health?.lastOk === false) return "attention";
      return "available";
    }
    function stateTag(account) {
      const state = accountState(account);
      if (state === "disabled") return '<span class="tag off">已停用</span>';
      if (state === "attention") return '<span class="tag bad">需处理</span>';
      return '<span class="tag ok">可参与轮询</span>';
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
      setMetric("sum-total", summary.total || 0);
      setMetric("sum-available", summary.available || 0);
      setMetric("sum-action", summary.actionRequired || 0);
      setMetric("sum-enabled", summary.enabled || 0);
      setMetric("sum-disabled", summary.disabled || 0);
      setMetric("sum-calls", fmtNumber(summary.calls || 0));
      setMetric("sum-successes", fmtNumber(summary.successes || 0));
      setMetric("sum-errors", fmtNumber(summary.errors || 0));
      setMetric("sum-success-rate", String(summary.successRate || 0) + "%");
      setMetric("sum-avg", String(summary.avgDurationMs || 0) + "ms");
      setMetric("sum-health-checks", fmtNumber(summary.healthChecks || 0));
      const total = Number(summary.total || 0);
      const available = Number(summary.available || 0);
      setMetric("fleet-health-title", available + " / " + total);
      document.getElementById("fleet-health-bar").style.width = total > 0 ? Math.round((available / total) * 100) + "%" : "0%";
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
      const query = (searchInput.value || "").trim().toLowerCase();
      const filter = statusFilterInput.value;
      const sortMode = sortModeInput.value;
      const totalCalls = accounts.reduce((sum, account) => sum + (account.stats?.calls || 0), 0);
      const ranked = [...accounts]
        .filter((account) => (account.stats?.calls || 0) > 0)
        .sort((a, b) => (b.stats?.calls || 0) - (a.stats?.calls || 0))
        .slice(0, 5);
      document.getElementById("traffic-rank").innerHTML = ranked.length
        ? ranked.map((account) => {
            const calls = account.stats?.calls || 0;
            const pct = totalCalls > 0 ? Math.max(2, Math.round((calls / totalCalls) * 100)) : 0;
            return '<div class="rank-row" style="animation-delay:' + Math.min(240, 40 * pct) + 'ms"><div><div class="row" style="gap:8px"><span class="mono">' + escapeHtml(account.label) + '</span><span class="muted">' + calls + ' 次</span></div><div class="bar"><i style="width:' + pct + '%"></i></div></div><span class="muted">' + pct + '%</span></div>';
          }).join("")
        : '<span class="muted">暂无真实 API 调用。</span>';

      let visible = accounts.filter((account) => {
        const text = [account.id, account.label, account.baseUrl].join(" ").toLowerCase();
        if (query && !text.includes(query)) return false;
        if (filter !== "all" && accountState(account) !== filter) return false;
        return true;
      });
      visible = visible.sort((a, b) => {
        if (sortMode === "calls") return (b.stats?.calls || 0) - (a.stats?.calls || 0);
        if (sortMode === "recent") return (b.stats?.lastUsedAt || 0) - (a.stats?.lastUsedAt || 0);
        if (sortMode === "label") return String(a.label).localeCompare(String(b.label));
        const score = (account) => accountState(account) === "attention" ? 0 : accountState(account) === "available" ? 1 : 2;
        return score(a) - score(b);
      });
      if (!accounts.length) {
        listEl.innerHTML = '<div class="list-empty">暂无账号。</div>';
        syncSelectAll();
        return;
      }
      if (!visible.length) {
        listEl.innerHTML = '<div class="list-empty">没有符合筛选条件的账号。</div>';
        syncSelectAll();
        return;
      }
      listEl.innerHTML = '<div class="table-wrap"><table><thead><tr><th></th><th>账号</th><th>健康状态</th><th>真实 API 调用</th><th>检测</th><th>最近活动</th><th></th></tr></thead><tbody>' + visible.map((account) => {
        const headers = Object.keys(account.extraHeaders || {});
        const checked = selectedIds.has(account.id) ? "checked" : "";
        const lastUsed = account.stats?.lastUsedAt ? new Date(account.stats.lastUsedAt).toLocaleString() : "暂无真实调用";
        const lastCheck = account.health?.lastCheckedAt ? new Date(account.health.lastCheckedAt).toLocaleString() : "未检测";
        const successRate = account.stats?.calls ? Math.round(((account.stats.successes || 0) / account.stats.calls) * 100) + "%" : "--";
        const state = accountState(account);
        return '<tr class="row-' + state + '" style="animation-delay:' + Math.min(240, 24 * visible.indexOf(account)) + 'ms">' +
          '<td><input class="check" type="checkbox" data-account-check="' + escapeHtml(account.id) + '" ' + checked + ' /></td>' +
          '<td><div class="node-title"><b>' + escapeHtml(account.label) + '</b><span class="muted mono">' + escapeHtml(account.id) + '</span><span class="muted mono node-url" title="' + escapeHtml(account.baseUrl) + '">' + escapeHtml(account.baseUrl) + '</span></div></td>' +
          '<td><div class="meta" style="margin-top:0">' + stateTag(account) + '<span class="tag">' + (headers.length ? "额外请求头 " + headers.length : "无额外请求头") + '</span>' + (account.health?.lastStatus ? '<span class="tag">检测状态 ' + account.health.lastStatus + '</span>' : '') + '</div>' + (account.health?.lastError ? '<div class="muted" style="margin-top:8px;color:#ff8f8f">' + escapeHtml(account.health.lastError).slice(0, 120) + '</div>' : '') + '</td>' +
          '<td><div class="mono">' + (account.stats?.calls || 0) + ' 次</div><div class="muted">成功 ' + (account.stats?.successes || 0) + ' / 失败 ' + (account.stats?.errors || 0) + ' / ' + successRate + '</div><div class="muted">均耗时 ' + (account.stats?.avgDurationMs || 0) + 'ms</div></td>' +
          '<td><div class="mono">' + (account.health?.checks || 0) + ' 次</div><div class="muted">' + lastCheck + '</div></td>' +
          '<td><div class="muted">' + lastUsed + '</div></td>' +
          '<td><div class="inline-actions"><button class="secondary" onclick="editAccount(\\'' + escapeHtml(account.id) + '\\')">编辑</button><button class="secondary" onclick="testAccount(\\'' + escapeHtml(account.id) + '\\')">可用检测</button><button class="secondary" onclick="toggleAccount(\\'' + escapeHtml(account.id) + '\\', ' + (!account.enabled) + ')">' + (account.enabled ? "停用" : "启用") + '</button><button class="danger" onclick="removeAccount(\\'' + escapeHtml(account.id) + '\\')">删除</button></div></td>' +
          '</tr>';
      }).join("") + '</tbody></table></div>';
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
        setBusy("reload", true);
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
      } finally {
        setBusy("reload", false);
      }
    }
    async function addAccount() {
      try {
        setBusy("add-account", true);
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
      } finally {
        setBusy("add-account", false);
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
        setStatus(statusEl, "正在做可用性检测...");
        const data = await api("/admin/accounts/" + encodeURIComponent(id) + "/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "chat", model: getApiTestModel() }),
        });
        setStatus(statusEl, "可用性检测成功：" + (data.message || "可用"));
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
        setBusy("test-all", true);
        setStatus(metaStatusEl, "正在自动检测账号存活...");
        const data = await api("/admin/accounts/test-all", { method: "POST" });
        setStatus(metaStatusEl, "自动检测完成：" + (data.okCount || 0) + "/" + (data.total || 0) + " 可用。");
        await loadAccounts();
      } catch (error) {
        setStatus(metaStatusEl, error.message, true);
      } finally {
        setBusy("test-all", false);
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
    async function resetStats() {
      if (!confirm("确认清空真实 API 调用统计？账号和健康检测记录会保留。")) return;
      try {
        await api("/admin/stats/reset", { method: "POST" });
        setStatus(statusEl, "真实 API 调用统计已清空。");
        await loadAccounts();
      } catch (error) {
        setStatus(statusEl, error.message, true);
      }
    }
    window.toggleAccount = toggleAccount;
    window.testAccount = testAccount;
    window.editAccount = editAccount;
    window.removeAccount = removeAccount;
    document.getElementById("gate-submit").addEventListener("click", verify);
    document.getElementById("add-account").addEventListener("click", addAccount);
    document.getElementById("reload").addEventListener("click", loadAccounts);
    document.getElementById("clear-form").addEventListener("click", clearForm);
    document.getElementById("test-all").addEventListener("click", probeAllAccounts);
    document.getElementById("export-accounts").addEventListener("click", exportAccounts);
    document.getElementById("import-accounts").addEventListener("click", importAccounts);
    document.getElementById("batch-enable").addEventListener("click", () => batchToggle(true));
    document.getElementById("batch-disable").addEventListener("click", () => batchToggle(false));
    document.getElementById("reset-stats").addEventListener("click", resetStats);
    apiTestModelInput.addEventListener("change", () => {
      localStorage.setItem("rt-router-api-test-model", getApiTestModel());
    });
    searchInput.addEventListener("input", () => renderAccounts(currentAccounts));
    statusFilterInput.addEventListener("change", () => renderAccounts(currentAccounts));
    sortModeInput.addEventListener("change", () => renderAccounts(currentAccounts));
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
  private healthCache: Record<string, AccountHealth> | null = null;

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

  private async getHealthMap(): Promise<Record<string, AccountHealth>> {
    if (this.healthCache) return this.healthCache;
    const saved = await this.ctx.storage.get<Record<string, AccountHealth>>(HEALTH_KEY);
    this.healthCache = saved && typeof saved === "object" ? saved : {};
    return this.healthCache;
  }

  private async saveHealthMap(healthMap: Record<string, AccountHealth>): Promise<void> {
    this.healthCache = healthMap;
    await this.ctx.storage.put(HEALTH_KEY, healthMap);
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

  private async recordHealthResult(
    id: string,
    ok: boolean,
    status: number | null,
    mode: "health" | "chat",
    errorMessage?: string,
  ): Promise<void> {
    const healthMap = await this.getHealthMap();
    const current = healthMap[id] ?? createEmptyHealth();
    current.checks += 1;
    current.lastOk = ok;
    current.lastStatus = status;
    current.lastCheckedAt = Date.now();
    current.mode = mode;
    if (ok) {
      current.lastError = null;
    } else {
      current.failures += 1;
      current.lastError = errorMessage ?? (status ? `HTTP ${status}` : "Health check failed");
    }
    healthMap[id] = current;
    await this.saveHealthMap(healthMap);
  }

  private async getAccountsWithStats(): Promise<PublicAccount[]> {
    const [accounts, statsMap, healthMap] = await Promise.all([
      this.getAccounts(),
      this.getStatsMap(),
      this.getHealthMap(),
    ]);
    return accounts.map((account) => toPublicAccount(
      account,
      statsMap[account.id] ?? createEmptyStat(),
      healthMap[account.id] ?? createEmptyHealth(),
    ));
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
        await this.recordHealthResult(account.id, false, response.status, "health", `HTTP ${response.status}`);
        return { ok: false, status: response.status, message: `HTTP ${response.status}` };
      }
      await this.markHealthy(account.id);
      await this.recordHealthResult(account.id, true, response.status, "health");
      return { ok: true, status: response.status, message: "模型列表可用" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markUnhealthy(account.id);
      await this.recordHealthResult(account.id, false, null, "health", message);
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
        await this.recordHealthResult(account.id, false, response.status, "chat", text || `HTTP ${response.status}`);
        return { ok: false, status: response.status, message: text || `HTTP ${response.status}` };
      }
      await this.markHealthy(account.id);
      await this.recordHealthResult(account.id, true, response.status, "chat");
      return { ok: true, status: response.status, message: `模型 ${model} 可用` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markUnhealthy(account.id);
      await this.recordHealthResult(account.id, false, null, "chat", message);
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
      const [accounts, statsMap, healthMap] = await Promise.all([
        this.getAccounts(),
        this.getStatsMap(),
        this.getHealthMap(),
      ]);
      return json({ ok: true, summary: summarizeAccounts(accounts, statsMap, healthMap) });
    }

    if (pathname === "/admin/accounts" && request.method === "GET") {
      const [accounts, statsMap, healthMap, records] = await Promise.all([
        this.getAccounts(),
        this.getStatsMap(),
        this.getHealthMap(),
        this.getAccountsWithStats(),
      ]);
      return json({ accounts: records, summary: summarizeAccounts(accounts, statsMap, healthMap) });
    }

    if (pathname === "/admin/accounts" && request.method === "POST") {
      const payload = sanitizeAccountInput(await readJsonBody<AccountInput>(request), this.env.AUTH_TOKEN);
      const accounts = await this.getAccounts();
      const next = accounts.filter((item) => item.id !== payload.id);
      next.push(payload);
      await this.saveAccounts(next);
      const [statsMap, healthMap] = await Promise.all([this.getStatsMap(), this.getHealthMap()]);
      return json({
        ok: true,
        account: toPublicAccount(
          payload,
          statsMap[payload.id] ?? createEmptyStat(),
          healthMap[payload.id] ?? createEmptyHealth(),
        ),
      }, { status: 201 });
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

    if (pathname === "/admin/stats/reset" && request.method === "POST") {
      await this.saveStatsMap({});
      return json({ ok: true });
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
      const [statsMap, healthMap] = await Promise.all([this.getStatsMap(), this.getHealthMap()]);
      return json({
        account: toPublicAccount(
          target,
          statsMap[target.id] ?? createEmptyStat(),
          healthMap[target.id] ?? createEmptyHealth(),
        ),
      });
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
      const healthMap = await this.getHealthMap();
      delete healthMap[accountId];
      await this.saveHealthMap(healthMap);
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
      const [statsMap, healthMap] = await Promise.all([this.getStatsMap(), this.getHealthMap()]);
      return json({
        ok: true,
        account: toPublicAccount(
          target,
          statsMap[target.id] ?? createEmptyStat(),
          healthMap[target.id] ?? createEmptyHealth(),
        ),
      });
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
