/**
 * DSH 插件：Steam 多账号拥有检查
 *
 * 和 Chrome 扩展共用同一套纯逻辑（lib/core.js 是 src/lib/core.js 的同步副本），
 * 数据也共用同一种格式：把扩展里「导出 JSON」的内容直接导入到这里即可，
 * 于是不需要在 DSH 里再登录一次 Steam，也不需要 API key。
 *
 * 提供的工具：
 *   steam_owner_check     查一款游戏被我的哪些账号拥有（支持 AppID / 商店链接 / 游戏名）
 *   steam_owner_accounts  查看 / 添加 / 删除账号
 *   steam_owner_data      导入 / 导出 / 用 Web API 同步
 *
 * @module dsh-steam-multi-owner
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import './core.js';
import './steam-api.js';

export const name = 'steam-multi-owner';
export const inject = ['tools'];

const Core = globalThis.SteamOwnerCore;
const Api = globalThis.SteamApi;

/** 插件配置。 */
export const Config = z.object({
  /** Steam Web API key；只在「用 API 同步」时才需要。 */
  apiKey: z.string().default(''),
  /** 数据文件路径；留空则用 ~/.dsh/storages/steam-multi-owner.json。 */
  dataFile: z.string().default(''),
  /** 没有显式指定时，把哪个账号当成"当前登录的账号"。 */
  defaultCurrentAccount: z.string().default(''),
});

function defaultDataFile() {
  return join(homedir(), '.dsh', 'storages', 'steam-multi-owner.json');
}

/**
 * 插件版本号。
 *
 * 试过两种"聪明"办法都不行：运行时读 package.json、动态 import 同目录的 version.js ——
 * 在 DSH 的加载器下都拿到 unknown（import.meta.url 与相对解析都不保证可用）。
 * 所以改成最笨最稳的：源码里放一个字面量占位符，
 * 由 tools/pack-plugin.mjs 在打包时替换成 dsh/package.json 里的真实版本号。
 * 零运行时 IO、零动态解析，加载器怎么变都不影响。
 */
const PLUGIN_VERSION = '__SMO_PLUGIN_VERSION__';

/** 开发目录里还是占位符，就显示 dev；打包后的副本显示真实版本号。 */
function pluginVersion() {
  return /^__.*__$/.test(PLUGIN_VERSION) ? 'dev' : PLUGIN_VERSION;
}

const EMPTY = { version: 1, accounts: [], libraries: {}, settings: {} };

async function loadStore(file) {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return {
      version: parsed.version || 1,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      libraries: parsed.libraries && typeof parsed.libraries === 'object' ? parsed.libraries : {},
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      importedAt: parsed.importedAt || null,
      source: parsed.source || null,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return Object.assign({}, EMPTY);
    throw new Error('读取数据文件失败（' + file + '）：' + err.message);
  }
}

async function saveStore(file, store) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), 'utf8');
}

function indexOf(store) {
  const payload = [];
  for (const account of store.accounts) {
    const lib = store.libraries[account.id];
    if (!lib) continue;
    payload.push({
      accountId: account.id,
      label: Core.accountLabel(account),
      appids: lib.appids || [],
      // 统计要分清"游戏本体"和"DLC/工具等条目"，否则 305 会被当成 305 款游戏
      gameAppids: Array.isArray(lib.gameAppids) ? lib.gameAppids : null,
      kind: lib.kind || 'apps',
      updatedAt: lib.updatedAt || null,
    });
  }
  return Core.buildIndex(payload);
}

function syncedCountOf(store) {
  return store.accounts.filter((a) => store.libraries[a.id]).length;
}

function text(value) {
  return [{ type: 'text', text: value }];
}

/**
 * 去掉对象里的 undefined 键（递归），并在最外层做一次 DSH 的 lossless JSON 自检。
 *
 * DSH 要求工具返回值必须能无损 JSON 序列化：只要有一个 undefined / 函数 / Symbol /
 * NaN / -0 / 非普通原型对象，整次工具调用就会以
 * `tool "..." returned invalid output: value is not lossless JSON` 失败，
 * 而且不会告诉你是哪个字段。所以这里直接用 DSH 自己的校验器先自检，
 * 不通过就抛出带精确路径的错误，而不是把这个含糊的错误留给调用方。
 */
function clean(value) {
  const result = stripUndefined(value);
  const violation = firstViolation(result);
  if (violation) {
    throw new Error('工具返回值不是 DSH 可接受的 lossless JSON，首个违规位置：' + violation);
  }
  return result;
}

