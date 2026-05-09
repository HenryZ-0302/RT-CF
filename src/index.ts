import { DurableObject } from "cloudflare:workers";

export interface Env {
  AUTH_TOKEN: string;
  ACCOUNT_COOLDOWN_MS?: string;
  MAX_RETRY_ACCOUNTS?: string;
  ROUTER_STATE: DurableObjectNamespace;
}

type AccountRecord = {
  id: string;
  projectId: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  weight?: number;
  extraHeaders?: Record<string, string>;
  unhealthyUntil?: number;
};

type AccountInput = {
  id?: string;
  projectId?: string;
  label?: string;
  baseUrl: string;
  apiKey?: string;
  enabled?: boolean;
  weight?: number;
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
  projectId: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  weight: number;
  extraHeaders: Record<string, string>;
  unhealthyUntil: number;
  stats: AccountStat;
  health: AccountHealth;
};

type ProjectRecord = {
  id: string;
  name: string;
  enabled: boolean;
  apiKeys: string[];
  createdAt: number;
  updatedAt: number;
};

type ProjectInput = {
  id?: string;
  name?: string;
  enabled?: boolean;
};

type PublicProject = {
  id: string;
  name: string;
  enabled: boolean;
  apiKeys: string[];
  keyCount: number;
  accountCount: number;
  createdAt: number;
  updatedAt: number;
};

type RoutingSettings = {
  maxRetryAccounts: number;
  disableOnFailure: boolean;
};

type ModelSettings = {
  models: string[];
};

type ModelHourlyBucket = {
  calls: number;
  successes: number;
  errors: number;
  avgDurationMs: number;
  totalDurationMs: number;
  lastStatus: number | null;
};

type ModelHourlyStats = Record<string, Record<string, ModelHourlyBucket>>;

const ACCOUNTS_KEY = "accounts";
const CURSOR_KEY = "cursor";
const STATS_KEY = "stats";
const HEALTH_KEY = "health";
const ROUTING_KEY = "routing";
const MODELS_KEY = "models";
const MODEL_HOURLY_KEY = "model_hourly";
const PROJECTS_KEY = "projects";
const DEFAULT_PROJECT_ID = "default-rt";
const DEFAULT_PROJECT_NAME = "RT 默认项目";

function normalizeWeight(value: unknown): number {
  const weight = Number(value ?? 1);
  if (!Number.isFinite(weight)) return 1;
  return Math.max(1, Math.min(20, Math.round(weight)));
}

function createDefaultRouting(maxRetryAccounts?: string): RoutingSettings {
  const parsed = Number(maxRetryAccounts || 3);
  return {
    maxRetryAccounts: Number.isFinite(parsed) ? Math.max(1, Math.min(20, Math.round(parsed))) : 3,
    disableOnFailure: true,
  };
}

