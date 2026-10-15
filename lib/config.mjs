/**
 * 配置读写：设置保存在插件目录下的 settings.json。
 * 缺失字段自动用默认值补齐，便于后续版本新增字段时平滑升级。
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MODELS = [
    'gemini-4-argon',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash-image',
    'gemini-nano-banana-2.1',
    'gemini-3-pro-image',
    'gemini-3-flash-preview',
];

export const DEFAULT_SETTINGS = {
    // 独立服务监听地址与端口（不经过 SillyTavern 的 Express app，因此不受 CSRF 影响）
    host: '0.0.0.0',
    port: 8050,

    // Express API Key 列表，支持多把轮换
    expressKeys: [],
    projectId: '',
    location: 'global',

    // 出网代理，例如 http://192.168.31.115:7890；留空表示直连（或已由全局 VPN 接管）
    proxyUrl: '',

    // 保护本端点的口令，留空表示不校验（仅限本机/局域网使用时可留空）
    accessKey: '',

    // 原生思考控制：off（推荐，给酒馆预设思维链让路）/ request（跟随客户端）/ console（强制这里设的档位）
    nativeThinkingMode: 'off',
    thinkingLevel: '',
    prefillSuppressThinking: true,

    // 采样参数策略：auto / deprecated / allowed
    samplingPolicy: 'auto',

    // 通道选择：express（官方 API Key）/ cookie（Cookie 直连）/ auto（Express 被限流时自动转 Cookie）
    channel: 'auto',

    // Cookie 直连用的浏览器 Cookie，多条轮换
    cookies: [],
    // Cookie 通道的项目 ID，留空则复用上面的 projectId
    cookieProjectId: '',
    // Cookie 通道的安全过滤：OFF（关掉，角色扮演用）/ BLOCK_NONE（照常评分但不拦截）
    cookieSafety: 'OFF',

    // 预填充（末尾 assistant 消息）转成续写指令时追加的提示语
    prefillInstruction: '',

    models: DEFAULT_MODELS.slice(),
    debug: false,
};

const SETTINGS_FILE = 'settings.json';

function mergeDefaults(saved) {
    const out = { ...DEFAULT_SETTINGS };
    if (!saved || typeof saved !== 'object') return out;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const v = saved[key];
        if (v === undefined || v === null) continue;
        const def = DEFAULT_SETTINGS[key];
        if (Array.isArray(def)) {
            out[key] = Array.isArray(v) ? v : [];
        } else if (typeof def === 'boolean') {
            out[key] = Boolean(v);
        } else if (typeof def === 'number') {
            out[key] = Number(v) || def;
        } else {
            out[key] = typeof v === 'string' ? v : String(v);
        }
    }
    return out;
}

/**
 * 把 "a,b" / "a\nb" / ["a","b"] 统一成去空白后的数组。
 *
 * 分隔符必须同时认换行和逗号：早期版本只按逗号切，而设置页的模型列表/Key 列表
 * 都是每行一个，整块文本会被当成一个元素存进配置，酒馆拉到的模型 id 就成了一坨。
 * 数组元素内部也拆一遍，这样历史上已经写坏的 settings.json 在下次读取时自动修复。
 */
const LIST_SEPARATOR = /[\n,;]+/;

export function parseKeyList(value) {
    const parts = Array.isArray(value)
        ? value.flatMap(s => String(s).split(LIST_SEPARATOR))
        : String(value || '').split(LIST_SEPARATOR);
    return parts.map(s => s.trim()).filter(Boolean);
}

/**
 * 只按换行拆，不动逗号。
 * Cookie 字符串内部可能含逗号（值或 base64 里很常见），所以 Cookie 列表不能用 parseKeyList，
 * 否则一条 Cookie 会被切成好几段直接报废。
 */
export function splitLines(value) {
    const parts = Array.isArray(value)
        ? value.flatMap(s => String(s).split(/[\r\n]+/))
        : String(value || '').split(/[\r\n]+/);
    return parts.map(s => s.trim()).filter(Boolean);
}

export function loadSettings(pluginDir) {
    const file = path.join(pluginDir, SETTINGS_FILE);
    try {
        if (fs.existsSync(file)) {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            return mergeDefaults(raw);
        }
    } catch (err) {
        console.error(`[vertex2openai] 读取 settings.json 失败，改用默认配置：${err.message}`);
    }
    return { ...DEFAULT_SETTINGS };
}

export function saveSettings(pluginDir, settings) {
    const file = path.join(pluginDir, SETTINGS_FILE);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return file;
}

export function settingsPath(pluginDir) {
    return path.join(pluginDir, SETTINGS_FILE);
}