/**
 * 是否满足 DSH 的 lossless JSON 规则。
 * 规则照抄 @deepseek-ai/dsh-util-values 的 walkJsonValue（见 tools/diagnose-plugin-output.mjs，
 * 那个脚本用**真实的**校验器交叉验证这里的实现，保证两边判定一致）。
 * 之所以自己实现而不 import：插件少一个运行时依赖，就少一种加载失败的可能。
 */
function isLosslessJson(value) {
  return firstViolation(value) === null;
}

/** 递归剔除 undefined（JSON 里不存在这个值）。 */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = stripUndefined(item);
    }
    return out;
  }
  return value;
}

/** 返回第一个不合规的路径；完全合规返回 null。 */
function firstViolation(value, path = 'value') {
  if (value === undefined) return path + ' = undefined';
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return null;
  if (type === 'number') {
    if (!Number.isFinite(value)) return path + ' = ' + value + '（JSON 没有 NaN/Infinity）';
    if (Object.is(value, -0)) return path + ' = -0';
    return null;
  }
  if (type !== 'object') return path + ' 的类型是 ' + type + '（不是 JSON 类型）';
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return path + ' 的数组原型异常';
    if (Reflect.ownKeys(value).length !== value.length + 1) return path + ' 的数组带有额外的自有键';
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) return path + '[' + i + '] 是稀疏的';
      const hit = firstViolation(value[i], path + '[' + i + ']');
      if (hit) return hit;
    }
    return null;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return path + ' 的原型不是 Object.prototype';
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return path + ' 带有 Symbol 键';
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) return path + '.' + key + ' 不可枚举';
    const hit = firstViolation(value[key], path + '.' + String(key));
    if (hit) return hit;
  }
  return null;
}

async function resolveQuery(store, index, query) {
  const appid = Core.parseAppId(query);
  if (appid) return { appid, name: lookupName(store, appid) };
  // 不是 AppID 就按名字模糊找
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return null;
  const hits = [];
  const seen = new Set();
  for (const account of store.accounts) {
    const names = (store.libraries[account.id] || {}).names || {};
    for (const [id, gameName] of Object.entries(names)) {
      const key = Number(id);
      if (seen.has(key)) continue;
      if (String(gameName).toLowerCase().includes(needle)) {
        seen.add(key);
        hits.push({ appid: key, name: gameName });
      }
    }
  }
  hits.sort((a, b) => a.name.length - b.name.length);
  return { matches: hits.slice(0, 10) };
}

function lookupName(store, appid) {
  for (const account of store.accounts) {
    const names = (store.libraries[account.id] || {}).names || {};
    if (names[appid]) return names[appid];
  }
  return null;
}

function describeVerdict(result, store) {
  const lines = [];
  const current = store.settings.currentAccountId || '';
  lines.push('AppID ' + result.appid + (result.name ? '（' + result.name + '）' : ''));
  lines.push(result.badge.long);
  if (store.accounts.length) {
    lines.push('');
    for (const account of store.accounts) {
      const owns = result.owners.some((o) => o.accountId === account.id);
      const mark = owns ? '已拥有' : (store.libraries[account.id] ? '未拥有' : '未同步');
      const me = account.id === current ? ' ←当前登录' : '';
      lines.push('  · ' + Core.accountLabel(account) + '：' + mark + me);
    }
  }
  if (result.badge.warn) {
    lines.push('');
    lines.push('结论：当前账号不需要重复购买。');
  }
  return lines.join('\n');
}

/**
 * 注册三个工具。
 *
 * 每个注册都包在 ctx.effect 里：DSH 在 bundle 被停用/卸载时依靠 effect 的清理函数
 * 回收注册；直接调用 register 而不登记 effect，会让旧实现留在工具表里继续应答
 * （踩过：改了代码、开关了 bundle，仍然是旧逻辑在回话）。
 *
 * @param ctx - 带 tools 注册表的上下文。
 * @param config - 插件配置。
 */
export function apply(ctx, config) {
  return applyInner(ctx, config);
}

