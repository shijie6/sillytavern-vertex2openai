/**
 * Cookie 直连通道：冒充 Cloud Console 前端调它私有的 batchGraphql 端点。
 *
 * 与 Express 通道的区别：
 * - 端点不同：cloudconsole-pa.clients6.google.com，而不是官方的 aiplatform.googleapis.com
 * - 认证不同：用浏览器 Cookie 里的 SAPISID 族算出三段式 SAPISIDHASH
 * - 响应不同：不是 SSE，而是连续拼接的 JSON 对象流（要靠括号配对切分）
 * - 配额池不同：走的是网页端那一份，所以 Express 被限流时它往往还能用
 *
 * 风险：这是未公开的私有接口，Google 随时可以改签名或封掉；Cookie 等同完整的 Google 账号权限，
 * 泄露后果比 API Key 严重得多。只放自己设备上用，别外传、别填到别人的服务里。
 */

import crypto from 'node:crypto';

export const BATCH_GRAPHQL_URL =
    'https://cloudconsole-pa.clients6.google.com/v3/entityServices/AiplatformEntityService'
    + '/schemas/AIPLATFORM_GRAPHQL:batchGraphql'
    + '?key=AIzaSyCI-zsRP85UVOi0DjtiCwWBwQ1djDy741g&prettyPrint=false';

// StreamGenerateContent 的固定签名。Google 会轮换它，失效时表现为 querySignature 校验失败。
const QUERY_SIGNATURE = '2/Hc4FpJfYmM+gO5TB0hcjYY0Iwj0rqLIVDZOhurBbu/I=';
const OPERATION_NAME = 'StreamGenerateContent';
const SAPISIDHASH_ORIGIN = 'https://console.cloud.google.com';

const SAFETY_CATEGORIES = [
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_HARASSMENT',
    // 缺了这一条，越狱式提示词（角色扮演预设很常见）可能被默认过滤把"正文"拦掉、
    // 思考却照常流出，表现为只有思考没有正文。
    'HARM_CATEGORY_JAILBREAK',
];

export function parseCookieValue(cookieStr, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = String(cookieStr || '').match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
    return m ? m[1].trim() : '';
}

function computeHash(value) {
    const ts = Math.floor(Date.now() / 1000);
    return `${ts}_${crypto.createHash('sha1').update(`${ts} ${value} ${SAPISIDHASH_ORIGIN}`).digest('hex')}`;
}

/** 构建三段式 Authorization 头（每次调用都重算，因为里面带实时时间戳）。 */
export function buildAuthorization(cookieStr) {
    const sapisid = parseCookieValue(cookieStr, 'SAPISID');
    const sapisid1p = parseCookieValue(cookieStr, '__Secure-1PAPISID');
    const sapisid3p = parseCookieValue(cookieStr, '__Secure-3PAPISID');

    const primary = sapisid || sapisid3p || sapisid1p;
    if (!primary) return null;

    return `SAPISIDHASH ${computeHash(sapisid || primary)}`
        + ` SAPISID1PHASH ${computeHash(sapisid1p || primary)}`
        + ` SAPISID3PHASH ${computeHash(sapisid3p || primary)}`;
}

export function buildHeaders(cookieStr) {
    const auth = buildAuthorization(cookieStr);
    if (!auth) return null;
    return {
        authorization: auth,
        cookie: cookieStr,
        'content-type': 'application/json',
        'x-goog-authuser': '0',
        'x-same-domain': '1',
        origin: SAPISIDHASH_ORIGIN,
        referer: `${SAPISIDHASH_ORIGIN}/`,
    };
}

export function validateCookie(cookieStr) {
    const hasSapisid = Boolean(
        parseCookieValue(cookieStr, 'SAPISID') || parseCookieValue(cookieStr, '__Secure-3PAPISID'),
    );
    const hasSid = Boolean(
        parseCookieValue(cookieStr, 'SID') || parseCookieValue(cookieStr, '__Secure-1PSID'),
    );

    if (hasSapisid && hasSid) return { valid: true, message: '完整（有 SAPISID 和 SID）' };
    if (hasSapisid) return { valid: true, message: '部分（有 SAPISID 但缺 SID，可试）' };
    if (hasSid) return { valid: false, message: '无效（有 SID 但缺 SAPISID，算不出认证头）' };
    return { valid: false, message: '无效（没找到 SAPISID / SID）' };
}

function buildRequestContext(projectId) {
    const now = Date.now();
    return {
        clientVersion: 'boq_cloud-boq-clientweb-vertexaistudio_20260609.06_p0',
        pagePath: '/agent-platform/studio/multimodal',
        pageViewId: now % 10 ** 15,
        trackingId: String((now * 1000) % 10 ** 17),
        backendOverrides: {},
        clientSessionId: crypto.randomUUID().toUpperCase(),
        projectId,
        selectedPurview: { projectId },
        jurisdiction: 'global',
        experimentFlagsBinary: '',
        localizationData: { locale: 'zh_CN', timezone: 'Asia/Shanghai' },
    };
}

