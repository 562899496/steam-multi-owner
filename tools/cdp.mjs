/*
 * 极简 Chrome DevTools Protocol 客户端（Node 24 自带 WebSocket，无需依赖）。
 * 用来：启动一个真实 Chrome、加载扩展、在扩展上下文里跑断言。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function httpGetJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout ' + url)), timeoutMs);
    fetch(url).then(async (res) => {
      clearTimeout(timer);
      resolve(await res.json());
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function launchChrome({ extensionPath, port = 9222, chromePath, headless = true, extraArgs = [] }) {
  const profileDir = await mkdtemp(join(tmpdir(), 'smo-chrome-'));
  const args = [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  if (extensionPath) {
    args.unshift('--disable-extensions-except=' + extensionPath);
    args.unshift('--load-extension=' + extensionPath);
  }
  args.push(...extraArgs);

  const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => {
    if (stderrChunks.length < 400) stderrChunks.push(String(chunk));
  });
  const deadline = Date.now() + 25000;
  let version = null;
  while (Date.now() < deadline) {
    try {
      version = await httpGetJson(`http://127.0.0.1:${port}/json/version`, 1500);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!version) {
    child.kill();
    throw new Error('Chrome 启动超时，未能连上 CDP');
  }
  return {
    child,
    port,
    version,
    profileDir,
    stderr: () => stderrChunks.join(''),
    async close() {
      try { child.kill(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400));
      try { await rm(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

export class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
  }

  static async open(wsUrl) {
    const session = new CdpSession(wsUrl);
    await session.connect();
    return session;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('WebSocket 错误: ' + (e.message || 'unknown'))));
      this.ws.addEventListener('message', (event) => this._onMessage(event.data));
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message + ' (' + JSON.stringify(msg.error.data ?? '') + ')'));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.exceptions.push(d.exception?.description || d.text || 'unknown exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      this.consoleErrors.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    const handlers = this.listeners.get(msg.method) || [];
    for (const h of handlers) h(msg.params, msg);
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待事件超时: ' + method)), timeoutMs);
      const handler = (params) => {
        clearTimeout(timer);
        const arr = this.listeners.get(method) || [];
        this.listeners.set(method, arr.filter((h) => h !== handler));
        resolve(params);
      };
      this.on(method, handler);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面/worker 上下文里执行表达式；awaitPromise 时返回真正的值。 */
  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error('求值失败: ' + (d.exception?.description || d.text));
    }
    return result.result.value;
  }

  async enableRuntime() {
    await this.send('Runtime.enable');
    await this.send('Log.enable').catch(() => {});
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

export async function listTargets(port) {
  return httpGetJson(`http://127.0.0.1:${port}/json/list`);
}

/** Target.getTargets 不返回 webSocketDebuggerUrl，从 /json/list 里按 id 补上。 */
export async function wsUrlFor(port, targetId) {
  const targets = await listTargets(port);
  const hit = targets.find((t) => t.id === targetId);
  if (hit && hit.webSocketDebuggerUrl) return hit.webSocketDebuggerUrl;
  return `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
}

export async function waitForTarget(port, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port);
    const hit = targets.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