function applyInner(ctx, config) {
  const dataFile = config.dataFile && config.dataFile.trim() ? config.dataFile.trim() : defaultDataFile();

  const read = async () => {
    const store = await loadStore(dataFile);
    if (!store.settings.currentAccountId && config.defaultCurrentAccount) {
      store.settings.currentAccountId = config.defaultCurrentAccount;
    }
    return store;
  };

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'steam_owner_check',
    description:
      '查询一款 Steam 游戏是否已经被"我的任意一个 Steam 账号"拥有，并指出是哪个账号拥有。' +
      '用于避免多账号玩家重复购买。输入可以是 AppID、Steam 商店链接、或游戏名（模糊匹配）。' +
      '数据来自本地合并索引；未同步的账号会被明确标出，不会假装"没有这款游戏"。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'AppID（如 1245620）、Steam 商店链接，或游戏名的一部分。',
      },
      currentAccountId: {
        type: 'string',
        description: '把哪个账号视为"当前登录账号"；省略则用已保存的设置。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true, description: '是否定位到了具体游戏' },
          appid: { type: 'integer', description: '定位到的 AppID' },
          name: { type: 'string', description: '游戏名（如果有）' },
          owned: { type: 'boolean', description: '是否被任意账号拥有' },
          ownedByCurrent: { type: 'boolean', description: '当前登录账号是否拥有' },
          ownedByOtherOnly: { type: 'boolean', description: '只有其他账号拥有（当前账号没有）' },
          owners: { type: 'array', items: { type: 'string' }, description: '拥有这款游戏的账号名' },
          others: { type: 'array', items: { type: 'string' }, description: '除当前账号外拥有的账号名' },
          needsPurchase: { type: 'boolean', description: '是否真的需要购买（没有被任何账号拥有才为真）' },
          incomplete: { type: 'boolean', description: '是否有账号没同步，结论不完整' },
          verdict: { type: 'string', description: '给人看的一句话结论' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                appid: { type: 'integer', required: true },
                name: { type: 'string' },
                ownedBy: { type: 'array', items: { type: 'string' } },
              },
            },
            description: '按名字搜索时的候选列表',
          },
          report: { type: 'string', description: '逐账号明细（多行文本）' },
        },
      },
      render: (_args, value) => text(value.report || value.verdict || ''),
    },
    async execute(args) {
      const store = await read();
      const index = indexOf(store);
      if (!store.accounts.length) {
        return clean({
          found: false,
          verdict: '还没有配置任何 Steam 账号。用 steam_owner_data 导入 Chrome 扩展导出的 JSON，或先用 steam_owner_accounts 添加账号。',
          report: '数据文件：' + dataFile + '\n当前没有任何账号。',
        });
      }
      const current = args.currentAccountId || store.settings.currentAccountId || '';

      const resolved = await resolveQuery(store, index, args.query);
      if (!resolved) {
        return clean({ found: false, verdict: '没看懂这个输入，请给 AppID、商店链接或至少两个字的游戏名。', report: '' });
      }

      let appid = resolved.appid;
      let gameName = resolved.name;
      let candidates;
      if (resolved.matches) {
        if (!resolved.matches.length) {
          return clean({ found: false, verdict: '在已缓存的游戏名里找不到含「' + args.query + '」的游戏。', report: '' });
        }
        candidates = resolved.matches.map((m) => {
          const r = Core.ownedByOthers(index, m.appid, store.accounts, current);
          return { appid: m.appid, name: m.name, ownedBy: r.owners.map((o) => o.label) };
        });
        if (candidates.length > 1) {
          const lines = candidates.map((c) =>
            '  · ' + c.name + '（AppID ' + c.appid + '）：' + (c.ownedBy.length ? '已拥有 — ' + c.ownedBy.join('、') : '没有账号拥有'));
          return clean({
            found: false,
            candidates,
            verdict: '按名字匹配到 ' + candidates.length + ' 个游戏，需要你确认是哪一个。',
            report: '按名字匹配到 ' + candidates.length + ' 个游戏：\n' + lines.join('\n'),
          });
        }
        appid = candidates[0].appid;
        gameName = candidates[0].name;
      }

      const detail = Core.ownedByOthers(index, appid, store.accounts, current);
      const badge = Core.decideBadge(detail, {
        accountCount: store.accounts.length,
        syncedCount: syncedCountOf(store),
      });
      const result = {
        found: true,
        appid,
        name: gameName || undefined,
        owned: detail.owned,
        ownedByCurrent: detail.ownedByCurrent,
        ownedByOtherOnly: detail.ownedByOtherOnly,
        owners: detail.owners.map((o) => o.label),
        others: detail.others.map((o) => o.label),
        needsPurchase: !detail.owned,
        incomplete: !!badge.incomplete,
        candidates,
        verdict: badge.long,
        report: describeVerdict({ appid, name: gameName, badge, owners: detail.owners }, store),
      };
      return clean(result);
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '查询 Steam 多账号拥有：' + args.query,
      kind: 'read',
      rawInput: args.query,
    }),
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'steam_owner_accounts',
    description:
      '管理本地保存的 Steam 账号列表：查看（list）、添加（add）、删除（remove）、清空（clear）。' +
      '添加时只需要 SteamID64 / 自定义 ID / 个人资料链接；同步库请用 steam_owner_data。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'remove', 'clear'],
        description: 'list | add | remove | clear',
      },
      label: { type: 'string', description: 'add 时的备注名，例如"小号"' },
      key: { type: 'string', description: 'add 时的 SteamID64 / 自定义 ID / 个人资料链接' },
      accountId: { type: 'string', description: 'remove 时的账号 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accounts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                identity: { type: 'string' },
                gameCount: { type: 'integer', description: '游戏本体数量；未知时省略' },
                entryCount: { type: 'integer', description: '索引条目数（含 DLC/工具/共享）' },
                countText: { type: 'string', description: '给人看的数量，如 "71 款游戏（另 234 项 DLC/工具）"' },
                updatedAt: { type: 'string' },
                isCurrent: { type: 'boolean' },
              },
            },
          },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.report),
    },
    async execute(args) {
      const store = await read();
      if (args.action === 'add') {
        const parsed = Core.parseAccountKey(args.key || '');
        if (!parsed) throw new Error('无法识别这个账号标识：' + (args.key || '(空)'));
        const label = (args.label && args.label.trim()) || parsed.vanity || parsed.steamId64;
        const account = Object.assign(
          { id: Core.makeAccountId(label, store.accounts), label, createdAt: new Date().toISOString() },
          parsed,
        );
        store.accounts = Core.dedupeAccounts(store.accounts.concat([account]));
        await saveStore(dataFile, store);
      } else if (args.action === 'remove') {
        if (!args.accountId) throw new Error('remove 需要 accountId');
        const before = store.accounts.length;
        store.accounts = store.accounts.filter((a) => a.id !== args.accountId);
        if (store.accounts.length === before) throw new Error('没有这个账号：' + args.accountId);
        delete store.libraries[args.accountId];
        if (store.settings.currentAccountId === args.accountId) store.settings.currentAccountId = '';
        await saveStore(dataFile, store);
      } else if (args.action === 'clear') {
        store.accounts = [];
        store.libraries = {};
        store.settings = {};
        await saveStore(dataFile, store);
      }

      const index = indexOf(store);
      const current = store.settings.currentAccountId || '';
      const accounts = store.accounts.map((a) => {
        const lib = store.libraries[a.id];
        const games = Core.gameCountOf(lib);
        return {
          id: a.id,
          label: Core.accountLabel(a),
          identity: a.steamId64 || a.vanity || '登录会话',
          // 游戏数是主数字；条目数单独给出（含 DLC/工具），两者不能混为一谈
          gameCount: games == null ? undefined : games,
          entryCount: lib ? Core.entryCountOf(lib) : undefined,
          countText: lib ? Core.describeCount(lib) : '未同步',
          updatedAt: lib ? lib.updatedAt : undefined,
          isCurrent: a.id === current,
        };
      });
      const lines = accounts.map((a) =>
        '  · ' + a.label + '（' + a.identity + '）：' + a.countText +
        (a.updatedAt ? '，' + a.updatedAt.slice(0, 10) : '') +
        (a.isCurrent ? ' ←当前登录' : ''));
      const summary = Core.summarize(index, store.accounts);
      return clean({
        accounts,
        report: store.accounts.length
          ? '共 ' + store.accounts.length + ' 个账号，已同步 ' + summary.syncedCount + ' 个，' +
            Core.describeIndex(index) + '：\n' + lines.join('\n')
          : '还没有任何账号。\n数据文件：' + dataFile,
      });
    },
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'steam_owner_data',
    description:
      '导入 / 导出 / 刷新多账号拥有数据。' +
      'import：直接粘贴 Chrome 扩展「导出 JSON」的内容（推荐，不需要 API key，也不需要重新登录 Steam）。' +
      'export：导出当前数据，可拿去喂手机版页面。' +
      'sync：用 Steam Web API key 拉取公开档案的库（需要 apiKey 与公开的「游戏详情」）。' +
      'set_current：指定哪个账号是"当前登录账号"。' +
      'status：查看数据概况。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['import', 'export', 'sync', 'set_current', 'status'],
        description: 'import | export | sync | set_current | status',
      },
      json: { type: 'string', description: 'import：扩展导出的 JSON 文本' },
      file: { type: 'string', description: 'import：改为从文件读取 JSON 的路径' },
      accountId: { type: 'string', description: 'sync / set_current 针对的账号 id；sync 省略则同步全部' },
      merge: { type: 'boolean', description: 'import 时是否与现有数据合并（默认 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dataFile: { type: 'string', required: true },
          accountCount: { type: 'integer', required: true },
          syncedCount: { type: 'integer', required: true },
          appCount: { type: 'integer', required: true },
          results: { type: 'array', items: { type: 'string' }, description: '同步结果或错误' },
          json: { type: 'string', description: 'export 时的数据' },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.report),
    },
    async execute(args) {
      const store = await read();
      const results = [];
      let exported = null;

      if (args.action === 'import') {
        let raw = args.json;
        if (!raw && args.file) raw = await readFile(args.file, 'utf8');
        if (!raw) throw new Error('import 需要 json 或 file 参数');
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (err) {
          throw new Error('JSON 解析失败：' + err.message);
        }
        if (!payload || !Array.isArray(payload.accounts)) throw new Error('这份 JSON 里没有 accounts 数组，不像是本扩展导出的文件');
        const merge = args.merge !== false;
        store.accounts = merge ? Core.dedupeAccounts(store.accounts.concat(payload.accounts)) : payload.accounts;
        store.libraries = merge ? Object.assign({}, store.libraries, payload.libraries || {}) : (payload.libraries || {});
        if (payload.settings && payload.settings.currentAccountId && !store.settings.currentAccountId) {
          store.settings.currentAccountId = payload.settings.currentAccountId;
        }
        store.importedAt = new Date().toISOString();
        store.source = 'chrome-extension-export';
        await saveStore(dataFile, store);
      } else if (args.action === 'export') {
        exported = JSON.stringify({
          exportedAt: new Date().toISOString(),
          version: 1,
          accounts: store.accounts,
          libraries: store.libraries,
          settings: Object.assign({}, store.settings, { apiKey: '' }),
        });
        store.settings = store.settings || {};
      } else if (args.action === 'set_current') {
        if (!store.accounts.some((a) => a.id === args.accountId)) throw new Error('没有这个账号：' + args.accountId);
        store.settings.currentAccountId = args.accountId;
        await saveStore(dataFile, store);
      } else if (args.action === 'sync') {
        const key = config.apiKey && config.apiKey.trim();
        if (!key && !store.accounts.some((a) => a.apiKey)) {
          throw new Error('同步需要 Steam Web API key：请在插件 config.apiKey 里填一个，或在账号上带独立 apiKey');
        }
        const targets = args.accountId ? store.accounts.filter((a) => a.id === args.accountId) : store.accounts;
        if (!targets.length) throw new Error('没有要同步的账号');
        for (const account of targets) {
          try {
            const lib = await Api.fetchLibrary(fetch, account, { apiKey: key });
            store.libraries[account.id] = {
              appids: lib.appids,
              names: lib.names || {},
              method: lib.method,
              updatedAt: new Date().toISOString(),
            };
            if (lib.steamId64) account.steamId64 = lib.steamId64;
            results.push(account.label + '：' + Core.describeCount(store.libraries[account.id]) + '（' + lib.method + '）');
          } catch (err) {
            results.push(account.label + ' 失败：' + err.message);
          }
          await Api.sleep(400);
        }
        await saveStore(dataFile, store);
      }

      const index = indexOf(store);
      const summary = Core.summarize(index, store.accounts);
      const report = [
        '插件版本：v' + pluginVersion(),
        '数据文件：' + dataFile,
        '账号 ' + summary.accountCount + ' 个（已同步 ' + summary.syncedCount + '），' + Core.describeIndex(index),
        store.importedAt ? '最近导入：' + store.importedAt : null,
        results.length ? '结果：\n  ' + results.join('\n  ') : null,
      ].filter(Boolean).join('\n');

      return clean({
        dataFile,
        accountCount: summary.accountCount,
        syncedCount: summary.syncedCount,
        appCount: summary.uniqueAppCount,
        results: results.length ? results : undefined,
        json: exported || undefined,
        report,
      });
    },
  })));
}