function normalizeModelList(value: unknown): string[] {
  const incoming = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]+/)
      : [];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of incoming) {
    const model = String(item ?? "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models.slice(0, 100);
}

function createEmptyModelBucket(): ModelHourlyBucket {
  return {
    calls: 0,
    successes: 0,
    errors: 0,
    avgDurationMs: 0,
    totalDurationMs: 0,
    lastStatus: null,
  };
}

function hourKey(timestamp = Date.now()): string {
  return new Date(Math.floor(timestamp / 3600000) * 3600000).toISOString();
}

function lastHourKeys(count = 24): string[] {
  const current = Math.floor(Date.now() / 3600000) * 3600000;
  return Array.from({ length: count }, (_, index) => new Date(current - (count - 1 - index) * 3600000).toISOString());
}

function isAccountFailureStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

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

function jsString(value: unknown): string {
  return JSON.stringify(String(value ?? "")).replace(/</g, "\\u003c");
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
  return `acc-${Math.floor(100000000 + Math.random() * 900000000)}`;
}

function generateProjectId(): string {
  return `proj-${Math.floor(100000000 + Math.random() * 900000000)}`;
}

function generateProjectApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `hy_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sanitizeProjectInput(payload: ProjectInput, existing?: ProjectRecord): ProjectRecord {
  const now = Date.now();
  const id = payload.id?.trim() || existing?.id || generateProjectId();
  return {
    id,
    name: payload.name?.trim() || existing?.name || id,
    enabled: payload.enabled ?? existing?.enabled ?? true,
    apiKeys: existing?.apiKeys ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function createDefaultProject(existing?: Partial<ProjectRecord>): ProjectRecord {
  const now = Date.now();
  return {
    id: DEFAULT_PROJECT_ID,
    name: existing?.name?.trim() || DEFAULT_PROJECT_NAME,
    enabled: existing?.enabled ?? true,
    apiKeys: Array.isArray(existing?.apiKeys) ? existing.apiKeys : [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  };
}

function toPublicProject(project: ProjectRecord, accountCount = 0): PublicProject {
  return {
    id: project.id,
    name: project.name,
    enabled: project.enabled,
    apiKeys: project.apiKeys,
    keyCount: project.apiKeys.length,
    accountCount,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function sanitizeAccountInput(payload: AccountInput, projectId = DEFAULT_PROJECT_ID, existing?: AccountRecord): AccountRecord {
  const resolvedId = payload.id?.trim() || generateAccountId();
  if (!payload.baseUrl?.trim()) throw new Error("Account baseUrl is required");
  const resolvedApiKey = payload.apiKey?.trim() || existing?.apiKey || "";
  if (!resolvedApiKey) throw new Error("Account apiKey is required");
  return {
    id: resolvedId,
    projectId: payload.projectId?.trim() || existing?.projectId || projectId,
    label: payload.label?.trim() || resolvedId,
    baseUrl: normalizeBaseUrl(payload.baseUrl),
    apiKey: resolvedApiKey,
    enabled: payload.enabled !== false,
    weight: normalizeWeight(payload.weight),
    extraHeaders: payload.extraHeaders,
    unhealthyUntil: 0,
  };
}

function toPublicAccount(account: AccountRecord, stats: AccountStat, health: AccountHealth): PublicAccount {
  return {
    id: account.id,
    projectId: account.projectId || DEFAULT_PROJECT_ID,
    label: account.label,
    baseUrl: account.baseUrl,
    enabled: account.enabled,
    weight: normalizeWeight(account.weight),
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

function renderMonitorPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HYHub Status</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f5f7fa;
      --panel: #ffffff;
      --panel-soft: #f1f5f9;
      --text: #172033;
      --muted: #64748b;
      --line: rgba(23, 32, 51, 0.12);
      --ok: #0f9f6e;
      --warn: #b7791f;
      --bad: #d64545;
      --accent: #2563eb;
      --shadow: 0 18px 46px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .wrap { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 72px; }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      margin-bottom: 14px;
      padding: 0 2px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      font-weight: 800;
      letter-spacing: 0;
    }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      color: #fff;
      background: var(--accent);
      box-shadow: 0 10px 22px rgba(37, 99, 235, 0.18);
    }
    .admin-link {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: var(--panel);
      text-decoration: none;
      box-shadow: var(--shadow);
    }
    .masthead {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 210px;
      gap: 14px;
      align-items: stretch;
      margin-bottom: 16px;
    }
    .hero, .status-tile, .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .hero { padding: clamp(20px, 3vw, 30px); display: grid; gap: 12px; }
    .eyebrow { color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
    h1 { margin: 0; max-width: 760px; font-size: clamp(32px, 5vw, 54px); line-height: 1; letter-spacing: 0; text-wrap: pretty; }
    p { margin: 0; color: var(--muted); line-height: 1.55; text-wrap: pretty; }
    .status-line { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; margin-top: 4px; padding-left: 2px; }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      background: var(--muted);
      box-shadow: 0 0 0 7px rgba(109, 117, 128, 0.13);
      position: relative;
    }
    .dot::after {
      content: "";
      position: absolute;
      inset: -8px;
      border-radius: inherit;
      border: 1px solid currentColor;
      opacity: 0;
      transform: scale(0.72);
    }
    .dot.ok { color: var(--ok); background: var(--ok); box-shadow: 0 0 0 7px rgba(15, 159, 110, 0.13), 0 0 28px rgba(15, 159, 110, 0.20); animation: breatheOk 2.4s ease-in-out infinite; }
    .dot.ok::after { animation: ripple 2.4s ease-out infinite; }
    .dot.warn { color: var(--warn); background: var(--warn); box-shadow: 0 0 0 7px rgba(182, 107, 24, 0.14); animation: breatheWarn 2.8s ease-in-out infinite; }
    .dot.warn::after { animation: ripple 2.8s ease-out infinite; }
    .dot.bad { color: var(--bad); background: var(--bad); box-shadow: 0 0 0 7px rgba(200, 76, 76, 0.14); animation: breatheBad 1.8s ease-in-out infinite; }
    .dot.bad::after { animation: ripple 1.8s ease-out infinite; }
    .status-tile { padding: 0; display: grid; grid-template-rows: 1fr 1fr; min-height: 148px; overflow: hidden; }
    .status-part { padding: 14px; display: flex; align-items: center; }
    .status-part + .status-part { border-top: 1px solid var(--line); }
    .status-tile b { display: block; color: var(--text); font-size: 26px; line-height: 1; margin-bottom: 6px; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 12px 0; }
    .card {
      padding: 14px;
      animation: rise 420ms ease-out both;
    }
    .card b { display: block; font-size: clamp(24px, 3vw, 32px); line-height: 1; margin-bottom: 6px; }
    .card span { color: var(--muted); font-size: 13px; }
    .bar { height: 9px; border-radius: 999px; overflow: hidden; background: var(--panel-soft); margin-top: 12px; }
    .bar i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, var(--accent), var(--ok)); transition: width 520ms ease; }
    .footer { color: var(--muted); font-size: 13px; margin-top: 18px; }
    .model-panel { margin-top: 12px; padding: 0; overflow: hidden; }
    .model-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
      gap: 12px;
      align-items: end;
      padding: 18px;
      border-bottom: 1px solid var(--line);
    }
    .model-panel h2 { margin: 0 0 6px; font-size: 20px; letter-spacing: 0; }
    .model-tools { display: grid; gap: 8px; }
    .model-search {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text);
      background: var(--panel);
      font: inherit;
    }
    .model-tabs { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 18px; border-bottom: 1px solid var(--line); }
    .model-tab {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 11px;
      color: var(--muted);
      background: var(--panel);
      cursor: pointer;
      font: inherit;
      box-shadow: none;
    }
    .model-tab.active { color: var(--accent); border-color: rgba(37, 99, 235, 0.36); background: rgba(37, 99, 235, 0.08); }
    .model-table-wrap { overflow-x: auto; overflow-y: visible; }
    .model-table { display: grid; min-width: 860px; }
    .model-row {
      display: grid;
      grid-template-columns: minmax(150px, 1.1fr) minmax(90px, 0.55fr) minmax(72px, 0.45fr) minmax(312px, 1.5fr) minmax(86px, 0.45fr);
      gap: 12px;
      align-items: center;
      padding: 12px 18px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .model-row.head { color: var(--muted); font-size: 12px; font-weight: 700; background: var(--panel-soft); }
    .model-row:last-child { border-bottom: 0; }
    .model-name { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .model-provider, .model-latency { color: var(--muted); }
    .hour-strip {
      display: grid;
      grid-template-columns: repeat(24, 18px);
      gap: 5px;
      align-items: center;
      width: max-content;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 2px 0 8px;
      position: relative;
      scrollbar-width: thin;
      touch-action: pan-x;
      -webkit-overflow-scrolling: touch;
    }
    .hour-strip::-webkit-scrollbar { height: 5px; }
    .hour-strip::-webkit-scrollbar-thumb { background: rgba(109, 117, 128, 0.28); border-radius: 999px; }
    .hour-cell {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      background: rgba(100, 116, 139, 0.16);
      border: 1px solid rgba(100, 116, 139, 0.14);
      cursor: help;
      position: relative;
      flex: 0 0 auto;
    }
    .hour-cell.good { background: rgba(15, 159, 110, 0.72); border-color: rgba(15, 159, 110, 0.42); }
    .hour-cell.warn { background: rgba(183, 121, 31, 0.62); border-color: rgba(183, 121, 31, 0.38); }
    .hour-cell.bad { background: rgba(214, 69, 69, 0.70); border-color: rgba(214, 69, 69, 0.42); }
    .model-badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 5px 9px;
      border: 1px solid rgba(15, 159, 110, 0.22);
      border-radius: 999px;
      color: var(--ok);
      background: rgba(15, 159, 110, 0.08);
      white-space: nowrap;
    }
    .model-badge::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: currentColor;
      box-shadow: 0 0 0 4px rgba(15, 159, 110, 0.10);
    }
    .model-empty { padding: 20px 18px; color: var(--muted); }
    .metric-mini { color: var(--muted); font-size: 12px; margin-top: 8px; display: flex; gap: 10px; flex-wrap: wrap; }
    .hour-tooltip {
      position: fixed;
      z-index: 20;
      min-width: 190px;
      max-width: min(280px, calc(100vw - 24px));
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: var(--panel);
      box-shadow: 0 18px 44px rgba(15, 23, 42, 0.16);
      pointer-events: none;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 140ms ease, transform 140ms ease;
      font-size: 12px;
      line-height: 1.6;
    }
    .hour-tooltip.show { opacity: 1; transform: translateY(0); }
    .hour-tooltip b { display: block; font-size: 13px; margin-bottom: 4px; }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes ripple { 0% { opacity: 0.4; transform: scale(0.7); } 70%, 100% { opacity: 0; transform: scale(1.9); } }
    @keyframes breatheOk { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.18); } }
    @keyframes breatheWarn { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.14); } }
    @keyframes breatheBad { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.2); } }
    @media (prefers-reduced-motion: reduce) {
      .card, .dot, .dot::after { animation: none !important; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --panel: #111c2f;
        --panel-soft: #16243a;
        --text: #e5edf8;
        --muted: #94a3b8;
        --line: rgba(226, 232, 240, 0.12);
        --shadow: 0 18px 46px rgba(0, 0, 0, 0.28);
      }
      body { background: var(--bg); }
    }
    @media (max-width: 820px) { .masthead { grid-template-columns: 1fr; } .grid { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 640px) { .model-head { grid-template-columns: 1fr; } }
    @media (max-width: 760px) {
      .model-table-wrap { overflow-x: auto; }
      .model-table { min-width: 0; }
      .model-row { grid-template-columns: 1fr; gap: 8px; }
      .model-row.head { display: none; }
      .hour-strip { grid-template-columns: repeat(24, 22px); width: 100%; max-width: 100%; }
      .hour-cell { width: 22px; height: 22px; }
    }
    @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="topbar">
      <div class="brand"><span class="brand-mark">H</span><span>HYHub</span></div>
      <a class="admin-link" href="/admin">管理后台</a>
    </div>
    <section class="masthead">
      <div class="hero">
        <span class="eyebrow">Public service board</span>
        <h1>HYHub Status</h1>
        <p>面向外部的 API Hub 健康监控页，展示账号池可用性、真实调用和模型健康。</p>
        <div class="status-line">
          <i id="state-dot" class="dot"></i>
          <strong id="state-text">正在读取状态...</strong>
        </div>
      </div>
      <aside class="status-tile">
        <div class="status-part"><p><b>15s</b>自动刷新</p></div>
        <div class="status-part">
          <p><b id="success-rate">0%</b>调用成功率</p>
        </div>
      </aside>
    </section>
    <section class="grid">
      <div class="card"><b id="available">0</b><span>可用账号</span></div>
      <div class="card"><b id="calls">0</b><span>调用次数</span></div>
      <div class="card"><b id="successes">0</b><span>成功次数</span></div>
      <div class="card"><b id="errors">0</b><span>失败次数</span></div>
    </section>
    <section class="card model-panel">
      <div class="model-head">
        <div>
          <h2>模型健康度</h2>
          <p id="model-summary">正在读取模型列表...</p>
        </div>
        <div class="model-tools">
          <input id="model-search" class="model-search" placeholder="搜索模型" />
        </div>
      </div>
      <div id="model-tabs" class="model-tabs"></div>
      <div id="model-list" class="model-table-wrap"><div class="model-empty">正在读取模型列表...</div></div>
    </section>
  </main>
  <div id="hour-tooltip" class="hour-tooltip"></div>
  <script>
    function fmt(value) {
      const n = Number(value || 0);
      if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
      if (n >= 1000) return (n / 1000).toFixed(1) + "K";
      return String(n);
    }
    function setText(id, value) {
      document.getElementById(id).textContent = value;
    }
    let publicModels = [];
    let activeFamily = "all";
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    function modelName(model) {
      return typeof model === "string" ? model : String(model?.model || "");
    }
    function modelFamily(model) {
      const name = modelName(model).toLowerCase();
      if (name.includes("claude")) return "Anthropic";
      if (name.includes("gemini") || name.includes("gemma")) return "Gemini";
      if (name.includes("deepseek")) return "DeepSeek";
      if (name.includes("qwen")) return "Qwen";
      if (name.includes("gpt") || name.includes("dall-e") || name.includes("whisper") || name.includes("tts")) return "OpenAI";
      if (name.includes("grok")) return "xAI";
      if (name.includes("llama")) return "Llama";
      if (name.includes("mistral") || name.includes("codestral")) return "Mistral";
      if (name.includes("doubao")) return "Doubao";
      return "Model";
    }
    function modelEndpoint(model) {
      const name = modelName(model).toLowerCase();
      if (name.includes("embedding") || name.includes("embed")) return "/v1/embeddings";
      if (name.includes("whisper") || name.includes("transcrib")) return "/v1/audio";
      if (name.includes("tts") || name.includes("speech")) return "/v1/audio/speech";
      if (name.includes("dall-e") || name.includes("image") || name.includes("imagen")) return "/v1/images";
      return "/v1/chat/completions";
    }
    function hourClass(bucket) {
      if (!bucket || !bucket.calls) return "";
      const rate = bucket.successRate ?? (bucket.successes && bucket.calls ? Math.round((bucket.successes / bucket.calls) * 100) : 0);
      if (rate >= 95) return "good";
      if (rate >= 60) return "warn";
      return "bad";
    }
    function renderHours(model) {
      const buckets = Array.isArray(model?.hours) ? model.hours : [];
      return '<div class="hour-block"><div class="hour-strip" aria-label="最近 24 小时调用状态">' + buckets.map((bucket) => {
        const time = new Date(bucket.hour).toLocaleString(undefined, {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const detail = bucket?.calls
          ? time + "｜调用 " + bucket.calls + "｜成功 " + bucket.successes + "｜失败 " + bucket.errors + "｜成功率 " + bucket.successRate + "%｜延迟 " + (bucket.avgDurationMs || 0) + "ms"
          : time + "｜暂无调用";
        return '<i class="hour-cell ' + hourClass(bucket) + '" data-hour-detail="' + escapeHtml(detail) + '"></i>';
      }).join("") + '</div></div>';
    }
    function scrollHourStripsToLatest() {
      requestAnimationFrame(() => {
        document.querySelectorAll(".hour-strip").forEach((strip) => {
          strip.scrollLeft = strip.scrollWidth;
        });
      });
    }
    function renderTabs(models) {
      const tabs = document.getElementById("model-tabs");
      const counts = new Map([["all", models.length]]);
      for (const model of models) {
        const family = modelFamily(model);
        counts.set(family, (counts.get(family) || 0) + 1);
      }
      const ordered = ["all", ...[...counts.keys()].filter((item) => item !== "all").sort((a, b) => a.localeCompare(b))];
      tabs.innerHTML = ordered.map((family) => {
        const label = family === "all" ? "全部模型" : family;
        const active = family === activeFamily ? " active" : "";
        return '<button class="model-tab' + active + '" data-model-family="' + escapeHtml(family) + '">' + escapeHtml(label) + ' · ' + (counts.get(family) || 0) + '</button>';
      }).join("");
    }
    function renderModels(models) {
      publicModels = Array.isArray(models) ? models : [];
      const list = document.getElementById("model-list");
      const query = (document.getElementById("model-search").value || "").trim().toLowerCase();
      renderTabs(publicModels);
      const items = publicModels.filter((model) => {
        const family = modelFamily(model);
        if (activeFamily !== "all" && family !== activeFamily) return false;
        return !query || modelName(model).toLowerCase().includes(query) || family.toLowerCase().includes(query);
      });
      document.getElementById("model-summary").textContent = publicModels.length
        ? "共 " + publicModels.length + " 个模型，当前显示 " + items.length + " 个。"
        : "暂未配置开放模型。";
      list.innerHTML = items.length
        ? '<div class="model-table"><div class="model-row head"><span>模型名称</span><span>供应商</span><span>状态</span><span>最近 24 小时</span><span>延迟</span></div>' +
          items.map((model) => '<div class="model-row">' +
            '<div><div class="model-name" title="' + escapeHtml(modelName(model)) + '">' + escapeHtml(modelName(model)) + '</div><div class="metric-mini"><span>' + escapeHtml(modelEndpoint(model)) + '</span></div></div>' +
            '<div class="model-provider">' + escapeHtml(modelFamily(model)) + '</div>' +
            '<div><span class="model-badge">可用</span></div>' +
            '<div>' + renderHours(model) + '</div>' +
            '<div class="model-latency">' + escapeHtml(model.avgDurationMs ? model.avgDurationMs + "ms" : "暂无") + '</div>' +
          '</div>').join("") + '</div>'
        : '<div class="model-empty">暂未配置开放模型。</div>';
      scrollHourStripsToLatest();
    }
    document.addEventListener("input", (event) => {
      if (event.target?.id === "model-search") renderModels(publicModels);
    });
    document.addEventListener("click", (event) => {
      const family = event.target?.getAttribute?.("data-model-family");
      if (!family) return;
      activeFamily = family;
      renderModels(publicModels);
    });
    function showHourTooltip(target) {
      const detail = target?.getAttribute?.("data-hour-detail");
      if (!detail) return;
      const tooltip = document.getElementById("hour-tooltip");
      const parts = detail.split("｜");
      tooltip.innerHTML = '<b>' + escapeHtml(parts[0] || "") + '</b>' + parts.slice(1).map((item) => '<div>' + escapeHtml(item) + '</div>').join("");
      tooltip.style.left = "12px";
      tooltip.style.top = "12px";
      tooltip.classList.add("show");
      const rect = target.getBoundingClientRect();
      const rowRect = target.closest(".model-row")?.getBoundingClientRect() || rect;
      const tipRect = tooltip.getBoundingClientRect();
      const left = Math.min(window.innerWidth - tipRect.width - 12, Math.max(12, rect.left + rect.width / 2 - tipRect.width / 2));
      const below = rowRect.bottom + 10;
      const above = rowRect.top - tipRect.height - 10;
      const top = below + tipRect.height <= window.innerHeight - 12 ? below : Math.max(12, above);
      tooltip.style.left = left + "px";
      tooltip.style.top = top + "px";
    }
    function hideHourTooltip() {
      document.getElementById("hour-tooltip").classList.remove("show");
    }
    document.addEventListener("pointerover", (event) => {
      if (event.target?.matches?.("[data-hour-detail]")) showHourTooltip(event.target);
    });
    document.addEventListener("pointerout", (event) => {
      if (event.target?.matches?.("[data-hour-detail]")) hideHourTooltip();
    });
    document.addEventListener("pointerdown", (event) => {
      if (event.target?.matches?.("[data-hour-detail]")) showHourTooltip(event.target);
    });
    async function loadStatus() {
      try {
        const response = await fetch("/public/status", { cache: "no-store" });
        const data = await response.json();
        const summary = data.summary || {};
        const dot = document.getElementById("state-dot");
        dot.className = "dot " + data.state;
        setText("state-text", data.message || "状态未知");
        setText("available", summary.available || 0);
        setText("calls", fmt(summary.calls || 0));
        setText("successes", fmt(summary.successes || 0));
        setText("errors", fmt(summary.errors || 0));
        setText("success-rate", String(summary.successRate || 0) + "%");
        renderModels(data.modelHealth || (data.models || []).map((model) => ({ model, hours: [] })));
      } catch {
        document.getElementById("state-dot").className = "dot bad";
        setText("state-text", "健康状态读取失败");
      }
    }
    loadStatus();
    window.setInterval(loadStatus, 15000);
  </script>
</body>
</html>`;
}

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HYHub</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f2eee6;
      --surface: #fffaf1;
      --surface-2: #f8f2e8;
      --surface-3: #ece6dc;
      --muted: #6f746f;
      --line: rgba(28, 35, 43, 0.13);
      --text: #1d252c;
      --accent: #295fc8;
      --accent-2: #14866d;
      --danger: #c94f4f;
      --warn: #b07123;
      --panel: rgba(255, 250, 241, 0.9);
      --panel-soft: rgba(248, 242, 232, 0.78);
      --shadow: 0 18px 48px rgba(55, 64, 76, 0.12);
      --motion-fast: 150ms;
      --motion-med: 280ms;
      --motion-slow: 520ms;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(180deg, rgba(255, 250, 241, 0.94), rgba(242, 238, 230, 0.98)),
        repeating-linear-gradient(90deg, rgba(29, 37, 44, 0.032) 0 1px, transparent 1px 96px);
      background-attachment: fixed;
      color: var(--text);
    }
    .hidden { display: none !important; }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 26px 20px 80px; animation: pageIn var(--motion-slow) ease-out both; }
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
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
      transform: translateZ(0);
      transition: border-color var(--motion-med) ease, box-shadow var(--motion-med) ease, transform var(--motion-med) ease;
    }
    .gate-card { animation: panelIn var(--motion-slow) ease-out both; }
    .card:hover, .gate-card:hover {
      border-color: rgba(41, 95, 200, 0.34);
      box-shadow: 0 24px 64px rgba(55, 64, 76, 0.16);
    }
    .gate-card { width: 100%; max-width: 460px; padding: 28px; }
    .gate-card h1, .header h1 { margin: 0 0 8px; font-size: clamp(28px, 4vw, 42px); line-height: 1; letter-spacing: 0; }
    .gate-card p, .muted { color: var(--muted); line-height: 1.6; text-wrap: pretty; }
    .field, .grid { display: grid; gap: 10px; }
    .grid.two { grid-template-columns: 1fr 1fr; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--text);
      border-radius: 8px;
      padding: 12px 14px;
      font: inherit;
      transition: border-color var(--motion-fast) ease, box-shadow var(--motion-fast) ease, background var(--motion-fast) ease;
    }
    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: rgba(41, 95, 200, 0.65);
      box-shadow: 0 0 0 3px rgba(41, 95, 200, 0.14);
      background: #ffffff;
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
    button:hover { transform: translateY(-1px); box-shadow: 0 10px 22px rgba(55, 64, 76, 0.18); filter: brightness(1.03); }
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
    button.secondary { background: #394557; }
    button.danger { background: var(--danger); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 16px;
      margin-bottom: 18px;
      padding: 22px 0 4px;
      border-bottom: 1px solid var(--line);
    }
    .kicker { color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 10px; }
    .top { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(320px, 0.92fr); gap: 16px; margin-bottom: 16px; align-items: start; }
    .card { padding: 20px; animation: panelIn var(--motion-slow) ease-out both; }
    .top .card:nth-child(1) { animation-delay: 80ms; }
    .top .card:nth-child(2) { animation-delay: 140ms; }
    .status { min-height: 18px; font-size: 13px; color: var(--muted); margin-top: 10px; transition: color var(--motion-fast) ease, opacity var(--motion-fast) ease; }
    .status.flash { animation: statusFlash 620ms ease-out; }
    .stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 16px; }
    .stat, .mini {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
      padding: 14px;
      animation: panelIn var(--motion-slow) ease-out both;
      transition: border-color var(--motion-med) ease, transform var(--motion-med) ease, background var(--motion-med) ease;
    }
    .stat:hover, .mini:hover { transform: translateY(-2px); border-color: rgba(41, 95, 200, 0.26); background: rgba(255, 250, 241, 0.94); }
    .stat.primary { grid-column: span 2; background: #1f2a35; color: #fffaf1; }
    .stat.primary .muted { color: rgba(255, 250, 241, 0.72); }
    .stat.good { border-color: rgba(20, 134, 109, 0.28); }
    .stat.warn { border-color: rgba(176, 113, 35, 0.32); }
    .stat.bad { border-color: rgba(201, 79, 79, 0.28); }
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
    .stat b, .mini b { display: block; font-size: clamp(20px, 2.2vw, 30px); line-height: 1; margin-bottom: 7px; transition: transform var(--motion-fast) ease, color var(--motion-fast) ease; }
    .value-pop { animation: valuePop 360ms ease-out; color: var(--accent); }
    .stat.primary .value-pop { color: #fffaf1; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin: 18px 0 14px; }
    .toolbar-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--muted); font-size: 13px; margin-bottom: 12px; }
    .check { width: 16px; height: 16px; accent-color: var(--accent); transition: transform var(--motion-fast) ease; }
    .check:checked { transform: scale(1.08); }
    .fleet-board { display: grid; grid-template-columns: 0.85fr 1.15fr; gap: 12px; margin-bottom: 16px; }
    .rank-list { display: grid; gap: 10px; }
    .rank-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; animation: rowIn 360ms ease-out both; }
    .bar { height: 9px; border-radius: 999px; background: rgba(29, 37, 44, 0.10); overflow: hidden; margin-top: 8px; }
    .bar i {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      transition: width 680ms cubic-bezier(0.22, 1, 0.36, 1);
      box-shadow: 0 0 16px rgba(43, 212, 168, 0.22);
    }
    .attention-queue {
      display: grid;
      gap: 10px;
      margin: 0 0 16px;
      padding: 12px;
      border: 1px solid rgba(176, 113, 35, 0.24);
      border-radius: 8px;
      background: rgba(255, 250, 241, 0.54);
    }
    .attention-queue.clean { border-color: rgba(20, 134, 109, 0.18); }
    .attention-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .attention-head h3 { margin: 0 0 4px; font-size: 15px; }
    .attention-list {
      display: grid;
      max-height: 340px;
      overflow: auto;
      border-top: 1px solid var(--line);
    }
    .attention-row {
      display: grid;
      grid-template-columns: minmax(190px, 0.9fr) minmax(260px, 1.2fr) minmax(150px, 0.55fr) auto;
      gap: 12px;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid var(--line);
      animation: rowIn 360ms ease-out both;
    }
    .attention-row:last-child { border-bottom: 0; }
    .attention-title { display: grid; gap: 4px; min-width: 0; }
    .attention-title b, .attention-error { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attention-recovery { color: var(--warn); }
    .filters { display: grid; grid-template-columns: minmax(220px, 1fr) 170px 170px; gap: 10px; width: min(100%, 680px); }
    select {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--text);
      border-radius: 8px;
      padding: 12px 14px;
      font: inherit;
      transition: border-color var(--motion-fast) ease, box-shadow var(--motion-fast) ease, background var(--motion-fast) ease;
    }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: rgba(255, 250, 241, 0.58); }
    table { width: 100%; border-collapse: collapse; min-width: 1040px; }
    th, td { padding: 13px 10px; border-bottom: 1px solid var(--line); text-align: left; font-size: 13px; vertical-align: middle; }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; background: rgba(236, 230, 220, 0.76); }
    tr:last-child td { border-bottom: 0; }
    tbody tr {
      animation: rowIn 360ms ease-out both;
      transition: background var(--motion-fast) ease, transform var(--motion-fast) ease;
    }
    tbody tr:hover { background: rgba(41, 95, 200, 0.055); transform: translateX(2px); }
    tbody tr.row-attention { background: rgba(201, 79, 79, 0.045); }
    tbody tr.row-available { background: rgba(20, 134, 109, 0.035); }
    .node-title { display: grid; gap: 4px; min-width: 220px; }
    .node-title b { font-size: 14px; }
    .node-url { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .inline-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; min-width: 260px; }
    .inline-actions button { padding: 7px 9px; font-size: 12px; }
    .endpoint-box {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
      margin-top: 10px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(236, 230, 220, 0.52);
    }
    .endpoint-box .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-editor { margin-top: 12px; }
    .model-editor textarea { min-height: 118px; }
    .model-picker {
      display: grid;
      gap: 8px;
      margin-top: 10px;
      max-height: 220px;
      overflow: auto;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(236, 230, 220, 0.38);
    }
    .model-option {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
      color: var(--text);
    }
    .model-option code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-option small { color: var(--muted); white-space: nowrap; }
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
    .tag.ok { color: var(--accent-2); border-color: rgba(20, 134, 109, 0.35); animation: okPulse 2.8s ease-in-out infinite; }
    .tag.off { color: var(--warn); border-color: rgba(176, 113, 35, 0.35); }
    .tag.bad { color: var(--danger); border-color: rgba(201, 79, 79, 0.35); animation: warnPulse 1.8s ease-in-out infinite; }
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
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #171716;
        --surface: #22211f;
        --surface-2: #1d1d1b;
        --surface-3: #2b2925;
        --muted: #aaa39a;
        --line: rgba(245, 239, 228, 0.12);
        --text: #f6efe5;
        --panel: rgba(31, 31, 29, 0.9);
        --panel-soft: rgba(35, 34, 31, 0.76);
        --shadow: 0 18px 48px rgba(0, 0, 0, 0.30);
      }
      body {
        background:
          linear-gradient(180deg, rgba(23, 23, 22, 0.96), rgba(30, 29, 27, 0.98)),
          repeating-linear-gradient(90deg, rgba(246, 239, 229, 0.03) 0 1px, transparent 1px 96px);
      }
      input:focus, textarea:focus, select:focus { background: #262522; }
      .stat.primary { background: #f6efe5; color: #1d252c; }
      .stat.primary .muted { color: rgba(29, 37, 44, 0.68); }
      .stat.primary .value-pop { color: #1d252c; }
      .stat:hover, .mini:hover { background: rgba(39, 38, 35, 0.94); }
      .table-wrap { background: rgba(31, 31, 29, 0.58); }
      th { background: rgba(43, 41, 37, 0.78); }
      .endpoint-box { background: rgba(43, 41, 37, 0.54); }
    }
    @media (max-width: 1180px) { .stats { grid-template-columns: repeat(4, 1fr); } }
    @media (max-width: 1120px) { .attention-row { grid-template-columns: 1fr 1fr; } .attention-row .inline-actions { justify-content: flex-start; } }
    @media (max-width: 860px) { .header, .top, .grid.two, .fleet-board, .stats, .filters { grid-template-columns: 1fr 1fr; } .header { align-items: start; } }
    @media (max-width: 560px) { .header, .top, .grid.two, .fleet-board, .stats, .filters, .attention-row { grid-template-columns: 1fr; } .attention-title b, .attention-error { white-space: normal; } }
  </style>
</head>
<body>
  <section id="gate" class="gate">
    <div class="gate-card">
      <h1>HYHub</h1>
      <p>先输入管理员密钥完成验证，再进入 API Hub 控制台。</p>
      <div class="field" style="margin-top:18px">
        <input id="token" type="password" placeholder="请输入管理员密钥" />
        <button id="gate-submit">进入控制台</button>
      </div>
      <div class="status" id="gate-status"></div>
    </div>
  </section>

  <main id="app" class="wrap hidden">
    <div class="header">
      <div>
        <div class="kicker">Operations console</div>
        <h1>HYHub</h1>
        <p class="muted">先管理项目和对外 API Key，再把项目绑定到指定的上游账号组。</p>
      </div>
      <div class="actions" style="margin-top:0">
        <button class="secondary" id="reload">刷新</button>
        <button class="danger" id="logout">退出</button>
      </div>
    </div>

    <section class="stats">
      <div class="stat primary"><b id="sum-available">0</b><span class="muted">可参与轮询</span></div>
      <div class="stat"><b id="sum-total">0</b><span class="muted">总账号</span></div>
      <div class="stat warn"><b id="sum-action">0</b><span class="muted">需处理</span></div>
      <div class="stat"><b id="sum-enabled">0</b><span class="muted">启用中</span></div>
      <div class="stat"><b id="sum-disabled">0</b><span class="muted">已停用</span></div>
      <div class="stat"><b id="sum-calls">0</b><span class="muted">调用次数</span></div>
      <div class="stat good"><b id="sum-successes">0</b><span class="muted">成功</span></div>
      <div class="stat bad"><b id="sum-errors">0</b><span class="muted">失败</span></div>
      <div class="stat good"><b id="sum-success-rate">0%</b><span class="muted">真实成功率</span></div>
      <div class="stat"><b id="sum-avg">0ms</b><span class="muted">真实均耗时</span></div>
      <div class="stat"><b id="sum-health-checks">0</b><span class="muted">健康检测</span></div>
    </section>

    <div class="top">
      <section class="card">
        <div class="kicker">Project manager</div>
        <h2 style="margin:0 0 8px;font-size:18px">项目 / API Key</h2>
        <p class="muted" style="margin:0 0 14px">每个项目都有自己的对外 API Key，并且只会在选中的上游账号里轮询。</p>
        <div class="grid two">
          <input id="project-id" placeholder="项目 ID（可留空）" />
          <input id="project-name" placeholder="项目名称" />
        </div>
        <label class="muted" style="display:flex;align-items:center;gap:8px;margin-top:12px">
          <input id="project-enabled" class="check" type="checkbox" checked />
          启用项目
        </label>
        <div class="actions">
          <button id="save-project">保存项目</button>
          <button class="secondary" id="clear-project">清空项目</button>
          <button class="secondary" id="generate-project-key">创建 API Key</button>
        </div>
        <div class="endpoint-box">
          <span class="mono muted" id="project-endpoint">/v1</span>
          <button class="secondary" id="copy-endpoint">复制 Base URL</button>
        </div>
        <div id="projects" class="rank-list" style="margin-top:14px"></div>
        <div class="status" id="project-status"></div>
      </section>

      <section class="card">
        <div class="kicker">Upstream account editor</div>
        <h2 style="margin:0 0 8px;font-size:18px">上游账号管理</h2>
        <p class="muted" style="margin:0 0 14px">把用户自己的 API Key 和 Base URL 填进来，再在项目里选择哪些账号参与轮询。</p>
        <div class="grid two">
          <input id="id" placeholder="账号 ID（可留空）" />
          <input id="label" placeholder="显示名称，可留空" />
        </div>
        <div class="grid two" style="margin-top:10px">
          <input id="baseUrl" placeholder="上游 Base URL" />
          <input id="apiKey" placeholder="上游 API Key（必填）" />
        </div>
        <div class="grid two" style="margin-top:10px">
          <input id="weight" type="number" min="1" max="20" step="1" placeholder="权重 1-20，默认 1" />
          <input id="max-retry-accounts" type="number" min="1" max="20" step="1" placeholder="失败重试账号数，默认 3" />
        </div>
        <div class="grid" style="margin-top:10px">
          <textarea id="extraHeaders" placeholder='可选额外请求头 JSON，例如 {"OpenAI-Organization":"org_xxx"}'></textarea>
        </div>
        <div class="actions">
          <button id="add-account">保存账号</button>
          <button class="secondary" id="clear-form">清空</button>
          <button class="secondary" id="save-routing">保存路由策略</button>
        </div>
        <label class="muted" style="display:flex;align-items:center;gap:8px;margin-top:12px">
          <input id="disable-on-failure" class="check" type="checkbox" />
          真实代理失败后自动停用该账号
        </label>
        <div class="status" id="status"></div>
      </section>

      <section class="card">
        <div class="kicker">Console tools</div>
        <h2 style="margin:0 0 8px;font-size:18px">控制台</h2>
        <p class="muted" style="margin:0 0 14px">检测只更新账号可用性，不计入真实 API 请求数。环境变量里的 AUTH_TOKEN 现在只用于管理员登录。</p>
        <div class="field">
          <input id="current-token" type="password" disabled />
          <input id="api-test-model" placeholder="API 检测模型，默认 gpt-4.1-mini" />
        </div>
        <div class="model-editor">
          <textarea id="open-models" placeholder="开放模型，一行一个，例如&#10;gpt-4.1-mini&#10;gpt-4o-mini"></textarea>
          <div class="grid two" style="margin-top:10px">
            <input id="model-discovery-limit" type="number" min="1" max="50" step="1" value="8" placeholder="推荐扫描节点数，默认 8" />
          </div>
          <div class="actions">
            <button class="secondary" id="discover-models">系统推荐模型</button>
            <button class="secondary" id="apply-discovered-models">使用选中模型</button>
            <button class="secondary" id="save-models">保存开放模型</button>
          </div>
          <div id="discovered-models" class="model-picker hidden"></div>
        </div>
        <div class="actions">
          <button class="secondary" id="export-accounts">导出</button>
          <button class="secondary" id="import-accounts">导入</button>
          <button class="danger" id="reset-stats">清空统计</button>
        </div>
        <div class="status" id="meta-status"></div>
      </section>
    </div>

    <section class="card">
      <div class="row">
        <div>
          <div class="kicker">Upstream account pool</div>
          <h2 style="margin:0 0 8px;font-size:18px">上游账号池</h2>
          <p class="muted" style="margin:0">真实调用统计和健康检测状态已分开，账号多时先看筛选后的主表。</p>
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
      <div id="attention-queue" class="attention-queue clean"></div>
      <div class="toolbar-meta">
        <span id="visible-count">显示 0 / 0 个账号</span>
        <span id="selected-count">已选 0 个</span>
        <span>检测不会计入真实 API 请求</span>
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
            当前筛选全选
          </label>
          <button class="secondary" id="test-all">全部检测</button>
          <button class="secondary" id="batch-enable">批量启用</button>
          <button class="secondary" id="batch-disable">批量停用</button>
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
    const projectStatusEl = document.getElementById("project-status");
    const listEl = document.getElementById("accounts");
    const projectsEl = document.getElementById("projects");
    const tokenInput = document.getElementById("token");
    const currentTokenInput = document.getElementById("current-token");
    const apiTestModelInput = document.getElementById("api-test-model");
    const openModelsInput = document.getElementById("open-models");
    const modelDiscoveryLimitInput = document.getElementById("model-discovery-limit");
    const discoveredModelsEl = document.getElementById("discovered-models");
    const searchInput = document.getElementById("account-search");
    const statusFilterInput = document.getElementById("status-filter");
    const sortModeInput = document.getElementById("sort-mode");
    const projectEndpointEl = document.getElementById("project-endpoint");
    const selectedIds = new Set();
    let currentAccounts = [];
    let currentProjects = [];
    let selectedProjectId = "";
    let visibleAccountIds = [];
    tokenInput.value = localStorage.getItem("hyhub-admin-token") || localStorage.getItem("rt-router-token") || "";
    currentTokenInput.value = tokenInput.value;
    apiTestModelInput.value = localStorage.getItem("rt-router-api-test-model") || "gpt-4.1-mini";
    projectEndpointEl.textContent = window.location.origin + "/v1";
    function setStatus(target, message, isError = false) {
      target.textContent = message || "";
      target.style.color = isError ? "var(--danger)" : "var(--muted)";
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
    function formatDuration(ms) {
      const safeMs = Math.max(0, Number(ms || 0));
      const seconds = Math.ceil(safeMs / 1000);
      if (seconds < 60) return seconds + " 秒";
      const minutes = Math.ceil(seconds / 60);
      if (minutes < 60) return minutes + " 分钟";
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      return hours + " 小时" + (restMinutes ? " " + restMinutes + " 分钟" : "");
    }
    function recoveryText(account) {
      const unhealthyUntil = Number(account.unhealthyUntil || 0);
      if (unhealthyUntil > Date.now()) return formatDuration(unhealthyUntil - Date.now()) + " 后恢复轮询";
      if (account.health?.lastOk === false) return "重新检测通过后恢复";
      return "可立即参与轮询";
    }
    function lastProblem(account) {
      const error = account.health?.lastError || account.stats?.lastError;
      if (error) return String(error).slice(0, 160);
      if (account.health?.lastStatus) return "最近检测返回 HTTP " + account.health.lastStatus;
      if (account.stats?.lastStatus) return "最近真实请求返回 HTTP " + account.stats.lastStatus;
      return "暂无错误详情";
    }
    function attentionReason(account) {
      const reasons = [];
      if ((account.unhealthyUntil || 0) > Date.now()) reasons.push("冷却中");
      if (account.health?.lastOk === false) reasons.push("最近检测失败");
      return reasons.length ? reasons.join(" / ") : "需处理";
    }
    function quickActions(account) {
      const id = escapeHtml(account.id);
      return '<div class="inline-actions">' +
        '<button class="secondary" onclick="testAccount(\\'' + id + '\\')">可用检测</button>' +
        '<button class="secondary" onclick="toggleAccount(\\'' + id + '\\', ' + (!account.enabled) + ')">' + (account.enabled ? "停用" : "启用") + '</button>' +
        '<button class="secondary" onclick="copyAccountUrl(\\'' + id + '\\')">复制地址</button>' +
      '</div>';
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
        localStorage.setItem("hyhub-admin-token", getToken());
        setStatus(gateStatusEl, "验证中...");
        const data = await api("/admin/verify");
        setSummary(data.summary || {});
        unlockApp();
        setStatus(gateStatusEl, "");
        setStatus(metaStatusEl, "验证通过。需要确认可用性时可手动点击全部检测。");
        await loadAccounts();
        await loadProjects();
        await loadRouting();
        await loadModels();
      } catch (error) {
        setStatus(gateStatusEl, error.message, true);
      }
    }
    function clearForm() {
      document.getElementById("id").value = "";
      document.getElementById("label").value = "";
      document.getElementById("baseUrl").value = "";
      document.getElementById("apiKey").value = "";
      document.getElementById("weight").value = "";
      document.getElementById("extraHeaders").value = "";
    }
    function syncSelectAll() {
      const selectAll = document.getElementById("select-all");
      selectAll.checked = visibleAccountIds.length > 0 && visibleAccountIds.every((id) => selectedIds.has(id));
      document.getElementById("selected-count").textContent = "已选 " + selectedIds.size + " 个";
    }
    function syncProjectAccountSelection(project) {
      selectedProjectId = project?.id || "";
      selectedIds.clear();
      (project?.accountIds || []).forEach((id) => selectedIds.add(id));
      document.getElementById("project-id").value = project?.id || "";
      document.getElementById("project-name").value = project?.name || "";
      document.getElementById("project-enabled").checked = project?.enabled !== false;
      syncSelectAll();
    }
    function renderProjects(projects) {
      currentProjects = projects || [];
      if (!currentProjects.length) {
        projectsEl.innerHTML = '<span class="muted">还没有项目。先创建一个项目，再选择上游账号并创建 API Key。</span>';
        syncProjectAccountSelection(null);
        return;
      }
      if (!selectedProjectId || !currentProjects.some((project) => project.id === selectedProjectId)) {
        syncProjectAccountSelection(currentProjects[0]);
      }
      projectsEl.innerHTML = currentProjects.map((project) => {
        const selected = project.id === selectedProjectId;
        const keys = (project.apiKeys || []).map((key) => (
          '<span class="tag mono" title="' + escapeHtml(key) + '">' + escapeHtml(key.slice(0, 10)) + '...' +
          '<button class="secondary" style="margin-left:8px;padding:4px 8px" onclick="copyProjectKey(' + jsString(project.id) + ', ' + jsString(key) + ')">复制</button>' +
          '<button class="danger" style="margin-left:4px;padding:4px 8px" onclick="deleteProjectKey(' + jsString(project.id) + ', ' + jsString(key) + ')">删</button></span>'
        )).join(" ");
        return '<div class="rank-row" style="' + (selected ? 'border-color:rgba(43,212,168,.42);' : '') + '">' +
          '<div><div class="row" style="gap:8px"><b>' + escapeHtml(project.name) + '</b><span class="muted mono">' + escapeHtml(project.id) + '</span><span class="tag ' + (project.enabled ? 'ok' : 'off') + '">' + (project.enabled ? '启用' : '停用') + '</span></div>' +
          '<div class="muted" style="margin-top:6px">绑定 ' + (project.accountIds?.length || 0) + ' 个上游账号，API Key ' + (project.keyCount || 0) + ' 个</div>' +
          '<div class="meta" style="margin-top:8px">' + (keys || '<span class="muted">暂无 API Key</span>') + '</div></div>' +
          '<div class="inline-actions"><button class="secondary" onclick="selectProject(' + jsString(project.id) + ')">选择</button><button class="secondary" onclick="toggleProject(' + jsString(project.id) + ', ' + (!project.enabled) + ')">' + (project.enabled ? '停用' : '启用') + '</button><button class="danger" onclick="deleteProject(' + jsString(project.id) + ')">删除</button></div>' +
        '</div>';
      }).join("");
    }
    function renderAttentionQueue(accounts) {
      const queueEl = document.getElementById("attention-queue");
      const items = accounts
        .filter((account) => accountState(account) === "attention")
        .sort((a, b) => {
          const aCooling = (a.unhealthyUntil || 0) > Date.now() ? 0 : 1;
          const bCooling = (b.unhealthyUntil || 0) > Date.now() ? 0 : 1;
          if (aCooling !== bCooling) return aCooling - bCooling;
          return (a.unhealthyUntil || Number.MAX_SAFE_INTEGER) - (b.unhealthyUntil || Number.MAX_SAFE_INTEGER);
        });
      queueEl.classList.toggle("clean", items.length === 0);
      if (!items.length) {
        queueEl.innerHTML = '<div class="attention-head"><div><h3>待处理账号</h3><div class="muted">当前没有冷却中或最近检测失败的启用账号。</div></div><span class="tag ok">队列清空</span></div>';
        return;
      }
      queueEl.innerHTML = '<div class="attention-head"><div><h3>待处理账号</h3><div class="muted">按冷却恢复时间和检测失败优先排列，可直接处理，不用回表里翻。</div></div><span class="tag bad">' + items.length + ' 个需处理</span></div>' +
        '<div class="attention-list">' + items.map((account, index) => {
          return '<div class="attention-row" style="animation-delay:' + Math.min(220, index * 28) + 'ms">' +
            '<div class="attention-title"><b>' + escapeHtml(account.label) + '</b><span class="muted mono">' + escapeHtml(account.id) + '</span><span class="muted mono node-url" title="' + escapeHtml(account.baseUrl) + '">' + escapeHtml(account.baseUrl) + '</span></div>' +
            '<div><div class="meta" style="margin-top:0">' + stateTag(account) + '<span class="tag off">' + escapeHtml(attentionReason(account)) + '</span>' + (account.health?.lastStatus ? '<span class="tag">检测状态 ' + account.health.lastStatus + '</span>' : '') + '</div><div class="muted attention-error" title="' + escapeHtml(lastProblem(account)) + '" style="margin-top:8px;color:var(--danger)">' + escapeHtml(lastProblem(account)) + '</div></div>' +
            '<div><div class="muted">恢复预估</div><div class="mono attention-recovery">' + escapeHtml(recoveryText(account)) + '</div></div>' +
            quickActions(account) +
          '</div>';
        }).join("") + '</div>';
    }
    function renderAccounts(accounts) {
      currentAccounts = accounts;
      renderAttentionQueue(accounts);
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
      visibleAccountIds = visible.map((account) => account.id);
      document.getElementById("visible-count").textContent = "显示 " + visible.length + " / " + accounts.length + " 个账号";
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
          '<td><div class="meta" style="margin-top:0">' + stateTag(account) + '<span class="tag">权重 ' + (account.weight || 1) + '</span><span class="tag">' + (headers.length ? "额外请求头 " + headers.length : "无额外请求头") + '</span>' + (account.health?.lastStatus ? '<span class="tag">检测状态 ' + account.health.lastStatus + '</span>' : '') + '</div>' + (account.health?.lastError ? '<div class="muted" style="margin-top:8px;color:var(--danger)">' + escapeHtml(account.health.lastError).slice(0, 120) + '</div>' : '') + '</td>' +
          '<td><div class="mono">' + (account.stats?.calls || 0) + ' 次</div><div class="muted">成功 ' + (account.stats?.successes || 0) + ' / 失败 ' + (account.stats?.errors || 0) + ' / ' + successRate + '</div><div class="muted">均耗时 ' + (account.stats?.avgDurationMs || 0) + 'ms</div></td>' +
          '<td><div class="mono">' + (account.health?.checks || 0) + ' 次</div><div class="muted">' + lastCheck + '</div></td>' +
          '<td><div class="muted">' + lastUsed + '</div></td>' +
          '<td><div class="inline-actions"><button class="secondary" onclick="editAccount(\\'' + escapeHtml(account.id) + '\\')">编辑</button><button class="secondary" onclick="copyAccountUrl(\\'' + escapeHtml(account.id) + '\\')">复制地址</button><button class="secondary" onclick="testAccount(\\'' + escapeHtml(account.id) + '\\')">可用检测</button><button class="secondary" onclick="toggleAccount(\\'' + escapeHtml(account.id) + '\\', ' + (!account.enabled) + ')">' + (account.enabled ? "停用" : "启用") + '</button><button class="danger" onclick="removeAccount(\\'' + escapeHtml(account.id) + '\\')">删除</button></div></td>' +
          '</tr>';
      }).join("") + '</tbody></table></div>';
    document.querySelectorAll("[data-account-check]").forEach((input) => {
        input.addEventListener("change", (event) => {
          const id = event.target.getAttribute("data-account-check");
          if (!id) return;
          if (event.target.checked) selectedIds.add(id);
          else selectedIds.delete(id);
          syncSelectAll();
          if (selectedProjectId) setStatus(projectStatusEl, "项目账号组有未保存改动，点击保存项目后生效。");
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
    async function loadProjects() {
      try {
        const data = await api("/admin/projects");
        renderProjects(data.projects || []);
      } catch (error) {
        setStatus(projectStatusEl, error.message, true);
      }
    }
    async function saveProject() {
      try {
        setBusy("save-project", true);
        const id = document.getElementById("project-id").value.trim();
        const payload = {
          id: id || undefined,
          name: document.getElementById("project-name").value.trim() || id || undefined,
          enabled: document.getElementById("project-enabled").checked,
          accountIds: [...selectedIds],
        };
        const existing = currentProjects.some((project) => project.id === id);
        const data = await api(existing ? "/admin/projects/" + encodeURIComponent(id) : "/admin/projects", {
          method: existing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        syncProjectAccountSelection(data.project);
        await loadProjects();
        setStatus(projectStatusEl, "项目已保存，当前勾选账号就是这个项目的轮询组。");
      } catch (error) {
        setStatus(projectStatusEl, error.message, true);
      } finally {
        setBusy("save-project", false);
      }
    }
    async function generateProjectKey() {
      try {
        if (!selectedProjectId) throw new Error("请先选择或保存一个项目");
        setBusy("generate-project-key", true);
        const data = await api("/admin/projects/" + encodeURIComponent(selectedProjectId) + "/keys", { method: "POST" });
        await navigator.clipboard.writeText(data.key);
        await loadProjects();
        setStatus(projectStatusEl, "API Key 已创建并复制。客户端用它作为 Bearer Token。");
      } catch (error) {
        setStatus(projectStatusEl, error.message, true);
      } finally {
        setBusy("generate-project-key", false);
      }
    }
    window.selectProject = function(id) {
      const project = currentProjects.find((item) => item.id === id);
      if (!project) return;
      syncProjectAccountSelection(project);
      renderProjects(currentProjects);
      renderAccounts(currentAccounts);
      setStatus(projectStatusEl, "已选择项目：" + project.name);
    };
    window.toggleProject = async function(id, enabled) {
      try {
        await api("/admin/projects/" + encodeURIComponent(id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        await loadProjects();
        setStatus(projectStatusEl, enabled ? "项目已启用。" : "项目已停用。");
      } catch (error) {
        setStatus(projectStatusEl, error.message, true);
      }
    };
    window.deleteProject = async function(id) {
      if (!confirm("确认删除这个项目？它的 API Key 会一起失效。")) return;
      try {
        await api("/admin/projects/" + encodeURIComponent(id), { method: "DELETE" });
        if (selectedProjectId === id) selectedProjectId = "";
        await loadProjects();
        setStatus(projectStatusEl, "项目已删除。");
      } catch (error) {
        setStatus(projectStatusEl, error.message, true);
      }
    };
    window.copyProjectKey = async function(id, key) {
      try {
        await navigator.clipboard.writeText(key);
        setStatus(projectStatusEl, "API Key 已复制。");
      } catch {
        setStatus(projectStatusEl, "复制失败，请手动复制：" + key, true);
      }
    };
    window.deleteProjectKey = async function(id, key) {
      if (!confirm("确认删除这个 API Key？")) return;
      try {
        await api("/admin/projects/" + encodeURIComponent(id) + "/keys/" + encodeURIComponent(key), { method: "DELETE" });
        await loadProjects();
        setStatus(projectStatusEl, "API Key 已删除。");
      } catch (error) {
        setStatus(projectStatusEl, error.message, true);
      }
    };
    async function loadRouting() {
      try {
        const data = await api("/admin/routing");
        const routing = data.routing || {};
        document.getElementById("max-retry-accounts").value = String(routing.maxRetryAccounts || 3);
        document.getElementById("disable-on-failure").checked = routing.disableOnFailure === true;
      } catch (error) {
        setStatus(metaStatusEl, error.message, true);
      }
    }
    async function saveRouting() {
      try {
        setBusy("save-routing", true);
        const payload = {
          maxRetryAccounts: Number(document.getElementById("max-retry-accounts").value || 3),
          disableOnFailure: document.getElementById("disable-on-failure").checked,
        };
        const data = await api("/admin/routing", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const routing = data.routing || payload;
        document.getElementById("max-retry-accounts").value = String(routing.maxRetryAccounts || 3);
        document.getElementById("disable-on-failure").checked = routing.disableOnFailure === true;
        setStatus(statusEl, "路由策略已保存。");
      } catch (error) {
        setStatus(statusEl, error.message, true);
      } finally {
        setBusy("save-routing", false);
      }
    }
    async function loadModels() {
      try {
        const data = await api("/admin/models");
        openModelsInput.value = (data.models || []).join("\\n");
      } catch (error) {
        setStatus(metaStatusEl, error.message, true);
      }
    }
    async function saveModels() {
      try {
        setBusy("save-models", true);
        const models = openModelsInput.value.split(/[\\n,]+/).map((item) => item.trim()).filter(Boolean);
        const data = await api("/admin/models", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ models }),
        });
        openModelsInput.value = (data.models || []).join("\\n");
        setStatus(metaStatusEl, "开放模型已保存，共 " + (data.models || []).length + " 个。");
      } catch (error) {
        setStatus(metaStatusEl, error.message, true);
      } finally {
        setBusy("save-models", false);
      }
    }
    function renderDiscoveredModels(recommendations) {
      const items = Array.isArray(recommendations) ? recommendations : [];
      discoveredModelsEl.classList.remove("hidden");
      if (!items.length) {
        discoveredModelsEl.innerHTML = '<span class="muted">没有从启用节点读取到模型。</span>';
        return;
      }
      const current = new Set(openModelsInput.value.split(/[\\n,]+/).map((item) => item.trim()).filter(Boolean));
      discoveredModelsEl.innerHTML = items.map((item) => {
        const checked = current.has(item.model) ? "checked" : "";
        const labels = (item.accounts || []).join(", ");
        return '<label class="model-option" title="' + escapeHtml(labels) + '">' +
          '<input class="check" type="checkbox" data-discovered-model="' + escapeHtml(item.model) + '" ' + checked + ' />' +
          '<code>' + escapeHtml(item.model) + '</code>' +
          '<small>' + (item.accounts?.length || 0) + ' 个节点</small>' +
        '</label>';
      }).join("");
    }
    async function discoverModels() {
      try {
        setBusy("discover-models", true);
        const limit = Math.max(1, Math.min(50, Number(modelDiscoveryLimitInput.value || 8)));
        modelDiscoveryLimitInput.value = String(limit);
        setStatus(metaStatusEl, "正在从最多 " + limit + " 个候选节点读取模型列表...");
        const data = await api("/admin/models/discover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit }),
        });
        renderDiscoveredModels(data.recommendations || []);
        setStatus(metaStatusEl, "模型读取完成：" + (data.recommendations || []).length + " 个候选，" + (data.okCount || 0) + "/" + (data.scanned || data.total || 0) + " 个扫描节点成功，已跳过 " + (data.skipped || 0) + " 个。");
      } catch (error) {
        setStatus(metaStatusEl, error.message, true);
      } finally {
        setBusy("discover-models", false);
      }
    }
    function applyDiscoveredModels() {
      const selected = [...discoveredModelsEl.querySelectorAll("[data-discovered-model]:checked")]
        .map((input) => input.getAttribute("data-discovered-model"))
        .filter(Boolean);
      if (!selected.length) {
        setStatus(metaStatusEl, "先选择要开放的模型。", true);
        return;
      }
      openModelsInput.value = selected.join("\\n");
      setStatus(metaStatusEl, "已填入 " + selected.length + " 个模型，确认后点击保存开放模型。");
    }
    async function copyEndpoint() {
      const endpoint = window.location.origin + "/v1";
      try {
        await navigator.clipboard.writeText(endpoint);
        setStatus(projectStatusEl, "Base URL 已复制：" + endpoint);
      } catch {
        setStatus(projectStatusEl, "复制失败，请手动复制：" + endpoint, true);
      }
    }
    async function copyAccountUrl(id) {
      const account = currentAccounts.find((item) => item.id === id);
      if (!account) {
        setStatus(statusEl, "未找到账号。", true);
        return;
      }
      try {
        await navigator.clipboard.writeText(account.baseUrl);
        setStatus(statusEl, "节点地址已复制：" + account.baseUrl);
      } catch {
        setStatus(statusEl, "复制失败，请手动复制：" + account.baseUrl, true);
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
          weight: Number(document.getElementById("weight").value || 1),
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
        document.getElementById("weight").value = String(account.weight || 1);
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
        downloadJson("hyhub-upstream-accounts.json", data);
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
    window.copyAccountUrl = copyAccountUrl;
    document.getElementById("gate-submit").addEventListener("click", verify);
    tokenInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") verify();
    });
    document.getElementById("save-project").addEventListener("click", saveProject);
    document.getElementById("clear-project").addEventListener("click", () => {
      selectedProjectId = "";
      syncProjectAccountSelection(null);
      renderProjects(currentProjects);
      renderAccounts(currentAccounts);
      setStatus(projectStatusEl, "已清空项目表单。");
    });
    document.getElementById("generate-project-key").addEventListener("click", generateProjectKey);
    document.getElementById("add-account").addEventListener("click", addAccount);
    document.getElementById("save-routing").addEventListener("click", saveRouting);
    document.getElementById("discover-models").addEventListener("click", discoverModels);
    document.getElementById("apply-discovered-models").addEventListener("click", applyDiscoveredModels);
    document.getElementById("save-models").addEventListener("click", saveModels);
    document.getElementById("reload").addEventListener("click", loadAccounts);
    document.getElementById("clear-form").addEventListener("click", clearForm);
    document.getElementById("test-all").addEventListener("click", probeAllAccounts);
    document.getElementById("copy-endpoint").addEventListener("click", copyEndpoint);
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
      visibleAccountIds.forEach((id) => {
        if (checked) selectedIds.add(id);
        else selectedIds.delete(id);
      });
      renderAccounts(currentAccounts);
    });
    document.getElementById("logout").addEventListener("click", () => {
      localStorage.removeItem("hyhub-admin-token");
      localStorage.removeItem("rt-router-token");
      tokenInput.value = "";
      currentTokenInput.value = "";
      selectedIds.clear();
      selectedProjectId = "";
      appEl.classList.add("hidden");
      gateEl.classList.remove("hidden");
      renderAccounts([]);
      renderProjects([]);
      setSummary({ total: 0, enabled: 0, disabled: 0, cooling: 0, calls: 0, successes: 0, errors: 0 });
      setStatus(gateStatusEl, "已退出。");
    });
    if (getToken()) verify();
    else {
      renderAccounts([]);
      setSummary({ total: 0, enabled: 0, disabled: 0, cooling: 0, calls: 0, successes: 0, errors: 0 });
      setStatus(gateStatusEl, "先输入管理员密钥。");
    }
  </script>
</body>
</html>`;
}

function renderAdminPageV2(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HYHub Admin</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f5f7fa;
      --panel: #ffffff;
      --panel-soft: #f1f5f9;
      --text: #172033;
      --muted: #64748b;
      --line: rgba(23, 32, 51, 0.12);
      --accent: #2563eb;
      --ok: #0f9f6e;
      --warn: #b7791f;
      --bad: #d64545;
      --shadow: 0 18px 46px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; overflow-x: hidden; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    .hidden { display: none !important; }
    .gate { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .gate-card, .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
    .gate-card { width: min(440px, 100%); padding: 28px; display: grid; gap: 14px; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 236px minmax(0, 1fr); width: 100%; overflow-x: clip; }
    aside { position: sticky; top: 0; height: 100vh; min-width: 0; overflow-y: auto; border-right: 1px solid var(--line); background: var(--panel); padding: 20px 14px; display: flex; flex-direction: column; gap: 18px; }
    .brand h1 { margin: 0 0 6px; font-size: 25px; letter-spacing: 0; }
    .brand p, .muted { color: var(--muted); line-height: 1.55; }
    nav { display: grid; gap: 8px; }
    .nav-btn { justify-content: flex-start; background: transparent; color: var(--text); border: 1px solid transparent; }
    .nav-btn.active { background: var(--panel-soft); border-color: var(--line); color: var(--accent); }
    main { min-width: 0; max-width: 100%; overflow-x: hidden; padding: 22px; display: grid; gap: 16px; align-content: start; }
    header { min-width: 0; display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
    h2, h3 { margin: 0; letter-spacing: 0; }
    h2 { font-size: 26px; }
    h3 { font-size: 17px; }
    button, input, textarea, select { font: inherit; border-radius: 8px; }
    button { border: 0; padding: 10px 13px; background: var(--accent); color: #fff; cursor: pointer; }
    button.secondary { background: #334155; }
    button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
    button.danger { background: var(--bad); }
    button:disabled { opacity: .65; cursor: wait; }
    input, textarea, select { width: 100%; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 11px 12px; }
    textarea { min-height: 92px; resize: vertical; }
    .page { display: none; gap: 16px; min-width: 0; }
    .page.active { display: grid; }
    .panel { min-width: 0; padding: 18px; }
    .grid { min-width: 0; display: grid; gap: 12px; }
    .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .stats { min-width: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
    .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .stat b { display: block; font-size: 25px; margin-bottom: 6px; }
    .layout-projects { min-width: 0; display: grid; grid-template-columns: 310px minmax(0, 1fr); gap: 16px; align-items: start; }
    .list { display: grid; gap: 8px; }
    .list-item { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 12px; display: grid; gap: 7px; cursor: pointer; }
    .list-item.active { border-color: rgba(37, 99, 235, .55); box-shadow: 0 0 0 3px rgba(37, 99, 235, .09); }
    .toolbar, .actions, .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .row { justify-content: space-between; }
    .tag { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); color: var(--muted); border-radius: 999px; padding: 4px 8px; font-size: 12px; }
    .tag.ok { color: var(--ok); border-color: rgba(15, 159, 110, .35); }
    .tag.bad { color: var(--bad); border-color: rgba(214, 69, 69, .35); }
    .tag.warn { color: var(--warn); border-color: rgba(183, 121, 31, .35); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .table-wrap { max-width: 100%; overflow-x: auto; overflow-y: hidden; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; min-width: 960px; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 11px 10px; font-size: 13px; vertical-align: middle; }
    th { color: var(--muted); background: var(--panel-soft); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    tr:last-child td { border-bottom: 0; }
    .status { min-height: 20px; color: var(--muted); font-size: 13px; }
    .key-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center; border: 1px solid var(--line); border-radius: 8px; padding: 9px; }
    .empty { border: 1px dashed var(--line); border-radius: 8px; padding: 24px; color: var(--muted); text-align: center; }
    .bars { display: grid; gap: 8px; }
    .bar { display: grid; grid-template-columns: 140px minmax(0, 1fr) 70px; gap: 10px; align-items: center; }
    .track { height: 8px; border-radius: 99px; background: var(--panel-soft); overflow: hidden; }
    .track i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--ok)); }
    @media (max-width: 1180px) { .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 1040px) {
      .shell, .layout-projects { grid-template-columns: minmax(0, 1fr); }
      aside {
        position: sticky;
        top: 0;
        z-index: 3;
        height: auto;
        max-height: none;
        border-right: 0;
        border-bottom: 1px solid var(--line);
        display: grid;
        grid-template-columns: minmax(170px, 1fr) minmax(0, 1.8fr) auto auto;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
      }
      .brand h1 { font-size: 20px; margin-bottom: 2px; }
      .brand p { font-size: 12px; margin: 0; }
      nav { min-width: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .nav-btn { justify-content: center; white-space: nowrap; padding-left: 10px; padding-right: 10px; }
      .grid.three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 760px) {
      aside { grid-template-columns: 1fr; align-items: stretch; }
      nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      header { display: grid; }
      .stats, .grid.two, .grid.three { grid-template-columns: 1fr; }
      .bar { grid-template-columns: 1fr; }
    }
    @media (max-width: 420px) {
      main { padding: 12px; }
      aside { padding: 10px 12px; }
      nav { grid-template-columns: 1fr; }
      .actions { display: grid; grid-template-columns: 1fr; }
      .actions button { width: 100%; }
    }
  </style>
</head>
<body>
  <section id="gate" class="gate">
    <div class="gate-card">
      <div>
        <h1>HYHub</h1>
        <p class="muted">输入管理员密钥进入后台。</p>
      </div>
      <input id="token" type="password" placeholder="管理员密钥" />
      <button id="gate-submit">进入后台</button>
      <div class="status" id="gate-status"></div>
    </div>
  </section>

  <section id="app" class="shell hidden">
    <aside>
      <div class="brand">
        <h1>HYHub</h1>
        <p class="muted">项目隔离的 API Hub</p>
      </div>
      <nav>
        <button class="nav-btn active" data-page="dashboard">仪表盘</button>
        <button class="nav-btn" data-page="projects">项目</button>
        <button class="nav-btn" data-page="settings">设置</button>
      </nav>
      <button class="ghost" id="reload">刷新</button>
      <button class="danger" id="logout">退出</button>
    </aside>
    <main>
      <header>
        <div>
          <h2 id="page-title">仪表盘</h2>
          <div class="muted" id="page-desc">查看整体项目、账号池和调用健康。</div>
        </div>
        <span class="tag mono" id="base-url"></span>
      </header>

      <section id="page-dashboard" class="page active">
        <div class="stats">
          <div class="stat"><b id="dash-projects">0</b><span class="muted">项目</span></div>
          <div class="stat"><b id="dash-accounts">0</b><span class="muted">账号</span></div>
          <div class="stat"><b id="dash-available">0</b><span class="muted">可用账号</span></div>
          <div class="stat"><b id="dash-action">0</b><span class="muted">待处理</span></div>
          <div class="stat"><b id="dash-calls">0</b><span class="muted">调用</span></div>
          <div class="stat"><b id="dash-errors">0</b><span class="muted">失败</span></div>
        </div>
        <div class="grid two">
          <section class="panel">
            <div class="row"><h3>项目概览</h3><span class="muted">按账号数量排序</span></div>
            <div id="dashboard-projects" class="list" style="margin-top:12px"></div>
          </section>
          <section class="panel">
            <div class="row"><h3>最近 24 小时模型健康</h3><span class="muted">来自真实调用统计</span></div>
            <div id="model-health" class="bars" style="margin-top:12px"></div>
          </section>
        </div>
      </section>

      <section id="page-projects" class="page">
        <div class="layout-projects">
          <section class="panel">
            <div class="row"><h3>项目</h3><button id="new-project" class="ghost">新建</button></div>
            <div id="project-list" class="list" style="margin-top:12px"></div>
            <div class="status" id="project-status"></div>
          </section>
          <section class="grid">
            <div class="panel">
              <div class="row"><h3>项目信息</h3><span class="tag" id="selected-project-tag">未选择</span></div>
              <div class="grid two" style="margin-top:12px">
                <input id="project-id" placeholder="项目 ID（可留空）" />
                <input id="project-name" placeholder="项目名称" />
              </div>
              <label class="toolbar"><input id="project-enabled" type="checkbox" checked /> 启用项目</label>
              <div class="actions">
                <button id="save-project">保存项目</button>
                <button id="delete-project" class="danger">删除项目</button>
              </div>
            </div>
            <div class="panel">
              <div class="row"><h3>上游账号池</h3><button id="clear-account" class="ghost">清空表单</button></div>
              <div class="grid two" style="margin-top:12px">
                <input id="account-id" placeholder="账号 ID（可留空）" />
                <input id="account-label" placeholder="显示名称" />
                <input id="account-base-url" placeholder="上游 Base URL" />
                <input id="account-api-key" placeholder="上游 API Key（新账号必填）" />
                <input id="account-weight" type="number" min="1" max="20" step="1" placeholder="权重 1-20" />
                <select id="account-enabled"><option value="true">启用</option><option value="false">停用</option></select>
              </div>
              <textarea id="account-extra-headers" style="margin-top:10px" placeholder='额外请求头 JSON，例如 {"OpenAI-Organization":"org_xxx"}'></textarea>
              <div class="actions">
                <button id="save-account">保存账号</button>
                <button id="test-project-accounts" class="secondary">检测当前项目</button>
                <button id="batch-enable" class="ghost">批量启用</button>
                <button id="batch-disable" class="ghost">批量停用</button>
              </div>
              <div class="status" id="account-status"></div>
              <div id="accounts-table" style="margin-top:12px"></div>
            </div>
          </section>
        </div>
      </section>

      <section id="page-settings" class="page">
        <div class="grid two">
          <section class="panel">
            <h3>项目 API Key</h3>
            <p class="muted">客户端使用 Base URL 加项目 API Key 调用 /v1/*。AUTH_TOKEN 只用于管理员登录。</p>
            <select id="settings-project"></select>
            <div class="actions">
              <button id="create-key">创建 API Key</button>
              <button id="copy-base-url" class="secondary">复制 Base URL</button>
            </div>
            <div id="project-keys" class="list" style="margin-top:12px"></div>
            <div class="status" id="key-status"></div>
          </section>
          <section class="panel">
            <h3>路由策略</h3>
            <div class="grid two" style="margin-top:12px">
              <input id="max-retry-accounts" type="number" min="1" max="20" step="1" placeholder="失败重试账号数" />
              <label class="toolbar"><input id="disable-on-failure" type="checkbox" /> 真实代理失败后自动停用账号</label>
            </div>
            <div class="actions"><button id="save-routing">保存路由策略</button></div>
            <div class="status" id="routing-status"></div>
          </section>
          <section class="panel">
            <h3>开放模型</h3>
            <textarea id="open-models" placeholder="一行一个模型"></textarea>
            <div class="grid two" style="margin-top:10px">
              <input id="model-discovery-limit" type="number" min="1" max="50" step="1" value="8" placeholder="扫描账号数" />
              <input id="api-test-model" placeholder="账号检测模型，默认 gpt-4.1-mini" />
            </div>
            <div class="actions">
              <button id="discover-models" class="secondary">系统推荐模型</button>
              <button id="save-models">保存开放模型</button>
            </div>
            <div id="discovered-models" class="list" style="margin-top:12px"></div>
            <div class="status" id="model-status"></div>
          </section>
          <section class="panel">
            <h3>导入 / 导出 / 统计</h3>
            <p class="muted">导入导出作用于当前设置里选中的项目账号池；清空统计只清真实 API 调用统计。</p>
            <div class="actions">
              <button id="export-accounts" class="secondary">导出账号</button>
              <button id="import-accounts" class="secondary">导入账号</button>
              <button id="reset-stats" class="danger">清空统计</button>
            </div>
            <div class="status" id="ops-status"></div>
          </section>
        </div>
      </section>
    </main>
  </section>

  <script>
    const els = {
      gate: document.getElementById("gate"),
      app: document.getElementById("app"),
      token: document.getElementById("token"),
      gateStatus: document.getElementById("gate-status"),
      pageTitle: document.getElementById("page-title"),
      pageDesc: document.getElementById("page-desc"),
      baseUrl: document.getElementById("base-url"),
      projectList: document.getElementById("project-list"),
      dashboardProjects: document.getElementById("dashboard-projects"),
      modelHealth: document.getElementById("model-health"),
      projectStatus: document.getElementById("project-status"),
      accountStatus: document.getElementById("account-status"),
      accountsTable: document.getElementById("accounts-table"),
      settingsProject: document.getElementById("settings-project"),
      projectKeys: document.getElementById("project-keys"),
      keyStatus: document.getElementById("key-status"),
      routingStatus: document.getElementById("routing-status"),
      modelStatus: document.getElementById("model-status"),
      opsStatus: document.getElementById("ops-status"),
    };
    const pageMeta = {
      dashboard: ["仪表盘", "查看整体项目、账号池和调用健康。"],
      projects: ["项目", "切换项目并管理这个项目自己的上游账号池。"],
      settings: ["设置", "管理项目 API Key、路由策略、模型和导入导出。"],
    };
    let projects = [];
    let accounts = [];
    let summary = {};
    let publicStatus = {};
    let selectedProjectId = localStorage.getItem("hyhub-selected-project") || "default-rt";
    let selectedAccountIds = new Set();
    els.token.value = localStorage.getItem("hyhub-admin-token") || "";
    els.baseUrl.textContent = window.location.origin + "/v1";
    document.getElementById("api-test-model").value = localStorage.getItem("hyhub-api-test-model") || "gpt-4.1-mini";

    function getToken() { return els.token.value.trim(); }
    function status(el, message, danger) { el.textContent = message || ""; el.style.color = danger ? "var(--bad)" : "var(--muted)"; }
    function fmt(value) { const n = Number(value || 0); return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n); }
    function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function stateOf(account) {
      if (!account.enabled) return "disabled";
      if ((account.unhealthyUntil || 0) > Date.now() || account.health?.lastOk === false) return "attention";
      return "available";
    }
    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...(options.headers || {}), authorization: "Bearer " + getToken() } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
      return data;
    }
    function selectedProject() { return projects.find((project) => project.id === selectedProjectId) || projects[0] || null; }
    function projectPath(path) { return "/admin/projects/" + encodeURIComponent(selectedProjectId) + path; }
    function parseHeaders() {
      const raw = document.getElementById("account-extra-headers").value.trim();
      return raw ? JSON.parse(raw) : undefined;
    }
    function setPage(page) {
      document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.page === page));
      document.querySelectorAll(".page").forEach((section) => section.classList.toggle("active", section.id === "page-" + page));
      els.pageTitle.textContent = pageMeta[page][0];
      els.pageDesc.textContent = pageMeta[page][1];
      location.hash = page;
    }
    function renderDashboard() {
      document.getElementById("dash-projects").textContent = projects.length;
      document.getElementById("dash-accounts").textContent = summary.total || 0;
      document.getElementById("dash-available").textContent = summary.available || 0;
      document.getElementById("dash-action").textContent = summary.actionRequired || 0;
      document.getElementById("dash-calls").textContent = fmt(summary.calls || 0);
      document.getElementById("dash-errors").textContent = fmt(summary.errors || 0);
      els.dashboardProjects.innerHTML = projects.length ? projects
        .slice().sort((a, b) => (b.accountCount || 0) - (a.accountCount || 0))
        .map((project) => '<div class="list-item" onclick="selectProject(\\'' + escapeHtml(project.id) + '\\', true)"><div class="row"><b>' + escapeHtml(project.name) + '</b><span class="tag ' + (project.enabled ? 'ok' : 'warn') + '">' + (project.enabled ? '启用' : '停用') + '</span></div><div class="muted mono">' + escapeHtml(project.id) + '</div><div class="muted">账号 ' + (project.accountCount || 0) + ' / API Key ' + (project.keyCount || 0) + '</div></div>')
        .join("") : '<div class="empty">暂无项目。</div>';
      const modelHealth = publicStatus.modelHealth || [];
      els.modelHealth.innerHTML = modelHealth.length ? modelHealth.map((item) => {
        const pct = Math.max(2, Number(item.successRate || 0));
        return '<div class="bar"><span class="mono">' + escapeHtml(item.model) + '</span><div class="track"><i style="width:' + pct + '%"></i></div><span class="muted">' + (item.calls || 0) + ' 次</span></div>';
      }).join("") : '<div class="empty">暂无模型调用统计。</div>';
    }
    function renderProjects() {
      els.projectList.innerHTML = projects.map((project) => '<div class="list-item ' + (project.id === selectedProjectId ? 'active' : '') + '" onclick="selectProject(\\'' + escapeHtml(project.id) + '\\')"><div class="row"><b>' + escapeHtml(project.name) + '</b><span class="tag ' + (project.enabled ? 'ok' : 'warn') + '">' + (project.enabled ? '启用' : '停用') + '</span></div><div class="muted mono">' + escapeHtml(project.id) + '</div><div class="muted">账号 ' + (project.accountCount || 0) + ' / Key ' + (project.keyCount || 0) + '</div></div>').join("");
      const project = selectedProject();
      document.getElementById("selected-project-tag").textContent = project ? project.id : "未选择";
      document.getElementById("project-id").value = project?.id || "";
      document.getElementById("project-id").disabled = !!project;
      document.getElementById("project-name").value = project?.name || "";
      document.getElementById("project-enabled").checked = project?.enabled !== false;
      els.settingsProject.innerHTML = projects.map((item) => '<option value="' + escapeHtml(item.id) + '" ' + (item.id === selectedProjectId ? 'selected' : '') + '>' + escapeHtml(item.name) + '</option>').join("");
      renderKeys();
    }
    function renderAccounts() {
      selectedAccountIds = new Set([...selectedAccountIds].filter((id) => accounts.some((account) => account.id === id)));
      if (!accounts.length) {
        els.accountsTable.innerHTML = '<div class="empty">当前项目还没有账号。</div>';
        return;
      }
      els.accountsTable.innerHTML = '<div class="table-wrap"><table><thead><tr><th></th><th>账号</th><th>状态</th><th>真实调用</th><th>检测</th><th>操作</th></tr></thead><tbody>' + accounts.map((account) => {
        const state = stateOf(account);
        const successRate = account.stats?.calls ? Math.round(((account.stats.successes || 0) / account.stats.calls) * 100) + "%" : "--";
        const lastCheck = account.health?.lastCheckedAt ? new Date(account.health.lastCheckedAt).toLocaleString() : "未检测";
        const tag = state === "available" ? '<span class="tag ok">可用</span>' : state === "attention" ? '<span class="tag bad">需处理</span>' : '<span class="tag warn">停用</span>';
        return '<tr><td><input type="checkbox" data-check="' + escapeHtml(account.id) + '" ' + (selectedAccountIds.has(account.id) ? 'checked' : '') + ' /></td><td><b>' + escapeHtml(account.label) + '</b><div class="muted mono">' + escapeHtml(account.id) + '</div><div class="muted mono">' + escapeHtml(account.baseUrl) + '</div></td><td>' + tag + '<div class="muted">权重 ' + (account.weight || 1) + '</div></td><td><div class="mono">' + (account.stats?.calls || 0) + ' 次</div><div class="muted">成功 ' + (account.stats?.successes || 0) + ' / 失败 ' + (account.stats?.errors || 0) + ' / ' + successRate + '</div></td><td><div class="mono">' + (account.health?.checks || 0) + ' 次</div><div class="muted">' + lastCheck + '</div></td><td><div class="actions"><button class="ghost" onclick="editAccount(\\'' + escapeHtml(account.id) + '\\')">编辑</button><button class="ghost" onclick="testAccount(\\'' + escapeHtml(account.id) + '\\')">检测</button><button class="ghost" onclick="toggleAccount(\\'' + escapeHtml(account.id) + '\\',' + (!account.enabled) + ')">' + (account.enabled ? '停用' : '启用') + '</button><button class="danger" onclick="removeAccount(\\'' + escapeHtml(account.id) + '\\')">删除</button></div></td></tr>';
      }).join("") + '</tbody></table></div>';
      document.querySelectorAll("[data-check]").forEach((input) => input.addEventListener("change", (event) => {
        const id = event.target.getAttribute("data-check");
        if (event.target.checked) selectedAccountIds.add(id);
        else selectedAccountIds.delete(id);
      }));
    }
    function renderKeys() {
      const project = selectedProject();
      if (!project) {
        els.projectKeys.innerHTML = '<div class="empty">先创建项目。</div>';
        return;
      }
      els.projectKeys.innerHTML = project.apiKeys?.length ? project.apiKeys.map((key) => '<div class="key-row"><span class="mono">' + escapeHtml(key) + '</span><button class="ghost" onclick="copyKey(\\'' + escapeHtml(key) + '\\')">复制</button><button class="danger" onclick="deleteKey(\\'' + escapeHtml(key) + '\\')">删除</button></div>').join("") : '<div class="empty">当前项目还没有 API Key。</div>';
    }
    async function refreshAll() {
      const verify = await api("/admin/verify");
      projects = verify.projects || [];
      summary = verify.summary || {};
      if (!projects.some((project) => project.id === selectedProjectId)) selectedProjectId = projects[0]?.id || "default-rt";
      await loadProjectAccounts();
      await Promise.all([loadRouting(), loadModels(), loadPublicStatus()]);
      renderDashboard();
      renderProjects();
      renderAccounts();
    }
    async function loadProjectAccounts() {
      if (!selectedProjectId) return;
      const data = await api(projectPath("/accounts"));
      accounts = data.accounts || [];
    }
    async function loadPublicStatus() {
      publicStatus = await fetch("/public/status").then((res) => res.json()).catch(() => ({}));
    }
    async function loadRouting() {
      const data = await api("/admin/routing");
      document.getElementById("max-retry-accounts").value = data.routing?.maxRetryAccounts || 3;
      document.getElementById("disable-on-failure").checked = data.routing?.disableOnFailure === true;
    }
    async function loadModels() {
      const data = await api("/admin/models");
      document.getElementById("open-models").value = (data.models || []).join("\\n");
    }
    async function verifyLogin() {
      try {
        localStorage.setItem("hyhub-admin-token", getToken());
        status(els.gateStatus, "验证中...");
        els.gate.classList.add("hidden");
        els.app.classList.remove("hidden");
        await refreshAll();
        setPage((location.hash || "#dashboard").slice(1) in pageMeta ? (location.hash || "#dashboard").slice(1) : "dashboard");
        status(els.gateStatus, "");
      } catch (error) {
        els.app.classList.add("hidden");
        els.gate.classList.remove("hidden");
        status(els.gateStatus, error.message, true);
      }
    }
    window.selectProject = async function(id, goProjects) {
      selectedProjectId = id;
      localStorage.setItem("hyhub-selected-project", id);
      await loadProjectAccounts();
      renderProjects();
      renderAccounts();
      if (goProjects) setPage("projects");
    };
    async function saveProject() {
      try {
        const id = document.getElementById("project-id").value.trim();
        const existing = projects.some((project) => project.id === id);
        const payload = { id: existing ? undefined : id || undefined, name: document.getElementById("project-name").value.trim() || undefined, enabled: document.getElementById("project-enabled").checked };
        const data = await api(existing ? "/admin/projects/" + encodeURIComponent(id) : "/admin/projects", { method: existing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        selectedProjectId = data.project.id;
        await refreshAll();
        status(els.projectStatus, "项目已保存。");
      } catch (error) { status(els.projectStatus, error.message, true); }
    }
    async function deleteProject() {
      const project = selectedProject();
      if (!project) return;
      const message = project.id === "default-rt" ? "这是默认 RT 项目，确认删除？删除后系统会在下次读取时重新创建空默认项目。" : "确认删除这个项目？";
      if (!confirm(message)) return;
      try {
        await api("/admin/projects/" + encodeURIComponent(project.id), { method: "DELETE" });
        selectedProjectId = "default-rt";
        await refreshAll();
        status(els.projectStatus, "项目已删除。");
      } catch (error) { status(els.projectStatus, error.message, true); }
    }
    function clearAccountForm() {
      ["account-id", "account-label", "account-base-url", "account-api-key", "account-weight", "account-extra-headers"].forEach((id) => document.getElementById(id).value = "");
      document.getElementById("account-enabled").value = "true";
    }
    async function saveAccount() {
      try {
        const id = document.getElementById("account-id").value.trim();
        const existing = accounts.some((account) => account.id === id);
        const payload = {
          id: existing ? undefined : id || undefined,
          label: document.getElementById("account-label").value.trim(),
          baseUrl: document.getElementById("account-base-url").value.trim(),
          apiKey: document.getElementById("account-api-key").value.trim(),
          weight: Number(document.getElementById("account-weight").value || 1),
          enabled: document.getElementById("account-enabled").value === "true",
          extraHeaders: parseHeaders(),
        };
        await api(existing ? projectPath("/accounts/" + encodeURIComponent(id)) : projectPath("/accounts"), { method: existing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        clearAccountForm();
        await refreshAll();
        status(els.accountStatus, "账号已保存。");
      } catch (error) { status(els.accountStatus, error.message, true); }
    }
    window.editAccount = function(id) {
      const account = accounts.find((item) => item.id === id);
      if (!account) return;
      document.getElementById("account-id").value = account.id;
      document.getElementById("account-label").value = account.label || "";
      document.getElementById("account-base-url").value = account.baseUrl || "";
      document.getElementById("account-api-key").value = "";
      document.getElementById("account-weight").value = account.weight || 1;
      document.getElementById("account-enabled").value = account.enabled ? "true" : "false";
      document.getElementById("account-extra-headers").value = JSON.stringify(account.extraHeaders || {}, null, 2);
    };
    window.toggleAccount = async function(id, enabled) {
      await api(projectPath("/accounts/" + encodeURIComponent(id)), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
      await refreshAll();
    };
    window.testAccount = async function(id) {
      try {
        const model = document.getElementById("api-test-model").value.trim() || "gpt-4.1-mini";
        const data = await api(projectPath("/accounts/" + encodeURIComponent(id) + "/test"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "chat", model }) });
        status(els.accountStatus, data.message || "检测通过。");
        await refreshAll();
      } catch (error) { status(els.accountStatus, error.message, true); }
    };
    window.removeAccount = async function(id) {
      if (!confirm("确认删除这个账号？")) return;
      await api(projectPath("/accounts/" + encodeURIComponent(id)), { method: "DELETE" });
      await refreshAll();
    };
    async function batchToggle(enabled) {
      if (!selectedAccountIds.size) return status(els.accountStatus, "先选择账号。", true);
      await api(projectPath("/accounts/batch"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [...selectedAccountIds], enabled }) });
      selectedAccountIds.clear();
      await refreshAll();
    }
    async function createKey() {
      try {
        const data = await api("/admin/projects/" + encodeURIComponent(selectedProjectId) + "/keys", { method: "POST" });
        await navigator.clipboard.writeText(data.key).catch(() => {});
        await refreshAll();
        status(els.keyStatus, "API Key 已创建并尝试复制。");
      } catch (error) { status(els.keyStatus, error.message, true); }
    }
    window.copyKey = async function(key) { await navigator.clipboard.writeText(key); status(els.keyStatus, "API Key 已复制。"); };
    window.deleteKey = async function(key) {
      if (!confirm("确认删除这个 API Key？")) return;
      await api("/admin/projects/" + encodeURIComponent(selectedProjectId) + "/keys/" + encodeURIComponent(key), { method: "DELETE" });
      await refreshAll();
    };
    async function saveRouting() {
      try {
        await api("/admin/routing", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxRetryAccounts: Number(document.getElementById("max-retry-accounts").value || 3), disableOnFailure: document.getElementById("disable-on-failure").checked }) });
        status(els.routingStatus, "路由策略已保存。");
      } catch (error) { status(els.routingStatus, error.message, true); }
    }
    async function saveModels() {
      try {
        const models = document.getElementById("open-models").value.split(/[\\n,]+/).map((item) => item.trim()).filter(Boolean);
        await api("/admin/models", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ models }) });
        status(els.modelStatus, "开放模型已保存。");
      } catch (error) { status(els.modelStatus, error.message, true); }
    }
    async function discoverModels() {
      try {
        const limit = Number(document.getElementById("model-discovery-limit").value || 8);
        const data = await api("/admin/models/discover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit }) });
        document.getElementById("discovered-models").innerHTML = (data.recommendations || []).map((item) => '<div class="list-item" onclick="addModel(\\'' + escapeHtml(item.model) + '\\')"><b class="mono">' + escapeHtml(item.model) + '</b><span class="muted">' + (item.accounts?.length || 0) + ' 个账号返回</span></div>').join("") || '<div class="empty">没有发现模型。</div>';
        status(els.modelStatus, "扫描完成。点击候选模型可加入列表。");
      } catch (error) { status(els.modelStatus, error.message, true); }
    }
    window.addModel = function(model) {
      const input = document.getElementById("open-models");
      const items = new Set(input.value.split(/[\\n,]+/).map((item) => item.trim()).filter(Boolean));
      items.add(model);
      input.value = [...items].join("\\n");
    };
    async function exportAccounts() {
      const data = await api(projectPath("/accounts/export"));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = selectedProjectId + "-accounts.json";
      link.click();
      URL.revokeObjectURL(url);
      status(els.opsStatus, "账号已导出。");
    }
    async function importAccounts() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const payload = JSON.parse(await file.text());
        await api(projectPath("/accounts/import"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        await refreshAll();
        status(els.opsStatus, "账号已导入。");
      };
      input.click();
    }
    async function resetStats() {
      if (!confirm("确认清空真实 API 调用统计？")) return;
      await api("/admin/stats/reset", { method: "POST" });
      await refreshAll();
      status(els.opsStatus, "统计已清空。");
    }
    document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => setPage(btn.dataset.page)));
    document.getElementById("gate-submit").addEventListener("click", verifyLogin);
    els.token.addEventListener("keydown", (event) => { if (event.key === "Enter") verifyLogin(); });
    document.getElementById("reload").addEventListener("click", refreshAll);
    document.getElementById("logout").addEventListener("click", () => { localStorage.removeItem("hyhub-admin-token"); location.reload(); });
    document.getElementById("new-project").addEventListener("click", () => { selectedProjectId = ""; document.getElementById("project-id").disabled = false; document.getElementById("project-id").value = ""; document.getElementById("project-name").value = ""; document.getElementById("project-enabled").checked = true; });
    document.getElementById("save-project").addEventListener("click", saveProject);
    document.getElementById("delete-project").addEventListener("click", deleteProject);
    document.getElementById("clear-account").addEventListener("click", clearAccountForm);
    document.getElementById("save-account").addEventListener("click", saveAccount);
    document.getElementById("test-project-accounts").addEventListener("click", async () => { const data = await api(projectPath("/accounts/test-all"), { method: "POST" }); status(els.accountStatus, "检测完成：" + (data.okCount || 0) + "/" + (data.total || 0) + " 可用。"); await refreshAll(); });
    document.getElementById("batch-enable").addEventListener("click", () => batchToggle(true));
    document.getElementById("batch-disable").addEventListener("click", () => batchToggle(false));
    document.getElementById("settings-project").addEventListener("change", async (event) => { await window.selectProject(event.target.value); renderKeys(); });
    document.getElementById("create-key").addEventListener("click", createKey);
    document.getElementById("copy-base-url").addEventListener("click", async () => { await navigator.clipboard.writeText(window.location.origin + "/v1"); status(els.keyStatus, "Base URL 已复制。"); });
    document.getElementById("save-routing").addEventListener("click", saveRouting);
    document.getElementById("save-models").addEventListener("click", saveModels);
    document.getElementById("discover-models").addEventListener("click", discoverModels);
    document.getElementById("export-accounts").addEventListener("click", exportAccounts);
    document.getElementById("import-accounts").addEventListener("click", importAccounts);
    document.getElementById("reset-stats").addEventListener("click", resetStats);
    document.getElementById("api-test-model").addEventListener("change", (event) => localStorage.setItem("hyhub-api-test-model", event.target.value));
    if (getToken()) verifyLogin();
    else status(els.gateStatus, "先输入管理员密钥。");
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
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/health") return json({ ok: true });
    if (pathname === "/") return html(renderMonitorPage());
    if (pathname === "/admin" || pathname === "/admin/") return html(renderAdminPageV2());
    if (pathname === "/admin/ui") {
      url.pathname = "/admin";
      return Response.redirect(url.toString(), 302);
    }
    const stub = env.ROUTER_STATE.getByName("router");
    return stub.fetch(request);
  },
};

export class RouterState extends DurableObject<Env> {
  private accountsCache: AccountRecord[] | null = null;
  private statsCache: Record<string, AccountStat> | null = null;
  private healthCache: Record<string, AccountHealth> | null = null;
  private routingCache: RoutingSettings | null = null;
  private modelsCache: ModelSettings | null = null;
  private modelHourlyCache: ModelHourlyStats | null = null;
  private projectsCache: ProjectRecord[] | null = null;

  private async getAccounts(): Promise<AccountRecord[]> {
    if (this.accountsCache) return this.accountsCache;
    const saved = await this.ctx.storage.get<Array<AccountRecord & { projectId?: string }>>(ACCOUNTS_KEY);
    const accounts = Array.isArray(saved)
      ? saved.map((account) => ({ ...account, projectId: account.projectId || DEFAULT_PROJECT_ID }))
      : [];
    const changed = Array.isArray(saved) && saved.some((account) => !account.projectId);
    this.accountsCache = accounts;
    if (changed) await this.ctx.storage.put(ACCOUNTS_KEY, accounts);
    return this.accountsCache;
  }

  private async saveAccounts(accounts: AccountRecord[]): Promise<void> {
    this.accountsCache = accounts;
    await this.ctx.storage.put(ACCOUNTS_KEY, accounts);
  }

  private async getProjects(): Promise<ProjectRecord[]> {
    if (this.projectsCache) return this.projectsCache;
    const saved = await this.ctx.storage.get<Array<ProjectRecord & { accountIds?: string[] }>>(PROJECTS_KEY);
    let projects = Array.isArray(saved)
      ? saved.map((project) => ({
        id: project.id,
        name: project.name,
        enabled: project.enabled !== false,
        apiKeys: Array.isArray(project.apiKeys) ? project.apiKeys : [],
        createdAt: project.createdAt ?? Date.now(),
        updatedAt: project.updatedAt ?? Date.now(),
      }))
      : [];
    const existingDefault = projects.find((project) => project.id === DEFAULT_PROJECT_ID);
    if (existingDefault) {
      existingDefault.name = existingDefault.name || DEFAULT_PROJECT_NAME;
    } else {
      projects = [createDefaultProject(), ...projects];
    }
    this.projectsCache = projects;
    if (!Array.isArray(saved) || !saved.some((project) => project.id === DEFAULT_PROJECT_ID) || saved.some((project) => "accountIds" in project)) {
      await this.ctx.storage.put(PROJECTS_KEY, projects);
    }
    return this.projectsCache;
  }

  private async saveProjects(projects: ProjectRecord[]): Promise<void> {
    this.projectsCache = projects;
    await this.ctx.storage.put(PROJECTS_KEY, projects);
  }

  private async findProjectByApiKey(apiKey: string): Promise<ProjectRecord | null> {
    if (!apiKey.trim()) return null;
    const projects = await this.getProjects();
    return projects.find((project) => project.enabled && project.apiKeys.includes(apiKey)) ?? null;
  }

  private async getProjectOrNotFound(projectId: string): Promise<ProjectRecord | Response> {
    const projects = await this.getProjects();
    const project = projects.find((item) => item.id === projectId);
    return project ?? json({ error: "Project not found" }, { status: 404 });
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

  private async getRoutingSettings(): Promise<RoutingSettings> {
    if (this.routingCache) return this.routingCache;
    const saved = await this.ctx.storage.get<Partial<RoutingSettings>>(ROUTING_KEY);
    this.routingCache = {
      ...createDefaultRouting(this.env.MAX_RETRY_ACCOUNTS),
      ...(saved && typeof saved === "object" ? saved : {}),
    };
    this.routingCache.maxRetryAccounts = normalizeWeight(this.routingCache.maxRetryAccounts);
    this.routingCache.disableOnFailure = this.routingCache.disableOnFailure === true;
    return this.routingCache;
  }

  private async saveRoutingSettings(settings: RoutingSettings): Promise<void> {
    this.routingCache = {
      maxRetryAccounts: normalizeWeight(settings.maxRetryAccounts),
      disableOnFailure: settings.disableOnFailure === true,
    };
    await this.ctx.storage.put(ROUTING_KEY, this.routingCache);
  }

  private async getModelSettings(): Promise<ModelSettings> {
    if (this.modelsCache) return this.modelsCache;
    const saved = await this.ctx.storage.get<Partial<ModelSettings>>(MODELS_KEY);
    this.modelsCache = {
      models: normalizeModelList(saved?.models),
    };
    return this.modelsCache;
  }

  private async saveModelSettings(settings: ModelSettings): Promise<void> {
    this.modelsCache = {
      models: normalizeModelList(settings.models),
    };
    await this.ctx.storage.put(MODELS_KEY, this.modelsCache);
  }

  private async getModelHourlyStats(): Promise<ModelHourlyStats> {
    if (this.modelHourlyCache) return this.modelHourlyCache;
    const saved = await this.ctx.storage.get<ModelHourlyStats>(MODEL_HOURLY_KEY);
    this.modelHourlyCache = saved && typeof saved === "object" ? saved : {};
    return this.modelHourlyCache;
  }

  private async saveModelHourlyStats(stats: ModelHourlyStats): Promise<void> {
    this.modelHourlyCache = stats;
    await this.ctx.storage.put(MODEL_HOURLY_KEY, stats);
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

  private async disableAccount(id: string): Promise<void> {
    const accounts = await this.getAccounts();
    const target = accounts.find((item) => item.id === id);
    if (!target) return;
    target.enabled = false;
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

  private async recordModelHourlyResult(model: string | null, status: number, durationMs: number): Promise<void> {
    const normalized = model?.trim();
    if (!normalized) return;
    const stats = await this.getModelHourlyStats();
    const key = hourKey();
    const modelStats = stats[normalized] ?? {};
    const bucket = modelStats[key] ?? createEmptyModelBucket();
    bucket.calls += 1;
    bucket.lastStatus = status;
    bucket.totalDurationMs += durationMs;
    bucket.avgDurationMs = bucket.calls > 0 ? Math.round(bucket.totalDurationMs / bucket.calls) : 0;
    if (status >= 200 && status < 500) bucket.successes += 1;
    else bucket.errors += 1;
    modelStats[key] = bucket;

    const keep = new Set(lastHourKeys(48));
    for (const oldKey of Object.keys(modelStats)) {
      if (!keep.has(oldKey)) delete modelStats[oldKey];
    }
    stats[normalized] = modelStats;
    await this.saveModelHourlyStats(stats);
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

  private async getAccountsWithStats(projectId?: string): Promise<PublicAccount[]> {
    const [accounts, statsMap, healthMap] = await Promise.all([
      this.getAccounts(),
      this.getStatsMap(),
      this.getHealthMap(),
    ]);
    return accounts
    .filter((account) => !projectId || account.projectId === projectId)
    .map((account) => toPublicAccount(
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

  private async discoverAccountModels(account: AccountRecord): Promise<{
    accountId: string;
    label: string;
    ok: boolean;
    status?: number;
    models: string[];
    error?: string;
  }> {
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
        return { accountId: account.id, label: account.label, ok: false, status: response.status, models: [], error: `HTTP ${response.status}` };
      }
      const data = await response.json().catch(() => ({}));
      const rawModels = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data.map((item: { id?: unknown }) => item?.id)
          : [];
      const models = normalizeModelList(rawModels);
      await this.markHealthy(account.id);
      await this.recordHealthResult(account.id, true, response.status, "health");
      return { accountId: account.id, label: account.label, ok: true, status: response.status, models };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markUnhealthy(account.id);
      await this.recordHealthResult(account.id, false, null, "health", message);
      return { accountId: account.id, label: account.label, ok: false, models: [], error: message };
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

  private async pickAccount(excluded: Set<string> = new Set(), allowedAccountIds?: Set<string>): Promise<AccountRecord | null> {
    const accounts = await this.getAccounts();
    const now = Date.now();
    const enabled = accounts.filter((item) => (
      item.enabled
      && !excluded.has(item.id)
      && (!allowedAccountIds || allowedAccountIds.has(item.id))
    ));
    const healthy = enabled.filter((item) => (item.unhealthyUntil ?? 0) <= now);
    const pool = healthy.length > 0 ? healthy : enabled;
    if (pool.length === 0) return null;
    const weightedPool = pool.flatMap((account) => Array.from({ length: normalizeWeight(account.weight) }, () => account));
    const cursor = await this.getCursor();
    const account = weightedPool[cursor % weightedPool.length];
    await this.setCursor(cursor + 1);
    return account;
  }

  private async pickProjectAccount(projectId: string, excluded: Set<string> = new Set()): Promise<AccountRecord | null> {
    const accounts = await this.getAccounts();
    const now = Date.now();
    const enabled = accounts.filter((item) => item.projectId === projectId && item.enabled && !excluded.has(item.id));
    const healthy = enabled.filter((item) => (item.unhealthyUntil ?? 0) <= now);
    const pool = healthy.length > 0 ? healthy : enabled;
    if (pool.length === 0) return null;
    const weightedPool = pool.flatMap((account) => Array.from({ length: normalizeWeight(account.weight) }, () => account));
    const cursor = await this.getCursor();
    const account = weightedPool[cursor % weightedPool.length];
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
    const project = await this.findProjectByApiKey(getBearer(request));
    if (!project) return json({ error: "Invalid project API key" }, { status: 401 });
    const requestUrl = new URL(request.url);
    if (!requestUrl.pathname.startsWith("/v1/")) {
      return json({ error: "Only /v1/* routes are supported" }, { status: 404 });
    }
    const modelSettings = await this.getModelSettings();
    if (request.method === "GET" && requestUrl.pathname === "/v1/models" && modelSettings.models.length > 0) {
      return json({
        object: "list",
        data: modelSettings.models.map((id) => ({ id, object: "model", owned_by: "hyhub" })),
      });
    }
    const requestBody = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
    let requestedModel: string | null = null;
    const modelRequestPaths = new Set(["/v1/chat/completions", "/v1/responses", "/v1/embeddings"]);
    if (requestBody && modelRequestPaths.has(requestUrl.pathname)) {
      let payload: { model?: string };
      try {
        payload = JSON.parse(new TextDecoder().decode(requestBody)) as { model?: string };
      } catch {
        return json({ error: "Invalid JSON body" }, { status: 400 });
      }
      requestedModel = typeof payload.model === "string" ? payload.model.trim() : "";
      if (modelSettings.models.length > 0) {
        if (!requestedModel || !modelSettings.models.includes(requestedModel)) {
          return json({
            error: "Model is not enabled",
            model: requestedModel || null,
            allowedModels: modelSettings.models,
          }, { status: 403 });
        }
      }
    }
    const excluded = new Set<string>();
    const routing = await this.getRoutingSettings();
    const enabledCount = (await this.getAccounts()).filter((item) => item.projectId === project.id && item.enabled).length;
    const maxAttempts = Math.max(1, Math.min(routing.maxRetryAccounts, enabledCount || routing.maxRetryAccounts));
    let attempts = 0;
    while (true) {
      if (attempts >= maxAttempts) {
        return json({ error: "Retry limit reached", attempts, maxAttempts }, { status: 502 });
      }
      const account = await this.pickProjectAccount(project.id, excluded);
      if (!account) return json({ error: "No available accounts" }, { status: 503 });
      attempts += 1;
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
        if (isAccountFailureStatus(upstream.status)) {
          excluded.add(account.id);
          await this.markUnhealthy(account.id);
          await this.recordProxyResult(account.id, upstream.status, Date.now() - startedAt, `HTTP ${upstream.status}`);
          await this.recordModelHourlyResult(requestedModel, upstream.status, Date.now() - startedAt);
          if (routing.disableOnFailure) await this.disableAccount(account.id);
          if (excluded.size >= enabledCount || attempts >= maxAttempts) {
            return this.withProxyHeaders(upstream, account.id);
          }
          continue;
        }
        await this.markHealthy(account.id);
        await this.recordProxyResult(account.id, upstream.status, Date.now() - startedAt);
        await this.recordModelHourlyResult(requestedModel, upstream.status, Date.now() - startedAt);
        return this.withProxyHeaders(upstream, account.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        excluded.add(account.id);
        await this.markUnhealthy(account.id);
        await this.recordProxyResult(account.id, 502, Date.now() - startedAt, message);
        await this.recordModelHourlyResult(requestedModel, 502, Date.now() - startedAt);
        if (routing.disableOnFailure) await this.disableAccount(account.id);
        if (excluded.size >= enabledCount || attempts >= maxAttempts) {
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
      const [projects, accounts, statsMap, healthMap] = await Promise.all([
        this.getProjects(),
        this.getAccounts(),
        this.getStatsMap(),
        this.getHealthMap(),
      ]);
      return json({ ok: true, projects: projects.map((project) => toPublicProject(project, accounts.filter((account) => account.projectId === project.id).length)), summary: summarizeAccounts(accounts, statsMap, healthMap) });
    }

    const legacyAccountsMatch = pathname.match(/^\/admin\/accounts(?:\/([^/]+))?(?:\/(test))?$/);
    const projectAccountsRootMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/accounts$/);
    const projectAccountsBatchMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/accounts\/batch$/);
    const projectAccountsTestAllMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/accounts\/test-all$/);
    const projectAccountItemMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/accounts\/([^/]+)$/);
    const projectAccountTestMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/accounts\/([^/]+)\/test$/);

    const listProjectId = projectAccountsRootMatch?.[1]
      ? decodeURIComponent(projectAccountsRootMatch[1])
      : pathname === "/admin/accounts"
        ? DEFAULT_PROJECT_ID
        : "";

    if (listProjectId && request.method === "GET") {
      const project = await this.getProjectOrNotFound(listProjectId);
      if (project instanceof Response) return project;
      const [accounts, statsMap, healthMap, records] = await Promise.all([
        this.getAccounts(),
        this.getStatsMap(),
        this.getHealthMap(),
        this.getAccountsWithStats(listProjectId),
      ]);
      const scoped = accounts.filter((account) => account.projectId === listProjectId);
      return json({ accounts: records, summary: summarizeAccounts(scoped, statsMap, healthMap), project: toPublicProject(project, scoped.length) });
    }

    if (listProjectId && request.method === "POST") {
      const project = await this.getProjectOrNotFound(listProjectId);
      if (project instanceof Response) return project;
      const payload = sanitizeAccountInput(await readJsonBody<AccountInput>(request), listProjectId);
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

    if ((pathname === "/admin/accounts/export" || pathname.match(/^\/admin\/projects\/([^/]+)\/accounts\/export$/)) && request.method === "GET") {
      const projectId = pathname === "/admin/accounts/export" ? DEFAULT_PROJECT_ID : decodeURIComponent(pathname.match(/^\/admin\/projects\/([^/]+)\/accounts\/export$/)?.[1] || DEFAULT_PROJECT_ID);
      const accounts = await this.getAccounts();
      const scoped = accounts.filter((account) => account.projectId === projectId);
      return json({
        exportedAt: Date.now(),
        projectId,
        accounts: scoped.map((account) => ({
          id: account.id,
          projectId: account.projectId,
          label: account.label,
          baseUrl: account.baseUrl,
          apiKey: account.apiKey,
          enabled: account.enabled,
          weight: normalizeWeight(account.weight),
          extraHeaders: account.extraHeaders ?? {},
        })),
      });
    }

    const importProjectMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/accounts\/import$/);
    if ((pathname === "/admin/accounts/import" || importProjectMatch) && request.method === "POST") {
      const projectId = importProjectMatch ? decodeURIComponent(importProjectMatch[1]) : DEFAULT_PROJECT_ID;
      const project = await this.getProjectOrNotFound(projectId);
      if (project instanceof Response) return project;
      const payload = await readJsonBody<{ accounts?: AccountInput[] }>(request);
      const incoming = Array.isArray(payload.accounts) ? payload.accounts : [];
      const accounts = await this.getAccounts();
      const next = [...accounts];
      let imported = 0;

      for (const item of incoming) {
        const normalized = sanitizeAccountInput(item, projectId);
        const index = next.findIndex((existing) => existing.id === normalized.id);
        if (index >= 0) next[index] = normalized;
        else next.push(normalized);
        imported += 1;
      }

      await this.saveAccounts(next);
      return json({ ok: true, imported });
    }

    const batchProjectId = projectAccountsBatchMatch?.[1]
      ? decodeURIComponent(projectAccountsBatchMatch[1])
      : pathname === "/admin/accounts/batch"
        ? DEFAULT_PROJECT_ID
        : "";
    if (batchProjectId && request.method === "PATCH") {
      const payload = await readJsonBody<{ ids: string[]; enabled: boolean }>(request);
      const ids = new Set(payload.ids ?? []);
      const accounts = await this.getAccounts();
      let changed = 0;
      for (const account of accounts) {
        if (account.projectId !== batchProjectId) continue;
        if (!ids.has(account.id)) continue;
        account.enabled = payload.enabled;
        changed += 1;
      }
      await this.saveAccounts(accounts);
      return json({ ok: true, changed });
    }

    if (pathname === "/admin/projects" && request.method === "GET") {
      const [projects, accounts] = await Promise.all([this.getProjects(), this.getAccounts()]);
      return json({ projects: projects.map((project) => toPublicProject(project, accounts.filter((account) => account.projectId === project.id).length)) });
    }

    if (pathname === "/admin/projects" && request.method === "POST") {
      const payload = await readJsonBody<ProjectInput>(request);
      const project = sanitizeProjectInput(payload);
      const projects = await this.getProjects();
      const next = projects.filter((item) => item.id !== project.id);
      next.push(project);
      await this.saveProjects(next);
      return json({ ok: true, project: toPublicProject(project, 0) }, { status: 201 });
    }

    const projectKeyMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/keys\/([^/]+)$/);
    const projectGenerateKeyMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/keys$/);
    const projectMatch = pathname.match(/^\/admin\/projects\/([^/]+)$/);
    if (projectGenerateKeyMatch && request.method === "POST") {
      const projectId = decodeURIComponent(projectGenerateKeyMatch[1]);
      const projects = await this.getProjects();
      const project = projects.find((item) => item.id === projectId);
      if (!project) return json({ error: "Project not found" }, { status: 404 });
      const key = generateProjectApiKey();
      project.apiKeys.push(key);
      project.updatedAt = Date.now();
      await this.saveProjects(projects);
      const accounts = await this.getAccounts();
      return json({ ok: true, key, project: toPublicProject(project, accounts.filter((account) => account.projectId === project.id).length) }, { status: 201 });
    }

    if (projectKeyMatch && request.method === "DELETE") {
      const projectId = decodeURIComponent(projectKeyMatch[1]);
      const key = decodeURIComponent(projectKeyMatch[2]);
      const projects = await this.getProjects();
      const project = projects.find((item) => item.id === projectId);
      if (!project) return json({ error: "Project not found" }, { status: 404 });
      project.apiKeys = project.apiKeys.filter((item) => item !== key);
      project.updatedAt = Date.now();
      await this.saveProjects(projects);
      const accounts = await this.getAccounts();
      return json({ ok: true, project: toPublicProject(project, accounts.filter((account) => account.projectId === project.id).length) });
    }

    if (projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]);
      const projects = await this.getProjects();
      const project = projects.find((item) => item.id === projectId);
      if (!project) return json({ error: "Project not found" }, { status: 404 });

      if (request.method === "GET") {
        const accounts = await this.getAccounts();
        return json({ project: toPublicProject(project, accounts.filter((account) => account.projectId === project.id).length) });
      }

      if (request.method === "PATCH") {
        const payload = await readJsonBody<ProjectInput>(request);
        const next = sanitizeProjectInput({ ...payload, id: project.id }, project);
        const index = projects.findIndex((item) => item.id === project.id);
        projects[index] = next;
        await this.saveProjects(projects);
        const accounts = await this.getAccounts();
        return json({ ok: true, project: toPublicProject(next, accounts.filter((account) => account.projectId === next.id).length) });
      }

      if (request.method === "DELETE") {
        const accounts = await this.getAccounts();
        const removedIds = new Set(accounts.filter((account) => account.projectId === project.id).map((account) => account.id));
        await this.saveAccounts(accounts.filter((account) => account.projectId !== project.id));
        const statsMap = await this.getStatsMap();
        const healthMap = await this.getHealthMap();
        for (const id of removedIds) {
          delete statsMap[id];
          delete healthMap[id];
        }
        await Promise.all([
          this.saveStatsMap(statsMap),
          this.saveHealthMap(healthMap),
          this.saveProjects(projects.filter((item) => item.id !== project.id)),
        ]);
        return json({ ok: true });
      }
    }

    if (pathname === "/admin/stats/reset" && request.method === "POST") {
      await this.saveStatsMap({});
      return json({ ok: true });
    }

    if (pathname === "/admin/routing" && request.method === "GET") {
      return json({ routing: await this.getRoutingSettings() });
    }

    if (pathname === "/admin/routing" && request.method === "PATCH") {
      const payload = await readJsonBody<Partial<RoutingSettings>>(request);
      const current = await this.getRoutingSettings();
      const next = {
        maxRetryAccounts: payload.maxRetryAccounts === undefined
          ? current.maxRetryAccounts
          : normalizeWeight(payload.maxRetryAccounts),
        disableOnFailure: typeof payload.disableOnFailure === "boolean"
          ? payload.disableOnFailure
          : current.disableOnFailure,
      };
      await this.saveRoutingSettings(next);
      return json({ ok: true, routing: next });
    }

    if (pathname === "/admin/models" && request.method === "GET") {
      const settings = await this.getModelSettings();
      return json({ models: settings.models });
    }

    if (pathname === "/admin/models" && request.method === "PATCH") {
      const payload = await readJsonBody<Partial<ModelSettings>>(request);
      const next = { models: normalizeModelList(payload.models) };
      await this.saveModelSettings(next);
      return json({ ok: true, models: next.models });
    }

    if (pathname === "/admin/models/discover" && request.method === "POST") {
      let payload: { limit?: number } = {};
      if (request.headers.get("content-type")?.includes("application/json")) {
        payload = await readJsonBody<{ limit?: number }>(request);
      }
      const limit = Math.max(1, Math.min(50, Math.round(Number(payload.limit || 8))));
      const [accounts, statsMap, healthMap] = await Promise.all([
        this.getAccounts(),
        this.getStatsMap(),
        this.getHealthMap(),
      ]);
      const enabled = accounts
        .filter((account) => account.enabled)
        .sort((a, b) => {
          const aHealth = healthMap[a.id] ?? createEmptyHealth();
          const bHealth = healthMap[b.id] ?? createEmptyHealth();
          const aHealthy = (a.unhealthyUntil ?? 0) <= Date.now() && aHealth.lastOk !== false ? 0 : 1;
          const bHealthy = (b.unhealthyUntil ?? 0) <= Date.now() && bHealth.lastOk !== false ? 0 : 1;
          if (aHealthy !== bHealthy) return aHealthy - bHealthy;
          return (statsMap[b.id]?.calls || 0) - (statsMap[a.id]?.calls || 0)
            || normalizeWeight(b.weight) - normalizeWeight(a.weight)
            || a.label.localeCompare(b.label);
        });
      const seenBaseUrl = new Set<string>();
      const primary: AccountRecord[] = [];
      const remaining: AccountRecord[] = [];
      for (const account of enabled) {
        if (seenBaseUrl.has(account.baseUrl)) remaining.push(account);
        else {
          seenBaseUrl.add(account.baseUrl);
          primary.push(account);
        }
      }
      const targets = [...primary, ...remaining].slice(0, limit);
      const results = await Promise.all(targets.map((account) => this.discoverAccountModels(account)));
      const modelMap = new Map<string, string[]>();
      for (const result of results) {
        if (!result.ok) continue;
        for (const model of result.models) {
          const labels = modelMap.get(model) ?? [];
          labels.push(result.label);
          modelMap.set(model, labels);
        }
      }
      const recommendations = [...modelMap.entries()]
        .map(([model, labels]) => ({ model, accounts: labels.sort((a, b) => a.localeCompare(b)) }))
        .sort((a, b) => b.accounts.length - a.accounts.length || a.model.localeCompare(b.model));
      return json({
        ok: results.some((item) => item.ok),
        total: enabled.length,
        scanned: targets.length,
        skipped: Math.max(0, enabled.length - targets.length),
        limit,
        okCount: results.filter((item) => item.ok).length,
        recommendations,
        results,
      });
    }

    const testAllProjectId = projectAccountsTestAllMatch?.[1]
      ? decodeURIComponent(projectAccountsTestAllMatch[1])
      : pathname === "/admin/accounts/test-all"
        ? DEFAULT_PROJECT_ID
        : "";
    if (testAllProjectId && request.method === "POST") {
      const accounts = await this.getAccounts();
      const targets = accounts.filter((account) => account.projectId === testAllProjectId && account.enabled);
      const results = await Promise.all(targets.map((account) => this.probeAccount(account)));
      const okCount = results.filter((item) => item.ok).length;
      return json({ ok: okCount === targets.length, total: targets.length, okCount });
    }

    const testMatch = projectAccountTestMatch ?? (pathname.match(/^\/admin\/accounts\/([^/]+)\/test$/) ? ["", DEFAULT_PROJECT_ID, pathname.match(/^\/admin\/accounts\/([^/]+)\/test$/)?.[1] || ""] : null);
    const itemMatch = projectAccountItemMatch ?? (pathname.match(/^\/admin\/accounts\/([^/]+)$/) ? ["", DEFAULT_PROJECT_ID, pathname.match(/^\/admin\/accounts\/([^/]+)$/)?.[1] || ""] : null);
    const match = testMatch ?? itemMatch;
    if (!match) return json({ error: "Not found" }, { status: 404 });

    const accountProjectId = decodeURIComponent(match[1]);
    const accountId = decodeURIComponent(match[2]);
    const accounts = await this.getAccounts();
    const target = accounts.find((item) => item.id === accountId && item.projectId === accountProjectId);
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
      if (payload.weight !== undefined) target.weight = normalizeWeight(payload.weight);
      if (payload.extraHeaders && typeof payload.extraHeaders === "object") target.extraHeaders = payload.extraHeaders;
      target.projectId = accountProjectId;
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

  private async handlePublicStatus(): Promise<Response> {
    const [accounts, statsMap, healthMap, modelSettings, modelHourlyStats] = await Promise.all([
      this.getAccounts(),
      this.getStatsMap(),
      this.getHealthMap(),
      this.getModelSettings(),
      this.getModelHourlyStats(),
    ]);
    const summary = summarizeAccounts(accounts, statsMap, healthMap);
    const hours = lastHourKeys(24);
    const modelHealth = modelSettings.models.map((model) => {
      const stats = modelHourlyStats[model] ?? {};
      const buckets = hours.map((key) => {
        const bucket = stats[key] ?? createEmptyModelBucket();
        const label = new Date(key).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
        return {
          hour: key,
          label,
          calls: bucket.calls,
          successes: bucket.successes,
          errors: bucket.errors,
          successRate: bucket.calls > 0 ? Math.round((bucket.successes / bucket.calls) * 100) : 0,
          avgDurationMs: bucket.avgDurationMs,
          lastStatus: bucket.lastStatus,
        };
      });
      const calls = buckets.reduce((sum, bucket) => sum + bucket.calls, 0);
      const successes = buckets.reduce((sum, bucket) => sum + bucket.successes, 0);
      return {
        model,
        calls,
        successRate: calls > 0 ? Math.round((successes / calls) * 100) : 0,
        avgDurationMs: calls > 0
          ? Math.round(buckets.reduce((sum, bucket) => sum + bucket.avgDurationMs * bucket.calls, 0) / calls)
          : 0,
        hours: buckets,
      };
    });
    const state = summary.enabled === 0 || summary.available === 0
      ? "bad"
      : summary.actionRequired > 0
        ? "warn"
        : "ok";
    const message = state === "ok"
      ? "服务可用，账号池状态正常"
      : state === "warn"
        ? "服务可用，但有账号需要处理"
        : "当前没有可用账号";

    return json({
      ok: summary.available > 0,
      state,
      message,
      generatedAt: Date.now(),
      models: modelSettings.models,
      modelHealth,
      summary: {
        total: summary.total,
        enabled: summary.enabled,
        disabled: summary.disabled,
        cooling: summary.cooling,
        available: summary.available,
        actionRequired: summary.actionRequired,
        calls: summary.calls,
        successes: summary.successes,
        errors: summary.errors,
        healthChecks: summary.healthChecks,
        successRate: summary.successRate,
        avgDurationMs: summary.avgDurationMs,
      },
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/public/status") return this.handlePublicStatus();
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
