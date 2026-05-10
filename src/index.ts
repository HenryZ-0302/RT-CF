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
  modelMapping: Record<string, string>;
  disabledModels: string[];
  createdAt: number;
  updatedAt: number;
};

type ProjectInput = {
  id?: string;
  name?: string;
  enabled?: boolean;
  modelMapping?: Record<string, string>;
  disabledModels?: string[];
};

type PublicProject = {
  id: string;
  name: string;
  enabled: boolean;
  modelMapping: Record<string, string>;
  disabledModels: string[];
  accountCount: number;
  createdAt: number;
  updatedAt: number;
};

type ApiKeyRecord = {
  id: string;
  key: string;
  name: string;
  projects: string[] | "ALL";
  createdAt: number;
  updatedAt: number;
};

type ApiKeyInput = {
  id?: string;
  name?: string;
  projects?: string[] | "ALL";
};

type PublicApiKey = ApiKeyRecord;

type RoutingSettings = {
  maxRetryAccounts: number;
  disableOnFailure: boolean;
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
const KEYS_KEY = "api_keys";
const CURSOR_KEY = "cursor";
const STATS_KEY = "stats";
const HEALTH_KEY = "health";
const ROUTING_KEY = "routing";
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

function normalizeModelMapping(value: unknown): Record<string, string> {
  const incoming = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mapping: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.trim();
    const val = String(v ?? "").trim();
    if (key && val) mapping[key] = val;
  }
  return mapping;
}

