/**
 * vertex2openai for SillyTavern —— 服务端插件版
 *
 * 为什么自带独立 HTTP 服务，而不是注册到 SillyTavern 的 Express app：
 * 1. 酒馆默认开启 CSRF 保护，且只跳过 /proxy/ 开头的路径，插件路由下的 POST 会被 403 拦掉，
 *    酒馆自己的 Chat Completion 客户端不会带 CSRF token，走不通。
 * 2. 独立端口让手机端可以填 http://127.0.0.1:8050 —— 服务就跑在酒馆进程内，
 *    不存在安卓跨 App 回环隔离的问题（SillyDroid 容器里访问不到另一个 App 的 127.0.0.1）。
 *
 * 零第三方依赖，只用 Node 内置模块，所以从 GitHub 装完即用，不需要 npm install。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSettings, saveSettings, parseKeyList, parseCookies, DEFAULT_SETTINGS, settingsPath } from './lib/config.mjs';
import { buildGeminiPayload, geminiToOpenai, geminiChunkToDelta, openaiError } from './lib/convert.mjs';
import { request, createSseSplitter } from './lib/upstream.mjs';
import {
    BATCH_GRAPHQL_URL, buildHeaders, buildBody, createJsonObjectSplitter,
    extractChunk, isAuthError, validateCookie,
} from './lib/cookie.mjs';
import { renderSettingsPage } from './lib/page.mjs';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const state = {
    settings: loadSettings(PLUGIN_DIR),
    server: null,
    keyIndex: 0,
};

const UPSTREAM_BASE = 'https://aiplatform.googleapis.com/v1';

function log(...args) {
    console.log('[vertex2openai]', ...args);
}

function nextKey() {
    const keys = parseKeyList(state.settings.expressKeys);
    if (keys.length === 0) return null;
    const key = keys[state.keyIndex % keys.length];
    state.keyIndex = (state.keyIndex + 1) % keys.length;
    return key;
}

function upstreamUrl(modelName, stream) {
    const { projectId, location } = state.settings;
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    if (projectId && location) {
        return `${UPSTREAM_BASE}/projects/${projectId}/locations/${location}/publishers/google/models/${modelName}:${action}`;
    }
    return `${UPSTREAM_BASE}/publishers/google/models/${modelName}:${action}`;
}

/** 把上游的错误体翻译成 OpenAI 风格的错误。 */
function describeUpstreamError(status, text) {
    let msg = text;
    try {
        const parsed = JSON.parse(text);
        msg = parsed?.error?.message || text;
    } catch { /* 保持原样 */ }
    if (status === 401 || status === 403) {
        return { status: 401, body: openaiError(`上游拒绝：${msg}`, 'authentication_error') };
    }
    if (status === 429) {
        return { status: 429, body: openaiError(`配额不足或限流：${msg}`, 'rate_limit_error') };
    }
    if (status === 404) {
        return { status: 404, body: openaiError(
            `模型不可用或区域不对：${msg}（可尝试在设置里把区域改成 global，或确认项目 ID 与 Key 属于同一个项目）`,
            'invalid_request_error') };
    }
    return { status: status >= 500 ? 502 : status, body: openaiError(`上游返回 ${status}：${msg}`, 'server_error') };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 32 * 1024 * 1024) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, obj) {
    const payload = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

function authorized(req) {
    const expect = String(state.settings.accessKey || '');
    if (!expect) return true;
    const header = String(req.headers.authorization || '');
    return header.replace(/^Bearer\s+/i, '').trim() === expect;
}

/** 按设置决定本次要试哪些通道（auto = 先 Express，被限流/拒绝时转 Cookie）。 */
function resolveChannels(settings, preferred = null) {
    const keyCount = parseKeyList(settings.expressKeys).length;
    const cookieCount = parseCookies(settings.cookies).length;
    const mode = (preferred && preferred !== 'auto')
        ? String(preferred).toLowerCase()
        : String(settings.channel || 'auto').toLowerCase();

    if (mode === 'express') return keyCount ? ['express'] : [];
    if (mode === 'cookie') return cookieCount ? ['cookie'] : [];

    const order = [];
    if (keyCount) order.push('express');
    if (cookieCount) order.push('cookie');
    return order;
}

/** Express 通道（官方 API Key），多 Key 轮换。 */
async function callExpressOnce(body, settings) {
    const keys = parseKeyList(settings.expressKeys);
    if (keys.length === 0) {
        return { error: { status: 401, body: openaiError('未配置 Express API Key', 'authentication_error') } };
    }

    const { payload, modelName, prefillText } = buildGeminiPayload(body, settings);
    if (settings.debug) {
        log('[express] 出站模型=', modelName, '配置=', JSON.stringify(payload.generationConfig || {}));
    }

    let last = null;
    for (const key of keys) {
        try {
            const res = await request({
                url: upstreamUrl(modelName, false),
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                body: JSON.stringify(payload),
                proxyUrl: settings.proxyUrl || '',
                timeoutMs: 180000,
            });
            if (res.status !== 200) {
                last = describeUpstreamError(res.status, res.body);
                log(`[express] ${modelName} 返回 ${res.status}`);
                continue;
            }
            return { data: geminiToOpenai(JSON.parse(res.body), modelName, prefillText), modelName, channel: 'express' };
        } catch (err) {
            last = { status: 502, body: openaiError(`请求上游失败：${err.message}`, 'server_error') };
            log('[express] 请求异常：', err.message);
        }
    }
    return { error: last || { status: 502, body: openaiError('上游调用失败', 'server_error') } };
}

/** 把 Cookie 通道累积出来的内容拼成 OpenAI 响应（复用 Express 那套转换，避免两套逻辑）。 */
function composeFromCookie({ text, reasoning, image, finishReason, usage }, modelName, prefillText) {
    const parts = [];
    if (reasoning) parts.push({ text: reasoning, thought: true });
    if (image) parts.push({ text: image });
    if (text) parts.push({ text });

    const fake = {
        candidates: [{ content: { parts }, finishReason }],
        usageMetadata: usage || {},
    };
    return geminiToOpenai(fake, modelName, prefillText);
}

/**
 * Cookie 通道（batchGraphql），多 Cookie 轮换。
 * 该端点只回流式响应，所以这里把整段流累积起来再合成一次响应。
 */
async function callCookieOnce(body, settings) {
    const cookies = parseCookies(settings.cookies);
    if (cookies.length === 0) {
        return { error: { status: 401, body: openaiError('未配置 Cookie，请到插件设置页填写', 'authentication_error') } };
    }

    const projectId = String(settings.cookieProjectId || settings.projectId || '').trim();
    if (!projectId) {
        return { error: { status: 400, body: openaiError('Cookie 通道必须填 GCP 项目 ID', 'invalid_request_error') } };
    }

    const { payload, modelName, prefillText, grounded } = buildGeminiPayload(body, settings);
    const graphBody = buildBody({
        projectId,
        modelName,
        contents: payload.contents,
        systemInstruction: payload.systemInstruction,
        generationConfig: payload.generationConfig || {},
        grounded,
        safetyThreshold: settings.cookieSafety || 'OFF',
    });
    if (settings.debug) {
        log('[cookie] 出站模型=', modelName, '配置=', JSON.stringify(payload.generationConfig || {}));
    }

    let last = null;
    for (const cookieStr of cookies) {
        const headers = buildHeaders(cookieStr);
        if (!headers) {
            last = { status: 401, body: openaiError('这条 Cookie 里没有 SAPISID，算不出认证头', 'authentication_error') };
            continue;
        }

        let text = '';
        let reasoning = '';
        let image = null;
        let finishReason = null;
        let usage = null;
        let err = null;

        try {
            const splitter = createJsonObjectSplitter((obj) => {
                const c = extractChunk(obj);
                if (!c) return;
                if (c.error) { err = c.error; return; }
                if (c.blocked) { err = `被上游安全策略拦截：${c.blocked}`; return; }
                text += c.text || '';
                reasoning += c.reasoning || '';
                if (c.finishReason) finishReason = c.finishReason;
                if (c.usage) usage = c.usage;
                if (c.image) image = c.image;
            });

            await request({
                url: BATCH_GRAPHQL_URL,
                method: 'POST',
                headers,
                body: JSON.stringify(graphBody),
                proxyUrl: settings.proxyUrl || '',
                timeoutMs: 180000,
                onData: (chunk) => splitter.push(chunk),
            });
            splitter.flush();

            if (err) {
                last = {
                    status: isAuthError(err) ? 401 : 502,
                    body: openaiError(`[cookie] ${err}`, isAuthError(err) ? 'authentication_error' : 'server_error'),
                };
                log('[cookie] 上游报错：', String(err).slice(0, 160));
                continue;
            }
            if (!text && !image) {
                last = { status: 502, body: openaiError('[cookie] 上游没返回任何内容（Cookie 可能已失效）', 'server_error') };
                continue;
            }
            return {
                data: composeFromCookie({ text, reasoning, image, finishReason, usage }, modelName, prefillText),
                modelName,
                channel: 'cookie',
            };
        } catch (e) {
            last = { status: 502, body: openaiError(`[cookie] 请求失败：${e.message}`, 'server_error') };
            log('[cookie] 请求异常：', e.message);
        }
    }
    return { error: last || { status: 502, body: openaiError('Cookie 通道调用失败', 'server_error') } };
}

/**
 * 极轻量探测某个模型在指定通道是否可用。
 * 只取第一个凭证、限制输出长度，把配额消耗压到最低。
 */
async function probeModel(model, channel) {
    const s = state.settings;
    const ch = String(channel || s.channel || 'auto').toLowerCase();
    const body = { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: false };

    const single = ch === 'cookie'
        ? { ...s, cookies: parseCookies(s.cookies).slice(0, 1), expressKeys: [] }
        : { ...s, expressKeys: parseKeyList(s.expressKeys).slice(0, 1) };

    try {
        const r = await callOnce(body, single, ch);
        if (r.data) return { model, ok: true, channel: r.channel };
        const msg = String(r.error?.body?.error?.message || '未知错误');
        // 判定顺序很关键：Vertex 对「模型在该区域不存在」也返回
        // "Permission 'aiplatform.endpoints.predict' denied ... (or it may not exist)"，
        // 句尾那句只是 Google 的固定后缀，不是判定依据。真正能区分的是
        // 'aiplatform.endpoints.predict' 这个权限名 —— 出现它就是 IAM 授权问题。
        const kind = /aiplatform\.[\w.]+'?\s*(denied|permission)|IAM_PERMISSION_DENIED/i.test(msg) ? '权限不足'
            : /exhausted|quota/i.test(msg) ? '配额耗尽'
                : /not found|not exist|may not exist/i.test(msg) ? '模型不存在'
                    : /permission denied|forbidden/i.test(msg) ? '权限不足'
                        : /unauthorized|401|invalid credential/i.test(msg) ? '凭证失效'
                            : '其他';
        const hint = {
            '模型不存在': '换个模型名，或确认该模型在你选的区域可用',
            '配额耗尽': '账号本次配额用完了，等一段时间再试；也可以在 GCP 控制台「配额」页确认剩余额度',
            '权限不足': '这个身份在目标项目上没有被授予 aiplatform.endpoints.predict。'
                + '常见两种情况：① Cookie 抓自另一个 Google 账号（浏览器多账号登录时很容易抓错）；'
                + '② Vertex Express 快速模式的项目只给 express-mode 服务账号授权，人类账号没有该权限。'
                + '去 GCP 控制台「IAM 与管理 → IAM」看你的邮箱是否带 Vertex AI User 角色；'
                + '快速模式项目若不给改 IAM，就只能用 Express 通道。',
            '凭证失效': 'Cookie 已过期，重新抓一次粘进来',
            '其他': '看上游原始报错',
        }[kind] || '';
        return { model, ok: false, kind, hint, error: msg.slice(0, 200) };
    } catch (err) {
        return { model, ok: false, kind: '异常', hint: '请求没发出去，检查代理设置', error: err.message };
    }
}

/** 非流式调用：按通道顺序尝试，前一个通道被限流/拒绝就换下一个。 */
async function callOnce(body, settings, preferred = null) {
    const channels = resolveChannels(settings, preferred);
    if (channels.length === 0) {
        return { error: { status: 401, body: openaiError('既没配 Express API Key 也没配 Cookie，请到插件设置页填写', 'authentication_error') } };
    }

    let last = null;
    for (const ch of channels) {
        const r = ch === 'express'
            ? await callExpressOnce(body, settings)
            : await callCookieOnce(body, settings);
        if (r.data) return r;
        last = r.error;
    }
    return { error: last || { status: 502, body: openaiError('上游调用失败', 'server_error') } };
}

/** 把一个 Gemini 格式的增量块转成 OpenAI delta 并写出去。 */
function emitGeminiChunk(chunk, ctx) {
    const { delta, finishReason, usage } = geminiChunkToDelta(chunk, ctx.streamState);

    if (usage) {
        ctx.write({
            id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.modelName,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            usage: {
                prompt_tokens: Number(usage.promptTokenCount || 0),
                completion_tokens: Number(usage.candidatesTokenCount || 0),
                total_tokens: Number(usage.totalTokenCount || 0),
            },
        });
    }
    if (Object.keys(delta).length === 0 && !finishReason) return;
    ctx.write({
        id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.modelName,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
}

function finishStream(ctx) {
    ctx.write({
        id: ctx.id, object: 'chat.completion.chunk', created: ctx.created, model: ctx.modelName,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    ctx.writeRaw('data: [DONE]\n\n');
    ctx.end();
}

/** Express 通道的流式实现。 */
async function streamViaExpress(built, settings, ctx) {
    const keys = parseKeyList(settings.expressKeys);
    if (keys.length === 0) {
        return { status: 'fallback', error: { status: 401, body: openaiError('[express] 未配置 API Key', 'authentication_error') } };
    }

    let got = false;
    try {
        const splitter = createSseSplitter((chunk) => { got = true; emitGeminiChunk(chunk, ctx); });
        await request({
            url: upstreamUrl(built.modelName, true),
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[0] },
            body: JSON.stringify(built.payload),
            proxyUrl: settings.proxyUrl || '',
            timeoutMs: 300000,
            onData: (chunk) => splitter.push(chunk),
            signal: ctx.controller.signal,
        });
        splitter.flush();
    } catch (err) {
        if (got) {
            ctx.writeErr(err.message);
            ctx.end();
            return { status: 'done' };
        }
        return { status: 'fallback', error: { status: 502, body: openaiError(`[express] ${err.message}`, 'server_error') } };
    }

    if (!got) {
        return { status: 'fallback', error: { status: 502, body: openaiError('[express] 上游没有返回任何内容', 'server_error') } };
    }
    finishStream(ctx);
    return { status: 'done' };
}

/** Cookie 通道的流式实现（多 Cookie 轮换）。 */
async function streamViaCookie(built, settings, ctx) {
    const cookies = parseCookies(settings.cookies);
    if (cookies.length === 0) {
        return { status: 'fallback', error: { status: 401, body: openaiError('[cookie] 未配置 Cookie', 'authentication_error') } };
    }

    const projectId = String(settings.cookieProjectId || settings.projectId || '').trim();
    if (!projectId) {
        return { status: 'fallback', error: { status: 400, body: openaiError('Cookie 通道必须填 GCP 项目 ID', 'invalid_request_error') } };
    }

    const graphBody = buildBody({
        projectId,
        modelName: built.modelName,
        contents: built.payload.contents,
        systemInstruction: built.payload.systemInstruction,
        generationConfig: built.payload.generationConfig || {},
        grounded: built.grounded,
        safetyThreshold: settings.cookieSafety || 'OFF',
    });

    let last = null;
    for (const cookieStr of cookies) {
        const headers = buildHeaders(cookieStr);
        if (!headers) {
            last = { status: 401, body: openaiError('这条 Cookie 里没有 SAPISID，算不出认证头', 'authentication_error') };
            continue;
        }

        let got = false;
        let err = null;

        try {
            const splitter = createJsonObjectSplitter((obj) => {
                const c = extractChunk(obj);
                if (!c) return;
                if (c.error) { err = c.error; return; }
                if (c.blocked) { err = `被上游安全策略拦截：${c.blocked}`; return; }

                const parts = [];
                if (c.reasoning) parts.push({ text: c.reasoning, thought: true });
                if (c.image) parts.push({ text: c.image });
                if (c.text) parts.push({ text: c.text });
                if (parts.length === 0 && !c.finishReason && !c.usage) return;

                got = true;
                emitGeminiChunk({
                    candidates: [{ content: { parts }, finishReason: c.finishReason }],
                    usageMetadata: c.usage || undefined,
                }, ctx);
            });

            await request({
                url: BATCH_GRAPHQL_URL,
                method: 'POST',
                headers,
                body: JSON.stringify(graphBody),
                proxyUrl: settings.proxyUrl || '',
                timeoutMs: 300000,
                onData: (chunk) => splitter.push(chunk),
                signal: ctx.controller.signal,
            });
            splitter.flush();

            if (err) {
                if (got) { ctx.writeErr(err); ctx.end(); return { status: 'done' }; }
                last = {
                    status: isAuthError(err) ? 401 : 502,
                    body: openaiError(`[cookie] ${err}`, isAuthError(err) ? 'authentication_error' : 'server_error'),
                };
                log('[cookie] 上游报错：', String(err).slice(0, 160));
                continue;
            }
            if (!got) {
                last = { status: 502, body: openaiError('[cookie] 上游没返回任何内容（Cookie 可能已失效）', 'server_error') };
                continue;
            }
            finishStream(ctx);
            return { status: 'done' };
        } catch (e) {
            if (got) { ctx.writeErr(e.message); ctx.end(); return { status: 'done' }; }
            last = { status: 502, body: openaiError(`[cookie] 请求失败：${e.message}`, 'server_error') };
        }
    }
    return { status: 'fallback', error: last };
}

/**
 * 流式调用。
 *
 * 响应头延迟到真的有内容时才发：这样第一个通道被限流/拒绝、但还没吐出一个字时，
 * 可以静默切到下一个通道，客户端（酒馆）完全感知不到换过通道。
 */
async function callStream(body, settings, req, res) {
    const channels = resolveChannels(settings);
    if (channels.length === 0) {
        sendJson(res, 401, openaiError('既没配 Express API Key 也没配 Cookie，请到插件设置页填写', 'authentication_error'));
        return;
    }

    const built = buildGeminiPayload(body, settings);
    const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const created = Math.floor(Date.now() / 1000);

    let headSent = false;
    const ensureHead = () => {
        if (headSent) return;
        headSent = true;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
    };

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const ctx = {
        id,
        created,
        modelName: built.modelName,
        streamState: { prefillText: built.prefillText, prefillSent: false },
        controller,
        write: (obj) => { ensureHead(); res.write(`data: ${JSON.stringify(obj)}\n\n`); },
        writeRaw: (s) => { ensureHead(); res.write(s); },
        writeErr: (m) => ctx.write({ error: { message: m, type: 'server_error' } }),
        end: () => res.end(),
    };

    let last = null;
    for (const ch of channels) {
        if (controller.signal.aborted) return;

        const r = ch === 'express'
            ? await streamViaExpress(built, settings, ctx)
            : await streamViaCookie(built, settings, ctx);

        if (r.status === 'done') return;
        last = r.error;
        if (headSent) {
            // 已经写过内容，没法再换通道了
            ctx.writeErr(last.body?.error?.message || '上游调用失败');
            ctx.end();
            return;
        }
    }

    // 所有通道都失败，而且一个字节都没写出去 —— 可以正常返回错误码
    sendJson(res, last?.status || 502, last?.body || openaiError('上游调用失败', 'server_error'));
}

async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (route === '/health') {
        sendJson(res, 200, {
            ok: true,
            channel: resolveChannels(state.settings),
            configured: String(state.settings.channel || 'auto'),
            keys: parseKeyList(state.settings.expressKeys).length,
            cookies: parseCookies(state.settings.cookies).length,
            projectId: state.settings.projectId || null,
            cookieProjectId: state.settings.cookieProjectId || null,
            location: state.settings.location || null,
            proxy: state.settings.proxyUrl || null,
        });
        return;
    }

    if (!authorized(req)) {
        sendJson(res, 401, openaiError('无效的 API Key', 'authentication_error'));
        return;
    }

    if (route === '/v1/models' || route === '/models') {
        const models = parseKeyList(state.settings.models.length ? state.settings.models : DEFAULT_SETTINGS.models);
        sendJson(res, 200, {
            object: 'list',
            data: models.map(id => ({ id, object: 'model', created: 0, owned_by: 'google' })),
        });
        return;
    }

    if (route === '/v1/chat/completions' || route === '/chat/completions') {
        let body;
        try {
            body = JSON.parse(await readBody(req));
        } catch {
            sendJson(res, 400, openaiError('请求体不是合法 JSON', 'invalid_request_error'));
            return;
        }

        if (!body.model) {
            sendJson(res, 400, openaiError('缺少 model 字段', 'invalid_request_error'));
            return;
        }

        if (body.stream) {
            await callStream(body, state.settings, req, res);
            return;
        }

        const result = await callOnce(body, state.settings);
        if (result.error) {
            sendJson(res, result.error.status, result.error.body);
            return;
        }
        sendJson(res, 200, result.data);
        return;
    }

    sendJson(res, 404, openaiError(`未知路径 ${route}`, 'invalid_request_error'));
}

async function init(router) {
    const settings = state.settings;

    // 1) 独立 HTTP 服务：真正的 OpenAI 兼容端点
    const port = Number(settings.port) || 8050;
    const host = settings.host || '0.0.0.0';

    // 端口冲突时不让整个插件加载失败：服务没起来也要保留设置页，方便改端口后重启。
    try {
        await startServer();
        log(`OpenAI 兼容端点已启动：http://127.0.0.1:${port}/v1`);
        log(`已加载 ${parseKeyList(settings.expressKeys).length} 个 Express API Key，区域=${settings.location || '未指定'}，代理=${settings.proxyUrl || '直连'}`);
    } catch (err) {
        console.error(`[vertex2openai] 端口 ${host}:${port} 启动失败：${err.message}。`
            + '多半是被别的程序占了，到设置页换个端口再点「保存并重启服务」。');
    }

    // 2) 借酒馆的路由提供设置页（GET 不受 CSRF 影响）
    router.get('/settings', (_req, res) => {
        res.type('html').send(renderSettingsPage(state.settings));
    });
    router.get('/config', (_req, res) => {
        res.json(state.settings);
    });
    router.post('/config', (req, res) => {
        try {
            const incoming = req.body || {};
            const merged = { ...state.settings };
            for (const key of Object.keys(DEFAULT_SETTINGS)) {
                if (key in incoming) merged[key] = incoming[key];
            }
            // 两个列表统一清洗：设置页是每行一个，粘贴进来的也可能带逗号或分号。
            // 不清洗的话整块文本会被当成一个元素，酒馆拉到的模型 id 就是一坨。
            merged.expressKeys = parseKeyList(merged.expressKeys);
            merged.models = parseKeyList(merged.models);
            // Cookie 只按行拆：它内部可能含逗号，按逗号切会把一条 Cookie 切成好几段
            merged.cookies = parseCookies(merged.cookies);
            state.settings = merged;
            saveSettings(PLUGIN_DIR, merged);
            log('设置已保存到', settingsPath(PLUGIN_DIR));
            res.json({ ok: true, port: merged.port });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    /**
     * 运行状态。前端扩展用它做状态展示 —— 不能让浏览器直接去问 127.0.0.1:8050，
     * 因为从别的设备打开酒馆时，页面里的 127.0.0.1 指的是浏览器所在机器，不是服务端。
     */
    router.get('/status', (_req, res) => {
        const s = state.settings;
        const port = Number(s.port) || 8050;
        res.json({
            ok: true,
            listening: Boolean(state.server?.listening),
            port,
            host: s.host,
            endpoint: `http://127.0.0.1:${port}/v1`,
            channel: s.channel,
            keys: parseKeyList(s.expressKeys).length,
            cookies: parseCookies(s.cookies).length,
            projectId: s.projectId,
            cookieProjectId: s.cookieProjectId,
            location: s.location,
            proxy: s.proxyUrl,
            models: parseKeyList(s.models),
        });
    });

    router.get('/selftest', async (req, res) => {
        const list = parseKeyList(state.settings.models);
        // 没指定模型时别默认挑列表第一个（gemini-4-argon 常常没额度，会让人误判成配置错了）
        const model = String(req.query?.model || '').trim()
            || list.find(m => m === 'gemini-3.6-flash')
            || list[0]
            || DEFAULT_SETTINGS.models[0];
        const channel = String(req.query?.channel || '').trim() || null;
        try {
            const probe = await probeModel(model, channel);
            if (!probe.ok) {
                res.json({
                    ok: false, model, channel, kind: probe.kind,
                    hint: probe.hint, error: probe.error,
                });
                return;
            }
            const result = await callOnce(
                { model, messages: [{ role: 'user', content: '只回复两个字：收到' }], stream: false },
                state.settings,
                channel,
            );
            const content = result.data?.choices?.[0]?.message?.content || '';
            res.json({
                ok: true, model, channel: probe.channel || result.channel,
                reply: content.trim().slice(0, 120),
            });
        } catch (err) {
            res.json({ ok: false, error: err.message, model, channel });
        }
    });
    /**
     * 批量探测：逐个试模型列表，返回每个模型在当前通道下是否可用。
     * 只取第一个凭证、限制 16 token，尽量少烧配额 —— 但仍然是「发真请求」，
     * 配额紧张时慎用。
     */
    router.post('/scan', async (req, res) => {
        try {
            const channel = String(req.body?.channel || '').trim() || null;
            const models = parseKeyList(state.settings.models);
            const results = [];
            for (const model of models) {
                const r = await probeModel(model, channel);
                results.push(r);
            }
            res.json({ ok: true, channel: channel || state.settings.channel, results });
        } catch (err) {
            res.json({ ok: false, error: err.message });
        }
    });

    router.post('/restart', async (_req, res) => {
        try {
            await startServer();
            res.json({ ok: true, port: state.settings.port });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    log('设置页：扩展面板里没有入口时，直接访问 /api/plugins/vertex2openai/settings');
}

async function startServer() {
    const port = Number(state.settings.port) || 8050;
    const host = state.settings.host || '0.0.0.0';
    if (state.server) {
        await new Promise((resolve) => state.server.close(resolve));
        state.server = null;
    }
    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
            log('处理请求时出错：', err);
            if (!res.headersSent) sendJson(res, 500, openaiError(err.message, 'server_error'));
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
    state.server = server;
    log(`服务已重启，监听 ${host}:${port}`);
}

async function exit() {
    if (state.server) {
        await new Promise((resolve) => state.server.close(resolve));
        state.server = null;
        log('服务已停止');
    }
}

export {
    init,
    exit,
};

export const info = {
    id: 'vertex2openai',
    name: 'Vertex2OpenAI (Gemini Express)',
    description: '在酒馆进程内跑一个 OpenAI 兼容端点，把请求转发到 Gemini Express Mode，无需额外部署 Python 服务。',
};