/**
 * 构造 batchGraphql 请求体。
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.modelName
 * @param {Array} args.contents 与 Express 通道同构
 * @param {object} [args.systemInstruction]
 * @param {object} args.generationConfig
 * @param {boolean} [args.grounded] 是否挂 Google 搜索工具
 * @param {string} [args.safetyThreshold] OFF（关掉过滤器）或 BLOCK_NONE（照常评分但不拦截）
 */
export function buildBody({
    projectId, modelName, contents, systemInstruction, generationConfig,
    grounded = false, safetyThreshold = 'OFF',
}) {
    const variables = {
        contents,
        model: `projects/${projectId}/locations/global/publishers/google/models/${modelName}`,
        generationConfig,
        safetySettings: SAFETY_CATEGORIES.map(category => ({ category, threshold: safetyThreshold })),
    };

    if (systemInstruction) variables.systemInstruction = systemInstruction;
    if (grounded) variables.tools = [{ googleSearch: {} }];

    return {
        requestContext: buildRequestContext(projectId),
        querySignature: QUERY_SIGNATURE,
        operationName: OPERATION_NAME,
        variables,
    };
}

/**
 * batchGraphql 的流式响应是一串直接拼接的 JSON 对象（没有换行分隔），
 * 只能靠大括号配一切分。字符串内部的括号要跳过。
 */
export function createJsonObjectSplitter(onObject) {
    let buffer = '';

    const drain = () => {
        for (;;) {
            const start = buffer.indexOf('{');
            if (start === -1) { buffer = ''; return; }

            let depth = 0;
            let inString = false;
            let escaped = false;
            let end = -1;

            for (let i = start; i < buffer.length; i++) {
                const c = buffer[i];
                if (escaped) { escaped = false; continue; }
                if (c === '\\') { escaped = true; continue; }
                if (c === '"') { inString = !inString; continue; }
                if (inString) continue;
                if (c === '{') depth++;
                else if (c === '}') {
                    depth--;
                    if (depth === 0) { end = i; break; }
                }
            }

            if (end === -1) { buffer = buffer.slice(start); return; }

            const raw = buffer.slice(start, end + 1);
            buffer = buffer.slice(end + 1);
            try {
                onObject(JSON.parse(raw));
            } catch {
                // 半截 JSON，跳过
            }
        }
    };

    return {
        push(chunk) { buffer += chunk.toString('utf8'); drain(); },
        flush() { drain(); },
    };
}

/**
 * 把一个 batchGraphql 响应对象拆成增量事件。
 * 返回 null 表示这个对象里没有可用内容。
 */
export function extractChunk(obj) {
    if (!obj || typeof obj !== 'object') return null;

    if (obj.error) {
        const msg = obj.error?.message || JSON.stringify(obj.error).slice(0, 200);
        return { error: msg };
    }

    const results = obj.results || [];
    for (const result of results) {
        if (result.errors?.length) {
            const first = result.errors[0];
            return { error: first?.message || JSON.stringify(first).slice(0, 200) };
        }
    }

    let text = '';
    let reasoning = '';
    let finishReason = null;
    let blocked = null;
    let usage = null;
    let image = null;

    for (const result of results) {
        const data = result.data;
        if (!data) continue;

        const br = data.promptFeedback?.blockReason;
        if (br && !String(br).toUpperCase().endsWith('UNSPECIFIED')) {
            blocked = data.promptFeedback?.blockReasonMessage || br;
        }

        for (const candidate of (data.candidates || [])) {
            for (const part of (candidate.content?.parts || [])) {
                const isThought = part.thought === true
                    || String(part.thought || '').toLowerCase() === 'true';
                if (typeof part.text === 'string' && part.text) {
                    if (isThought) reasoning += part.text;
                    else text += part.text;
                }
                if (part.inlineData?.data) {
                    image = `![Generated Image](data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data})`;
                }
            }
            // UNSPECIFIED 是流式中间块的枚举默认值，不是真的结束
            const raw = candidate.finishReason;
            if (raw && String(raw).toUpperCase() !== 'FINISH_REASON_UNSPECIFIED') finishReason = raw;
        }

        if (data.usageMetadata) usage = data.usageMetadata;
    }

    if (blocked) return { blocked };
    if (!text && !reasoning && !image && !finishReason && !usage) return null;
    return { text, reasoning, finishReason, usage, image };
}

/** 判断错误是不是 Cookie 过期/失效（这类错误换下一个 Cookie 才有意义）。 */
export function isAuthError(message) {
    const m = String(message || '').toLowerCase();
    return m.includes('unauthorized')
        || m.includes('forbidden')
        || m.includes('permission denied')
        || m.includes('not authenticated')
        || m.includes('invalid credentials')
        || m.includes('signature not found');
}