function normalizeDisabledModels(value: unknown): string[] {
  return normalizeModelList(value);
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

function generateApiKeyId(): string {
  return `key-${Math.floor(100000000 + Math.random() * 900000000)}`;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `hy_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sanitizeApiKeyInput(payload: ApiKeyInput, existing?: ApiKeyRecord): ApiKeyRecord {
  const now = Date.now();
  return {
    id: payload.id?.trim() || existing?.id || generateApiKeyId(),
    key: existing?.key || generateApiKey(),
    name: payload.name?.trim() || existing?.name || "新 API 密钥",
    projects: payload.projects === "ALL" ? "ALL" : Array.isArray(payload.projects) ? payload.projects : existing?.projects ?? [DEFAULT_PROJECT_ID],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function sanitizeProjectInput(payload: ProjectInput, existing?: ProjectRecord): ProjectRecord {
  const now = Date.now();
  const id = payload.id?.trim() || existing?.id || generateProjectId();
  return {
    id,
    name: payload.name?.trim() || existing?.name || id,
    enabled: payload.enabled ?? existing?.enabled ?? true,
    modelMapping: payload.modelMapping ?? existing?.modelMapping ?? {},
    disabledModels: payload.disabledModels ?? existing?.disabledModels ?? [],
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
    modelMapping: existing?.modelMapping ?? {},
    disabledModels: existing?.disabledModels ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  };
}

function toPublicProject(project: ProjectRecord, accountCount = 0): PublicProject {
  return {
    id: project.id,
    name: project.name,
    enabled: project.enabled,
    modelMapping: project.modelMapping,
    disabledModels: project.disabledModels,
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
  const accountIds = new Set(accounts.map((account) => account.id));
  const stats = Object.entries(statsMap)
    .filter(([accountId]) => accountIds.has(accountId))
    .map(([, stat]) => stat);
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
  <link rel="stylesheet" crossorigin="anonymous" href="https://cdn.jsdelivr.net/npm/misans@4.0.0/lib/Normal/MiSans-Regular.min.css" />
  <link rel="stylesheet" crossorigin="anonymous" href="https://cdn.jsdelivr.net/npm/misans@4.0.0/lib/Normal/MiSans-Semibold.min.css" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f0f4f8;
      --panel: rgba(255,255,255,0.75);
      --panel-soft: rgba(241,245,249,0.6);
      --text: #0f172a;
      --muted: #64748b;
      --line: rgba(15,23,42,0.07);
      --ok: #10b981;
      --warn: #f59e0b;
      --bad: #ef4444;
      --accent: #3b82f6;
      --shadow: 0 8px 32px -4px rgba(15,23,42,0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: 'MiSans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      background-image: radial-gradient(ellipse at 20% 0%, rgba(59,130,246,0.08) 0%, transparent 60%), radial-gradient(ellipse at 80% 100%, rgba(139,92,246,0.06) 0%, transparent 50%);
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
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      box-shadow: 0 8px 20px rgba(59,130,246,0.3);
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
      border-radius: 16px;
      background: var(--panel);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      box-shadow: var(--shadow);
      transition: transform 200ms ease, box-shadow 200ms ease;
    }
    .card:hover { transform: translateY(-4px); box-shadow: 0 16px 48px -8px rgba(15,23,42,0.14); }
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
      border-radius: 12px;
      padding: 10px 14px;
      color: var(--text);
      background: var(--panel);
      backdrop-filter: blur(8px);
      font: inherit;
      transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    .model-search:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59,130,246,0.12); }
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
    .model-tab { transition: all 180ms ease; }
    .model-tab:hover:not(.active) { border-color: var(--accent); color: var(--accent); }
    .model-tab.active { color: #fff; border-color: transparent; background: linear-gradient(135deg, #3b82f6, #8b5cf6); }
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
      border-radius: 6px;
      background: rgba(100, 116, 139, 0.16);
      transition: transform 120ms ease;
      border: 1px solid rgba(100, 116, 139, 0.14);
      cursor: help;
      position: relative;
      flex: 0 0 auto;
    }
    .hour-cell:hover { transform: scaleY(1.3); z-index: 2; }
    .hour-cell.good { background: rgba(16,185,129,0.75); border-color: rgba(16,185,129,0.4); }
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
      box-shadow: 0 18px 44px rgba(15,23,42,0.16);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
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
        --bg: #0b0d17;
        --panel: rgba(255,255,255,0.04);
        --panel-soft: rgba(255,255,255,0.06);
        --text: #f1f5f9;
        --muted: #94a3b8;
        --line: rgba(255,255,255,0.07);
        --shadow: 0 8px 32px -4px rgba(0,0,0,0.5);
      }
      body { background: var(--bg); background-image: radial-gradient(ellipse at 20% 0%, rgba(59,130,246,0.06) 0%, transparent 60%), radial-gradient(ellipse at 80% 100%, rgba(139,92,246,0.04) 0%, transparent 50%); }
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

function renderAdminPageV2(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HYHub Admin</title>
  <link rel="stylesheet" crossorigin="anonymous" href="https://cdn.jsdelivr.net/npm/misans@4.0.0/lib/Normal/MiSans-Regular.min.css" />
  <link rel="stylesheet" crossorigin="anonymous" href="https://cdn.jsdelivr.net/npm/misans@4.0.0/lib/Normal/MiSans-Semibold.min.css" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f0f4f8;
      --panel: rgba(255,255,255,0.75);
      --panel-soft: rgba(241,245,249,0.6);
      --text: #0f172a;
      --muted: #64748b;
      --line: rgba(15,23,42,0.07);
      --accent: #3b82f6;
      --ok: #10b981;
      --warn: #f59e0b;
      --bad: #ef4444;
      --shadow: 0 8px 32px -4px rgba(15,23,42,0.08);
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; overflow-x: hidden; font-family: 'MiSans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); background-image: radial-gradient(ellipse at 15% 0%, rgba(59,130,246,0.07) 0%, transparent 55%), radial-gradient(ellipse at 85% 100%, rgba(139,92,246,0.05) 0%, transparent 50%); color: var(--text); }
    body.menu-lock { overflow: hidden; }
    .hidden { display: none !important; }
    .gate { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .gate-card, .panel { background: var(--panel); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); }
    .gate-card { width: min(440px, 100%); padding: 28px; display: grid; gap: 14px; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 276px minmax(0, 1fr); width: 100%; overflow-x: clip; }
    .mobile-bar { display: none; }
    .scrim { display: none; }
    aside { position: sticky; top: 0; height: 100vh; min-width: 0; overflow-y: auto; border-right: 1px solid var(--line); background: var(--panel); padding: 22px 16px; display: flex; flex-direction: column; gap: 18px; }
    .brand { padding: 4px 6px 16px; margin-bottom: 2px; border-bottom: 1px dashed var(--line); }
    .brand h1 { margin: 0 0 4px; font-size: 26px; font-weight: 800; letter-spacing: -0.02em; background: linear-gradient(135deg, var(--accent), #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .brand p { margin: 0; font-size: 13px; color: var(--muted); }
    .muted { color: var(--muted); line-height: 1.55; }
    nav { display: grid; gap: 8px; }
    .nav-btn { justify-content: flex-start; background: transparent; color: var(--text); border: 1px solid transparent; }
    .nav-btn.active { background: linear-gradient(135deg, rgba(59,130,246,0.12), rgba(139,92,246,0.08)); border-color: rgba(59,130,246,0.25); color: var(--accent); }
    .nav-btn { transition: all 150ms ease; }
    .nav-btn:hover:not(.active) { background: var(--panel-soft); }
    .side-section { border-top: 1px solid var(--line); padding-top: 14px; display: grid; gap: 10px; }
    .side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .side-head span { color: var(--muted); font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .icon-btn { width: 34px; height: 34px; padding: 0; display: grid; place-items: center; border-radius: 8px; }
    .project-switcher { display: grid; gap: 7px; }
    .project-item { width: 100%; text-align: left; display: grid; gap: 5px; padding: 10px; border: 1px solid transparent; background: transparent; color: var(--text); }
    .project-item.active { border-color: rgba(59,130,246,0.35); background: linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246,0.05)); color: var(--accent); }
    .project-item { transition: all 150ms ease; border-radius: 10px; }
    .project-item:hover:not(.active) { background: var(--panel-soft); }
    .project-item .meta { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
    .sidebar-actions { margin-top: auto; display: grid; gap: 8px; }
    main { min-width: 0; max-width: 100%; overflow-x: hidden; padding: 22px; display: grid; gap: 16px; align-content: start; }
    header { min-width: 0; display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
    h2, h3 { margin: 0; letter-spacing: 0; }
    h2 { font-size: 26px; }
    h3 { font-size: 17px; }
    button, input, textarea, select { font: inherit; border-radius: 8px; }
    button { border: 0; padding: 10px 13px; background: var(--accent); color: #fff; cursor: pointer; transition: transform 120ms ease, box-shadow 120ms ease; }
    button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(59,130,246,0.25); }
    button.secondary { background: #334155; }
    button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); }
    button.danger { background: var(--bad); }
    button:disabled { opacity: .65; cursor: wait; }
    input, textarea, select { width: 100%; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 11px 12px; border-radius: 10px; transition: border-color 150ms ease, box-shadow 150ms ease; }
    input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59,130,246,0.12); }
    textarea { min-height: 92px; resize: vertical; }
    .page { display: none; gap: 16px; min-width: 0; }
    .page.active { display: grid; }
    .panel { min-width: 0; padding: 18px; }
    .grid { min-width: 0; display: grid; gap: 12px; }
    .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .stats { min-width: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
    .stat { background: var(--panel); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--line); border-radius: 14px; padding: 14px; transition: transform 200ms ease; }
    .stat:hover { transform: translateY(-2px); }
    .stat b { display: block; font-size: 25px; margin-bottom: 6px; }
    .workspace-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; }
    .workspace-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .model-grid { display: grid; gap: 8px; margin-top: 12px; }
    .model-option { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; border: 1px solid var(--line); border-radius: 8px; padding: 11px; background: var(--panel); cursor: pointer; }
    .model-option input { width: auto; margin-top: 3px; }
    .advanced-models { margin-top: 12px; }
    .advanced-models summary { cursor: pointer; color: var(--muted); }
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
    .key-row .mono { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { border: 1px dashed var(--line); border-radius: 8px; padding: 24px; color: var(--muted); text-align: center; }
    .bars { display: grid; gap: 8px; }
    .bar { display: grid; grid-template-columns: 140px minmax(0, 1fr) 70px; gap: 10px; align-items: center; }
    .track { height: 8px; border-radius: 99px; background: var(--panel-soft); overflow: hidden; }
    .track i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), var(--ok)); }
    .modal-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 18px; background: rgba(15,23,42,0.48); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
    .modal { width: min(520px, 100%); max-height: min(86vh, 760px); overflow: auto; background: var(--panel); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 28px 80px rgba(15,23,42,0.28); padding: 18px; display: grid; gap: 14px; animation: modalIn 200ms ease-out; }
    @keyframes modalIn { from { opacity:0; transform: scale(0.96) translateY(8px); } to { opacity:1; transform: none; } }
    .modal.wide { width: min(760px, 100%); }
    .modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    @media (max-width: 1180px) { .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 1040px) {
      .shell { grid-template-columns: minmax(0, 1fr); }
      .grid.three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 760px) {
      .shell { display: block; min-height: 100vh; padding-top: 52px; }
      .mobile-bar {
        position: fixed;
        inset: 0 0 auto 0;
        z-index: 6;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        height: 52px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--line);
        background: color-mix(in srgb, var(--panel) 94%, transparent);
        backdrop-filter: blur(14px);
      }
      .mobile-title { min-width: 0; display: flex; align-items: center; gap: 9px; font-weight: 800; }
      .mobile-title span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mobile-mark {
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        flex: 0 0 auto;
        border-radius: 8px;
        color: #fff;
        background: var(--accent);
      }
      #menu-toggle {
        width: 38px;
        height: 36px;
        padding: 0;
        display: grid;
        place-items: center;
        background: var(--panel-soft);
        color: var(--text);
        border: 1px solid var(--line);
      }
      #menu-toggle::before { content: "☰"; font-size: 18px; line-height: 1; }
      .scrim {
        position: fixed;
        inset: 0;
        z-index: 7;
        display: block;
        background: rgba(15, 23, 42, 0.42);
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease;
      }
      aside {
        position: fixed;
        top: 0;
        bottom: 0;
        left: 0;
        z-index: 8;
        width: min(82vw, 300px);
        height: 100vh;
        transform: translateX(-102%);
        transition: transform 220ms ease;
        border-right: 1px solid var(--line);
        border-bottom: 0;
        box-shadow: 18px 0 42px rgba(15, 23, 42, 0.16);
      }
      .shell.menu-open aside { transform: translateX(0); }
      .shell.menu-open .scrim { opacity: 1; pointer-events: auto; }
      nav { grid-template-columns: 1fr; }
      .nav-btn { justify-content: flex-start; white-space: normal; }
      aside .ghost, aside .danger { width: 100%; }
      header { display: grid; }
      .stats, .grid.two, .grid.three { grid-template-columns: 1fr; }
      .bar { grid-template-columns: 1fr; }
      .workspace-card { grid-template-columns: 1fr; }
    }
    @media (max-width: 420px) {
      main { padding: 12px; }
      .mobile-bar { height: 48px; padding: 6px 10px; }
      .shell { padding-top: 48px; }
      aside { width: min(86vw, 292px); padding: 16px 12px; }
      .actions { display: grid; grid-template-columns: 1fr; }
      .actions button { width: 100%; }
    }
    @supports not (background: color-mix(in srgb, white, transparent)) {
      @media (max-width: 760px) { .mobile-bar { background: var(--panel); } }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0d17;
        --panel: rgba(255,255,255,0.04);
        --panel-soft: rgba(255,255,255,0.06);
        --text: #f1f5f9;
        --muted: #94a3b8;
        --line: rgba(255,255,255,0.07);
        --shadow: 0 8px 32px -4px rgba(0,0,0,0.5);
      }
      body { background-image: radial-gradient(ellipse at 15% 0%, rgba(59,130,246,0.05) 0%, transparent 55%), radial-gradient(ellipse at 85% 100%, rgba(139,92,246,0.04) 0%, transparent 50%); }
      aside { background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)); border-right-color: rgba(255,255,255,0.06); }
    }
    .dropdown { position: absolute; z-index: 50; background: var(--panel); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 36px rgba(0,0,0,0.15); padding: 6px; display: flex; flex-direction: column; gap: 2px; min-width: 140px; animation: modalIn 150ms ease-out; }
    .dropdown button { background: transparent; color: var(--text); padding: 8px 12px; text-align: left; font-size: 13px; border-radius: 6px; transition: background 150ms; box-shadow: none; transform: none; }
    .dropdown button:hover { background: var(--panel-soft); }
    .dropdown button.danger-text { color: var(--bad); }
    .dropdown button.danger-text:hover { background: rgba(239, 68, 68, 0.1); }
    .project-item-wrap { position: relative; display: flex; align-items: stretch; border: 1px solid transparent; border-radius: 10px; transition: all 150ms ease; margin-bottom: 2px; }
    .project-item-wrap.active { border-color: rgba(59,130,246,0.35); background: linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246,0.05)); }
    .project-item-wrap:hover:not(.active) { background: var(--panel-soft); }
    .project-item-wrap .project-item { border: none !important; background: transparent !important; margin: 0; }
    .project-dots { width: 32px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; background: transparent; color: var(--muted); border: none; cursor: pointer; border-radius: 0 10px 10px 0; opacity: 0.5; transition: opacity 150ms; box-shadow: none; transform: none; padding: 0; }
    .project-item-wrap:hover .project-dots { opacity: 1; }
    .project-dots:hover { background: rgba(0,0,0,0.05); }
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
    <div class="mobile-bar">
      <div class="mobile-title"><span class="mobile-mark">H</span><span id="mobile-page-title">仪表盘</span></div>
      <button id="menu-toggle" aria-label="打开菜单" aria-expanded="false"></button>
    </div>
    <div id="menu-scrim" class="scrim"></div>
    <aside>
      <div class="brand">
        <h1>HYHub</h1>
        <p class="muted">项目隔离的 API Hub</p>
      </div>
      <nav>
        <button class="nav-btn active" data-page="dashboard">仪表盘</button>
        <button class="nav-btn" data-page="projects">项目</button>
        <button class="nav-btn" data-page="keys">密钥</button>
        <button class="nav-btn" data-page="settings">设置</button>
      </nav>
      <div class="side-section">
        <div class="side-head"><span>当前项目</span><button class="ghost icon-btn" id="new-project" title="新建项目">+</button></div>
        <div id="project-switcher" class="project-switcher"></div>
      </div>
      <div class="sidebar-actions">
        <button class="ghost" id="reload">刷新</button>
        <button class="danger" id="logout">退出</button>
      </div>
    </aside>
    <main>
      <header>
        <div>
          <h2 id="page-title">仪表盘</h2>
          <div class="muted" id="page-desc">查看整体项目、账号池和调用健康。</div>
        </div>
        <div class="toolbar"><span class="tag" id="current-project-pill">未选择项目</span><span class="tag mono" id="base-url"></span></div>
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
        <section class="grid">
            <div class="panel">
              <div class="workspace-card">
                <div>
                  <div class="workspace-title"><h3 id="workspace-project-name">当前项目</h3><span class="tag" id="selected-project-tag">未选择</span></div>
                  <div class="muted" id="workspace-project-meta" style="margin-top:6px"></div>
                </div>
                <div class="actions">
                  <button id="edit-project" class="ghost">编辑项目</button>
                </div>
              </div>
              <div class="status" id="project-status"></div>
            </div>
            <div class="panel">
              <div class="row"><h3>上游账号池</h3><div class="actions"><button id="new-account">添加账号</button><button id="test-project-accounts" class="secondary">检测当前项目</button></div></div>
              <div class="actions">
                <button id="batch-enable" class="ghost">批量启用</button>
                <button id="batch-disable" class="ghost">批量停用</button>
              </div>
              <div class="status" id="account-status"></div>
              <div id="accounts-table" style="margin-top:12px"></div>
            </div>
        </section>
      </section>

      <section id="page-keys" class="page">
        <section class="panel">
          <div class="row">
            <div>
              <h3>全局 API Key 管理</h3>
              <p class="muted" style="margin-top:4px">创建并管理全局 API Key，可分配允许访问的项目。</p>
            </div>
            <div class="actions">
              <button id="create-key">创建 API Key</button>
              <button id="copy-base-url" class="secondary">复制 Base URL</button>
            </div>
          </div>
          <div class="status" id="key-status" style="margin-top:12px"></div>
          <div id="keys-table" style="margin-top:12px"></div>
        </section>
      </section>

      <section id="page-settings" class="page">
        <div class="grid two">
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
            <h3>导入 / 导出 / 统计</h3>
            <p class="muted">导入导出作用于侧边栏当前项目账号池；清空统计只清真实 API 调用统计。</p>
            <div class="actions">
              <button id="open-ops-modal" class="secondary">打开数据操作</button>
            </div>
            <div class="status" id="ops-status"></div>
          </section>
          <section class="panel">
            <h3>系统设置</h3>
            <div class="grid two" style="margin-top:12px">
              <input id="api-test-model" placeholder="API 检测模型，默认 gpt-4.1-mini" />
            </div>
          </section>
        </div>
      </section>
    </main>
  </section>

  <div id="project-modal" class="modal-backdrop hidden" role="dialog" aria-modal="true">
    <div class="modal wide">
      <div class="modal-head">
        <div>
          <h3 id="project-modal-title">新建项目</h3>
          <p class="muted" id="project-modal-desc" style="margin:6px 0 0">项目拥有独立的账号池和模型配置。</p>
        </div>
        <button id="close-project-modal" class="ghost icon-btn" aria-label="关闭">×</button>
      </div>
      <div class="grid two">
        <input id="project-id" placeholder="项目 ID，例如 default-rt" />
        <input id="project-name" placeholder="项目名称" />
      </div>
      <label class="toolbar"><input id="project-enabled" type="checkbox" checked /> 启用项目</label>
      <div class="grid two">
        <textarea id="project-model-mapping" placeholder='模型映射 (JSON)，例如: {"gpt-4": "gpt-4-0613"}'></textarea>
        <textarea id="project-disabled-models" placeholder="禁用的模型列表，一行一个"></textarea>
      </div>
      <div class="actions">
        <button id="save-project">保存项目</button>
        <button id="cancel-project-modal" class="ghost">取消</button>
      </div>
    </div>
  </div>

  <div id="account-modal" class="modal-backdrop hidden" role="dialog" aria-modal="true">
    <div class="modal wide">
      <div class="modal-head">
        <div>
          <h3 id="account-modal-title">添加账号</h3>
          <p class="muted" style="margin:6px 0 0">账号会加入侧边栏当前项目的上游账号池。</p>
        </div>
        <button id="close-account-modal" class="ghost icon-btn" aria-label="关闭">×</button>
      </div>
      <div class="grid two">
        <input id="account-id" placeholder="账号 ID（可留空）" />
        <input id="account-label" placeholder="显示名称" />
        <input id="account-base-url" placeholder="上游 Base URL" />
        <input id="account-api-key" placeholder="上游 API Key（新账号必填，编辑时留空则保持不变）" />
        <input id="account-weight" type="number" min="1" max="20" step="1" placeholder="权重 1-20" />
        <select id="account-enabled"><option value="true">启用</option><option value="false">停用</option></select>
      </div>
      <textarea id="account-extra-headers" placeholder='额外请求头 JSON，例如 {"OpenAI-Organization":"org_xxx"}'></textarea>
      <div class="actions">
        <button id="save-account">保存账号</button>
        <button id="cancel-account-modal" class="ghost">取消</button>
      </div>
    </div>
  </div>

  <div id="key-modal" class="modal-backdrop hidden" role="dialog" aria-modal="true">
    <div class="modal">
      <div class="modal-head">
        <div>
          <h3 id="key-modal-title">API Key 设置</h3>
        </div>
        <button id="close-key-modal" class="ghost icon-btn" aria-label="关闭">×</button>
      </div>
      <div class="grid">
        <input id="key-name" placeholder="凭证名称" />
        <select id="key-projects" multiple style="height: 120px;">
          <option value="ALL">所有项目 (ALL)</option>
        </select>
        <p class="muted">按住 Ctrl/Cmd 多选项目。包含 "所有项目 (ALL)" 则允许访问所有项目。</p>
      </div>
      <div class="actions">
        <button id="save-key">保存</button>
      </div>
    </div>
  </div>

  <div id="ops-modal" class="modal-backdrop hidden" role="dialog" aria-modal="true">
    <div class="modal">
      <div class="modal-head">
        <div>
          <h3>数据操作</h3>
          <p class="muted" style="margin:6px 0 0">这些操作作用于侧边栏当前项目，清空统计会影响全局真实调用统计。</p>
        </div>
        <button id="close-ops-modal" class="ghost icon-btn" aria-label="关闭">×</button>
      </div>
      <div class="actions">
        <button id="export-accounts" class="secondary">导出账号</button>
        <button id="import-accounts" class="secondary">导入账号</button>
        <button id="reset-stats" class="danger">清空统计</button>
      </div>
    </div>
  </div>

  <script>
    const els = {
      gate: document.getElementById("gate"),
      app: document.getElementById("app"),
      token: document.getElementById("token"),
      gateStatus: document.getElementById("gate-status"),
      pageTitle: document.getElementById("page-title"),
      pageDesc: document.getElementById("page-desc"),
      mobilePageTitle: document.getElementById("mobile-page-title"),
      menuToggle: document.getElementById("menu-toggle"),
      menuScrim: document.getElementById("menu-scrim"),
      baseUrl: document.getElementById("base-url"),
      currentProjectPill: document.getElementById("current-project-pill"),
      projectSwitcher: document.getElementById("project-switcher"),
      dashboardProjects: document.getElementById("dashboard-projects"),
      modelHealth: document.getElementById("model-health"),
      projectStatus: document.getElementById("project-status"),
      accountStatus: document.getElementById("account-status"),
      accountsTable: document.getElementById("accounts-table"),
      keysTable: document.getElementById("keys-table"),
      keyStatus: document.getElementById("key-status"),
      routingStatus: document.getElementById("routing-status"),
      opsStatus: document.getElementById("ops-status"),
      projectModal: document.getElementById("project-modal"),
      accountModal: document.getElementById("account-modal"),
      keyModal: document.getElementById("key-modal"),
      opsModal: document.getElementById("ops-modal"),
    };
    const pageMeta = {
      dashboard: ["仪表盘", "查看整体项目、账号池和调用健康。"],
      projects: ["项目", "切换项目并管理这个项目自己的上游账号池。"],
      keys: ["密钥", "管理全局 API 凭证及访问权限。"],
      settings: ["设置", "管理全局路由策略与系统设置。"],
    };
    let projects = [];
    let accounts = [];
    let summary = {};
    let projectStats = [];
    let publicStatus = {};
    let currentModels = [];
    let discoveredModels = [];
    let globalKeys = [];
    let editingKeyId = null;
    let editingProjectId = null;
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
    function projectStat(id) { return projectStats.find((item) => item.project?.id === id)?.summary || {}; }
    function parseHeaders() {
      const raw = document.getElementById("account-extra-headers").value.trim();
      return raw ? JSON.parse(raw) : undefined;
    }
    function setPage(page) {
      document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.page === page));
      document.querySelectorAll(".page").forEach((section) => section.classList.toggle("active", section.id === "page-" + page));
      els.pageTitle.textContent = pageMeta[page][0];
      els.mobilePageTitle.textContent = pageMeta[page][0];
      els.pageDesc.textContent = pageMeta[page][1];
      location.hash = page;
      closeMenu();
    }
    function openMenu() {
      els.app.classList.add("menu-open");
      document.body.classList.add("menu-lock");
      els.menuToggle.setAttribute("aria-expanded", "true");
    }
    function closeMenu() {
      els.app.classList.remove("menu-open");
      document.body.classList.remove("menu-lock");
      els.menuToggle.setAttribute("aria-expanded", "false");
    }
    function renderProjectSwitcher() {
      els.projectSwitcher.innerHTML = projects.length ? projects.map((project) => {
        const itemSummary = projectStat(project.id);
        const isActive = project.id === selectedProjectId;
        return '<div class="project-item-wrap ' + (isActive ? 'active' : '') + '">' +
          '<button class="project-item" style="flex:1" onclick="selectProject(\\'' + escapeHtml(project.id) + '\\')"><b>' + escapeHtml(project.name) + '</b><span class="meta"><span class="mono">' + escapeHtml(project.id) + '</span><span>' + (itemSummary.available || 0) + '/' + (project.accountCount || 0) + '</span></span></button>' +
          '<button class="project-dots" onclick="openProjectDropdown(event, \\'' + escapeHtml(project.id) + '\\')">⋮</button>' +
          '</div>';
      }).join("") : '<div class="empty">暂无项目。</div>';
    }
    function renderCurrentProjectContext() {
      const project = selectedProject();
      const itemSummary = project ? projectStat(project.id) : {};
      const label = project ? project.name + ' · ' + project.id : '未选择项目';
      els.currentProjectPill.textContent = label;
      document.getElementById("workspace-project-name").textContent = project ? project.name : "当前项目";
      document.getElementById("selected-project-tag").textContent = project ? project.id : "未选择";
      document.getElementById("workspace-project-meta").textContent = project
        ? "账号 " + (project.accountCount || 0) + "，可用 " + (itemSummary.available || 0) + "，待处理 " + (itemSummary.actionRequired || 0) + "，API Key " + (project.keyCount || 0)
        : "";
    }
    function renderDashboard() {
      document.getElementById("dash-projects").textContent = projects.length;
      document.getElementById("dash-accounts").textContent = summary.total || 0;
      document.getElementById("dash-available").textContent = summary.available || 0;
      document.getElementById("dash-action").textContent = summary.actionRequired || 0;
      document.getElementById("dash-calls").textContent = fmt(summary.calls || 0);
      document.getElementById("dash-errors").textContent = fmt(summary.errors || 0);
      const dashboardItems = projectStats.length ? projectStats : projects.map((project) => ({ project, summary: {} }));
      els.dashboardProjects.innerHTML = dashboardItems.length ? dashboardItems
        .slice().sort((a, b) => (b.summary?.calls || 0) - (a.summary?.calls || 0) || (b.summary?.actionRequired || 0) - (a.summary?.actionRequired || 0))
        .map((item) => {
          const project = item.project || {};
          const itemSummary = item.summary || {};
          const rate = itemSummary.calls > 0 ? itemSummary.successRate + '%' : '暂无';
          return '<div class="list-item" onclick="selectProject(\\'' + escapeHtml(project.id) + '\\', true)"><div class="row"><b>' + escapeHtml(project.name) + '</b><span class="tag ' + (project.enabled ? 'ok' : 'warn') + '">' + (project.enabled ? '启用' : '停用') + '</span></div><div class="muted mono">' + escapeHtml(project.id) + '</div><div class="muted">账号 ' + (project.accountCount || 0) + ' / 可用 ' + (itemSummary.available || 0) + ' / 待处理 ' + (itemSummary.actionRequired || 0) + '</div><div class="muted">调用 ' + fmt(itemSummary.calls || 0) + ' / 失败 ' + fmt(itemSummary.errors || 0) + ' / 成功率 ' + rate + '</div></div>';
        })
        .join("") : '<div class="empty">暂无项目。</div>';
      const modelHealth = publicStatus.modelHealth || [];
      els.modelHealth.innerHTML = modelHealth.length ? modelHealth.map((item) => {
        const pct = Math.max(2, Number(item.successRate || 0));
        return '<div class="bar"><span class="mono">' + escapeHtml(item.model) + '</span><div class="track"><i style="width:' + pct + '%"></i></div><span class="muted">' + (item.calls || 0) + ' 次</span></div>';
      }).join("") : '<div class="empty">暂无模型调用统计。</div>';
    }
    function renderProjects() {
      renderProjectSwitcher();
      renderCurrentProjectContext();
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
      if (!globalKeys.length) {
        els.keysTable.innerHTML = '<div class="empty">当前还没有全局 API Key。</div>';
        return;
      }
      els.keysTable.innerHTML = '<div class="table-wrap"><table><thead><tr><th>凭证名称</th><th>API Key</th><th>访问权限</th><th>操作</th></tr></thead><tbody>' + globalKeys.map((key) => {
        const allowed = Array.isArray(key.projects) ? key.projects.map(p => '<span class="tag">' + escapeHtml(p) + '</span>').join('') : '<span class="tag ok">ALL</span>';
        return '<tr><td><b>' + escapeHtml(key.name || "未命名") + '</b></td><td><div class="mono">' + escapeHtml(key.id) + '</div></td><td><div class="toolbar">' + allowed + '</div></td><td><div class="actions"><button class="ghost" onclick="copyKey(\\'' + escapeHtml(key.id) + '\\')">复制</button><button class="ghost" onclick="editKey(\\'' + escapeHtml(key.id) + '\\')">编辑</button><button class="danger" onclick="deleteKey(\\'' + escapeHtml(key.id) + '\\')">删除</button></div></td></tr>';
      }).join("") + '</tbody></table></div>';
    }
    async function refreshAll() {
      const verify = await api("/admin/verify");
      projects = verify.projects || [];
      summary = verify.summary || {};
      projectStats = verify.projectStats || [];
      if (!projects.some((project) => project.id === selectedProjectId)) selectedProjectId = projects[0]?.id || "default-rt";
      await loadProjectAccounts();
      await Promise.all([loadRouting(), loadPublicStatus(), loadKeys()]);
      renderDashboard();
      renderProjects();
      renderAccounts();
      renderKeys();
    }
    async function loadKeys() {
      const data = await api("/admin/keys");
      globalKeys = data.keys || [];
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
    function openProjectModal(project) {
      editingProjectId = project?.id || null;
      document.getElementById("project-modal-title").textContent = project ? "编辑项目" : "新建项目";
      document.getElementById("project-modal-desc").textContent = project ? "修改当前项目名称和启用状态；项目 ID 作为模型前缀保持不变。" : "项目拥有独立的账号池和模型配置。";
      document.getElementById("project-id").value = project?.id || "";
      document.getElementById("project-id").disabled = !!project;
      document.getElementById("project-name").value = project?.name || "";
      document.getElementById("project-enabled").checked = project?.enabled !== false;
      document.getElementById("project-model-mapping").value = project?.modelMapping ? JSON.stringify(project.modelMapping, null, 2) : "";
      document.getElementById("project-disabled-models").value = project?.disabledModels?.length ? project.disabledModels.join("\n") : "";
      els.projectModal.classList.remove("hidden");
    }
    function closeProjectModal() {
      editingProjectId = null;
      els.projectModal.classList.add("hidden");
    }
    function openAccountModal(account) {
      document.getElementById("account-modal-title").textContent = account ? "编辑账号" : "添加账号";
      clearAccountForm();
      if (account) {
        document.getElementById("account-id").value = account.id;
        document.getElementById("account-label").value = account.label || "";
        document.getElementById("account-base-url").value = account.baseUrl || "";
        document.getElementById("account-api-key").value = "";
        document.getElementById("account-weight").value = account.weight || 1;
        document.getElementById("account-enabled").value = account.enabled ? "true" : "false";
        document.getElementById("account-extra-headers").value = JSON.stringify(account.extraHeaders || {}, null, 2);
      }
      els.accountModal.classList.remove("hidden");
    }
    function closeAccountModal() {
      els.accountModal.classList.add("hidden");
    }
    function openOpsModal() {
      els.opsModal.classList.remove("hidden");
    }
    function closeOpsModal() {
      els.opsModal.classList.add("hidden");
    }
    async function saveProject() {
      try {
        const id = document.getElementById("project-id").value.trim();
        const existing = !!editingProjectId;
        let modelMapping = undefined;
        try {
          const rawMap = document.getElementById("project-model-mapping").value.trim();
          if (rawMap) modelMapping = JSON.parse(rawMap);
        } catch(e) { throw new Error("模型映射 JSON 格式错误"); }
        const disabledModels = document.getElementById("project-disabled-models").value.split(/[\n,]+/).map(m => m.trim()).filter(Boolean);
        const payload = { 
          id: existing ? undefined : id || undefined, 
          name: document.getElementById("project-name").value.trim() || undefined, 
          enabled: document.getElementById("project-enabled").checked,
          modelMapping,
          disabledModels: disabledModels.length ? disabledModels : undefined
        };
        const data = await api(existing ? "/admin/projects/" + encodeURIComponent(editingProjectId) : "/admin/projects", { method: existing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        selectedProjectId = data.project.id;
        closeProjectModal();
        await refreshAll();
        status(els.projectStatus, "项目已保存。");
      } catch (error) { status(els.projectStatus, error.message, true); }
    }
    let activeDropdown = null;
    function closeDropdown() { if (activeDropdown) { activeDropdown.remove(); activeDropdown = null; } }
    document.addEventListener("click", closeDropdown);
    window.openProjectDropdown = function(event, projectId) {
      event.stopPropagation(); closeDropdown();
      const btn = event.currentTarget; const rect = btn.getBoundingClientRect();
      const div = document.createElement("div"); div.className = "dropdown";
      div.style.top = (rect.bottom + window.scrollY) + "px"; div.style.left = (rect.left + window.scrollX) + "px";
      div.innerHTML = '<button onclick="editSpecificProject(\\'' + projectId + '\\')">配置项目</button><button class="danger-text" onclick="deleteSpecificProject(\\'' + projectId + '\\')">删除项目</button>';
      document.body.appendChild(div); activeDropdown = div;
    };
    window.editSpecificProject = function(id) { selectProject(id); openProjectModal(projects.find(p => p.id === id)); };
    window.deleteSpecificProject = async function(id) {
      const project = projects.find((p) => p.id === id);
      if (!project) return;
      const message = project.id === "default-rt" ? "这是默认 RT 项目，确认删除？删除后系统会自动重建。" : "确认彻底删除项目 [" + escapeHtml(project.name || project.id) + "] 吗？";
      if (!confirm(message)) return;
      try {
        await api("/admin/projects/" + encodeURIComponent(project.id), { method: "DELETE" });
        if (selectedProjectId === id) selectedProjectId = "default-rt";
        await refreshAll(); status(els.projectStatus, "项目已删除。");
      } catch (error) { status(els.projectStatus, error.message, true); }
    };
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
        closeAccountModal();
        await refreshAll();
        status(els.accountStatus, "账号已保存。");
      } catch (error) { status(els.accountStatus, error.message, true); }
    }
    window.editAccount = function(id) {
      const account = accounts.find((item) => item.id === id);
      if (!account) return;
      openAccountModal(account);
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
    window.copyKey = async function(key) { await navigator.clipboard.writeText(key); status(els.keyStatus, "API Key 已复制。"); };
    window.deleteKey = async function(key) {
      if (!confirm("确认删除这个 API Key？")) return;
      await api("/admin/keys/" + encodeURIComponent(key), { method: "DELETE" });
      await refreshAll();
    };
    function openKeyModal(keyRecord) {
      editingKeyId = keyRecord?.id || null;
      document.getElementById("key-modal-title").textContent = keyRecord ? "编辑凭证" : "创建新凭证";
      document.getElementById("key-name").value = keyRecord?.name || "";
      const select = document.getElementById("key-projects");
      select.innerHTML = '<option value="ALL">所有项目 (ALL)</option>' + projects.map(p => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || p.id) + '</option>').join('');
      const allowed = keyRecord ? keyRecord.projects : "ALL";
      for (const option of select.options) {
        if (allowed === "ALL") option.selected = option.value === "ALL";
        else option.selected = allowed.includes(option.value);
      }
      els.keyModal.classList.remove("hidden");
    }
    function closeKeyModal() {
      editingKeyId = null;
      els.keyModal.classList.add("hidden");
    }
    async function saveKey() {
      try {
        const name = document.getElementById("key-name").value.trim() || "未命名";
        const select = document.getElementById("key-projects");
        const selected = [...select.options].filter(o => o.selected).map(o => o.value);
        const allowAll = selected.includes("ALL");
        const payload = { name, projects: allowAll ? "ALL" : selected.length ? selected : ["default-rt"] };
        const existing = !!editingKeyId;
        const data = await api(existing ? "/admin/keys/" + encodeURIComponent(editingKeyId) : "/admin/keys", { method: existing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        if (!existing) await navigator.clipboard.writeText(data.key.id).catch(() => {});
        closeKeyModal();
        await refreshAll();
        status(els.keyStatus, existing ? "凭证已保存。" : "凭证已创建并尝试复制。");
      } catch (error) { status(els.keyStatus, error.message, true); }
    }
    window.editKey = function(id) { openKeyModal(globalKeys.find(k => k.id === id)); };
    async function saveRouting() {
      try {
        await api("/admin/routing", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxRetryAccounts: Number(document.getElementById("max-retry-accounts").value || 3), disableOnFailure: document.getElementById("disable-on-failure").checked }) });
        status(els.routingStatus, "路由策略已保存。");
      } catch (error) { status(els.routingStatus, error.message, true); }
    }
    async function exportAccounts() {
      const data = await api(projectPath("/accounts/export"));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = selectedProjectId + "-accounts.json";
      link.click();
      URL.revokeObjectURL(url);
      closeOpsModal();
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
        closeOpsModal();
        status(els.opsStatus, "账号已导入。");
      };
      input.click();
    }
    async function resetStats() {
      if (!confirm("确认清空真实 API 调用统计？")) return;
      await api("/admin/stats/reset", { method: "POST" });
      await refreshAll();
      closeOpsModal();
      status(els.opsStatus, "统计已清空。");
    }
    document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => setPage(btn.dataset.page)));
    els.menuToggle.addEventListener("click", () => {
      if (els.app.classList.contains("menu-open")) closeMenu();
      else openMenu();
    });
    els.menuScrim.addEventListener("click", closeMenu);
    document.getElementById("gate-submit").addEventListener("click", verifyLogin);
    els.token.addEventListener("keydown", (event) => { if (event.key === "Enter") verifyLogin(); });
    document.getElementById("reload").addEventListener("click", refreshAll);
    document.getElementById("logout").addEventListener("click", () => { localStorage.removeItem("hyhub-admin-token"); location.reload(); });
    document.getElementById("new-project").addEventListener("click", () => openProjectModal(null));
    document.getElementById("edit-project").addEventListener("click", () => openProjectModal(selectedProject()));
    document.getElementById("close-project-modal").addEventListener("click", closeProjectModal);
    document.getElementById("cancel-project-modal").addEventListener("click", closeProjectModal);
    els.projectModal.addEventListener("click", (event) => { if (event.target === els.projectModal) closeProjectModal(); });
    document.getElementById("new-account").addEventListener("click", () => openAccountModal(null));
    document.getElementById("close-account-modal").addEventListener("click", closeAccountModal);
    document.getElementById("cancel-account-modal").addEventListener("click", closeAccountModal);
    els.accountModal.addEventListener("click", (event) => { if (event.target === els.accountModal) closeAccountModal(); });
    document.getElementById("open-ops-modal").addEventListener("click", openOpsModal);
    document.getElementById("close-ops-modal").addEventListener("click", closeOpsModal);
    els.opsModal.addEventListener("click", (event) => { if (event.target === els.opsModal) closeOpsModal(); });
    document.getElementById("close-key-modal").addEventListener("click", closeKeyModal);
    els.keyModal.addEventListener("click", (event) => { if (event.target === els.keyModal) closeKeyModal(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeProjectModal(); closeAccountModal(); closeKeyModal(); closeOpsModal(); } });
    document.getElementById("save-project").addEventListener("click", saveProject);
    document.getElementById("save-account").addEventListener("click", saveAccount);
    document.getElementById("save-key").addEventListener("click", saveKey);
    document.getElementById("test-project-accounts").addEventListener("click", async () => { const data = await api(projectPath("/accounts/test-all"), { method: "POST" }); status(els.accountStatus, "检测完成：" + (data.okCount || 0) + "/" + (data.total || 0) + " 可用。"); await refreshAll(); });
    document.getElementById("batch-enable").addEventListener("click", () => batchToggle(true));
    document.getElementById("batch-disable").addEventListener("click", () => batchToggle(false));
    document.getElementById("create-key").addEventListener("click", () => openKeyModal(null));
    document.getElementById("copy-base-url").addEventListener("click", async () => { await navigator.clipboard.writeText(window.location.origin + "/v1"); status(els.keyStatus, "Base URL 已复制。"); });
    document.getElementById("save-routing").addEventListener("click", saveRouting);
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
    const id = env.ROUTER_STATE.idFromName("router");
    const stub = env.ROUTER_STATE.get(id);
    return stub.fetch(request);
  },
};

export class RouterState extends DurableObject<Env> {
  private accountsCache: AccountRecord[] | null = null;
  private statsCache: Record<string, AccountStat> | null = null;
  private healthCache: Record<string, AccountHealth> | null = null;
  private routingCache: RoutingSettings | null = null;
  private apiKeysCache: ApiKeyRecord[] | null = null;
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
    const saved = await this.ctx.storage.get<Array<ProjectRecord & { accountIds?: string[], apiKeys?: string[] }>>(PROJECTS_KEY);
    let projects = Array.isArray(saved)
      ? saved.map((project) => ({
        id: project.id,
        name: project.name,
        enabled: project.enabled !== false,
        modelMapping: project.modelMapping ?? {},
        disabledModels: project.disabledModels ?? [],
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
    
    const oldModels = await this.ctx.storage.get<unknown>("models");
    if (oldModels) {
      await this.ctx.storage.delete("models");
    }

    if (!Array.isArray(saved) || !saved.some((project) => project.id === DEFAULT_PROJECT_ID) || saved.some((project) => "accountIds" in project || "apiKeys" in project)) {
      await this.ctx.storage.put(PROJECTS_KEY, projects);
    }
    return this.projectsCache;
  }

  private async saveProjects(projects: ProjectRecord[]): Promise<void> {
    this.projectsCache = projects;
    await this.ctx.storage.put(PROJECTS_KEY, projects);
  }

  private async getApiKeys(): Promise<ApiKeyRecord[]> {
    if (this.apiKeysCache) return this.apiKeysCache;
    const savedKeys = await this.ctx.storage.get<ApiKeyRecord[]>(KEYS_KEY);
    if (Array.isArray(savedKeys)) {
      this.apiKeysCache = savedKeys;
      return this.apiKeysCache;
    }
    const savedProjects = await this.ctx.storage.get<Array<{ id: string; apiKeys?: string[] }>>(PROJECTS_KEY);
    const keys: ApiKeyRecord[] = [];
    if (Array.isArray(savedProjects)) {
      for (const project of savedProjects) {
        if (Array.isArray(project.apiKeys)) {
          for (const keyString of project.apiKeys) {
            keys.push({
              id: generateApiKeyId(),
              key: keyString,
              name: `迁移密钥 (${project.id})`,
              projects: [project.id],
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        }
      }
    }
    this.apiKeysCache = keys;
    await this.ctx.storage.put(KEYS_KEY, keys);
    return this.apiKeysCache;
  }

  private async saveApiKeys(keys: ApiKeyRecord[]): Promise<void> {
    this.apiKeysCache = keys;
    await this.ctx.storage.put(KEYS_KEY, keys);
  }

  private async getApiKey(apiKey: string): Promise<ApiKeyRecord | null> {
    if (!apiKey.trim()) return null;
    const keys = await this.getApiKeys();
    return keys.find((k) => k.key === apiKey) ?? null;
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

  private async pickCandidateAccount(candidates: { account: AccountRecord; project: ProjectRecord; upstreamModel: string }[], excluded: Set<string> = new Set()): Promise<{ account: AccountRecord; project: ProjectRecord; upstreamModel: string } | null> {
    const now = Date.now();
    const enabled = candidates.filter((item) => item.account.enabled && !excluded.has(item.account.id));
    const healthy = enabled.filter((item) => (item.account.unhealthyUntil ?? 0) <= now);
    const pool = healthy.length > 0 ? healthy : enabled;
    if (pool.length === 0) return null;
    const weightedPool = pool.flatMap((item) => Array.from({ length: normalizeWeight(item.account.weight) }, () => item));
    const cursor = await this.getCursor();
    const picked = weightedPool[cursor % weightedPool.length];
    await this.setCursor(cursor + 1);
    return picked;
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
    const apiKey = await this.getApiKey(getBearer(request));
    if (!apiKey) return json({ error: "Invalid API key" }, { status: 401 });
    
    const requestUrl = new URL(request.url);
    if (!requestUrl.pathname.startsWith("/v1/")) {
      return json({ error: "Only /v1/* routes are supported" }, { status: 404 });
    }

    const allProjects = await this.getProjects();
    const allowedProjects = apiKey.projects === "ALL" 
      ? allProjects.filter(p => p.enabled)
      : allProjects.filter(p => p.enabled && apiKey.projects.includes(p.id));
    
    if (allowedProjects.length === 0) return json({ error: "No available projects for this key" }, { status: 403 });

    if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
      return json({ object: "list", data: [] });
    }

    let requestBody = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

    let clientModel = "";
    let payload: { model?: string; [key: string]: unknown } | null = null;
    const modelRequestPaths = new Set(["/v1/chat/completions", "/v1/responses", "/v1/embeddings"]);

    if (requestBody && modelRequestPaths.has(requestUrl.pathname)) {
      try {
        payload = JSON.parse(new TextDecoder().decode(requestBody)) as { model?: string; [key: string]: unknown };
        clientModel = typeof payload.model === "string" ? payload.model.trim() : "";
      } catch {
        return json({ error: "Invalid JSON body" }, { status: 400 });
      }
    }

    const allAccounts = await this.getAccounts();
    const candidates: { account: AccountRecord; project: ProjectRecord; upstreamModel: string }[] = [];
    
    for (const project of allowedProjects) {
      if (clientModel && project.disabledModels.includes(clientModel)) continue;
      const upstreamModel = clientModel ? (project.modelMapping[clientModel] || clientModel) : "";
      const accounts = allAccounts.filter(a => a.projectId === project.id && a.enabled);
      for (const account of accounts) {
        candidates.push({ account, project, upstreamModel });
      }
    }

    if (candidates.length === 0) return json({ error: "Model not found or no available accounts" }, { status: 503 });

    const excluded = new Set<string>();
    const routing = await this.getRoutingSettings();
    const maxAttempts = Math.max(1, Math.min(routing.maxRetryAccounts, candidates.length || routing.maxRetryAccounts));
    let attempts = 0;

    while (true) {
      if (attempts >= maxAttempts) {
        return json({ error: "Retry limit reached", attempts, maxAttempts }, { status: 502 });
      }
      const candidate = await this.pickCandidateAccount(candidates, excluded);
      if (!candidate) return json({ error: "No available accounts" }, { status: 503 });
      
      const account = candidate.account;
      attempts += 1;
      const startedAt = Date.now();
      
      let currentRequestBody = requestBody;
      let requestBodyRewritten = false;
      
      if (payload && candidate.upstreamModel && clientModel !== candidate.upstreamModel) {
        payload.model = candidate.upstreamModel;
        const encoded = new TextEncoder().encode(JSON.stringify(payload));
        currentRequestBody = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
        requestBodyRewritten = true;
      }

      try {
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${account.apiKey}`);
        headers.delete("host");
        if (requestBodyRewritten) headers.delete("content-length");
        if (account.extraHeaders) {
          for (const [key, value] of Object.entries(account.extraHeaders)) headers.set(key, value);
        }
        const upstream = await fetch(this.buildUpstreamUrl(account, requestUrl), {
          method: request.method,
          headers,
          body: currentRequestBody,
          redirect: "manual",
        });
        if (isAccountFailureStatus(upstream.status)) {
          excluded.add(account.id);
          await this.markUnhealthy(account.id);
          await this.recordProxyResult(account.id, upstream.status, Date.now() - startedAt, `HTTP ${upstream.status}`);
          await this.recordModelHourlyResult(clientModel || "unknown", upstream.status, Date.now() - startedAt);
          if (routing.disableOnFailure) await this.disableAccount(account.id);
          if (excluded.size >= candidates.length || attempts >= maxAttempts) {
            return this.withProxyHeaders(upstream, account.id);
          }
          continue;
        }
        await this.markHealthy(account.id);
        await this.recordProxyResult(account.id, upstream.status, Date.now() - startedAt);
        await this.recordModelHourlyResult(clientModel || "unknown", upstream.status, Date.now() - startedAt);
        return this.withProxyHeaders(upstream, account.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        excluded.add(account.id);
        await this.markUnhealthy(account.id);
        await this.recordProxyResult(account.id, 502, Date.now() - startedAt, message);
        await this.recordModelHourlyResult(clientModel || "unknown", 502, Date.now() - startedAt);
        if (routing.disableOnFailure) await this.disableAccount(account.id);
        if (excluded.size >= candidates.length || attempts >= maxAttempts) {
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
      const projectStats = projects.map((project) => {
        const scoped = accounts.filter((account) => account.projectId === project.id);
        return {
          project: toPublicProject(project, scoped.length),
          summary: summarizeAccounts(scoped, statsMap, healthMap),
        };
      });
      return json({
        ok: true,
        projects: projectStats.map((item) => item.project),
        summary: summarizeAccounts(accounts, statsMap, healthMap),
        projectStats,
      });
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

    const projectMatch = pathname.match(/^\/admin\/projects\/([^/]+)$/);
    const keyMatch = pathname.match(/^\/admin\/keys\/([^/]+)$/);

    if (pathname === "/admin/keys" && request.method === "GET") {
      return json({ keys: await this.getApiKeys() });
    }

    if (pathname === "/admin/keys" && request.method === "POST") {
      const payload = await readJsonBody<ApiKeyInput>(request);
      const keys = await this.getApiKeys();
      const next = sanitizeApiKeyInput(payload);
      keys.push(next);
      await this.saveApiKeys(keys);
      return json({ ok: true, key: next }, { status: 201 });
    }

    if (keyMatch) {
      const keyId = decodeURIComponent(keyMatch[1]);
      const keys = await this.getApiKeys();
      const keyRecord = keys.find((item) => item.id === keyId);
      if (!keyRecord) return json({ error: "API Key not found" }, { status: 404 });

      if (request.method === "PATCH") {
        const payload = await readJsonBody<ApiKeyInput>(request);
        const next = sanitizeApiKeyInput({ ...payload, id: keyRecord.id }, keyRecord);
        const index = keys.findIndex((item) => item.id === keyRecord.id);
        keys[index] = next;
        await this.saveApiKeys(keys);
        return json({ ok: true, key: next });
      }

      if (request.method === "DELETE") {
        await this.saveApiKeys(keys.filter((item) => item.id !== keyId));
        return json({ ok: true });
      }
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

    const projectModelsDiscoverMatch = pathname.match(/^\/admin\/projects\/([^/]+)\/models\/discover$/);
    const modelDiscoverProjectId = projectModelsDiscoverMatch?.[1]
      ? decodeURIComponent(projectModelsDiscoverMatch[1])
      : pathname === "/admin/models/discover"
        ? DEFAULT_PROJECT_ID
        : "";

    if (modelDiscoverProjectId && request.method === "POST") {
      const project = await this.getProjectOrNotFound(modelDiscoverProjectId);
      if (project instanceof Response) return project;
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
        .filter((account) => account.projectId === modelDiscoverProjectId && account.enabled)
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
        .map(([model, labels]) => ({ model, publicModel: model, accounts: labels.sort((a, b) => a.localeCompare(b)) }))
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
    const [projects, accounts, statsMap, healthMap, allModelSettings, modelHourlyStats] = await Promise.all([
      this.getProjects(),
      this.getAccounts(),
      this.getStatsMap(),
      this.getHealthMap(),
      this.getAllModelSettings(),
      this.getModelHourlyStats(),
    ]);
    const summary = summarizeAccounts(accounts, statsMap, healthMap);
    const hours = lastHourKeys(24);
    const publicModels = projects.flatMap((project) => (allModelSettings[project.id]?.models ?? []).map((model) => prefixProjectModel(project, model)));
    const modelHealth = publicModels.map((model) => {
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
    const projectStats = projects.map((project) => {
      const scoped = accounts.filter((account) => account.projectId === project.id);
      return {
        project: toPublicProject(project, scoped.length),
        summary: summarizeAccounts(scoped, statsMap, healthMap),
        models: (allModelSettings[project.id]?.models ?? []).map((model) => prefixProjectModel(project, model)),
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
      models: publicModels,
      modelHealth,
      projectStats,
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

