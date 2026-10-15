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

import { loadSettings, saveSettings, parseKeyList, DEFAULT_SETTINGS, settingsPath } from './lib/config.mjs';
import { buildGeminiPayload, geminiToOpenai, geminiChunkToDelta, openaiError } from './lib/convert.mjs';
import { request, createSseSplitter } from './lib/upstream.mjs';
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

/** 非流式调用，失败时依次换 Key 重试。 */
async function callOnce(body, settings) {
    const keys = parseKeyList(settings.expressKeys);
    if (keys.length === 0) {
        return { error: { status: 401, body: openaiError('未配置 Express API Key，请到插件设置页填写', 'authentication_error') } };
    }

    const { payload, modelName, prefillText } = buildGeminiPayload(body, settings);
    if (settings.debug) {
        log('出站请求模型=', modelName, '配置=', JSON.stringify(payload.generationConfig || {}));
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
                log(`调用 ${modelName} 返回 ${res.status}`);
                continue;
            }
            return { data: geminiToOpenai(JSON.parse(res.body), modelName, prefillText), modelName };
        } catch (err) {
            last = { status: 502, body: openaiError(`请求上游失败：${err.message}`, 'server_error') };
            log('请求异常：', err.message);
        }
    }
    return { error: last || { status: 502, body: openaiError('上游调用失败', 'server_error') } };
}

/** 流式调用：把上游 SSE 逐帧转成 OpenAI 的 data: 帧写给客户端。 */
async function callStream(body, settings, req, res) {
    const keys = parseKeyList(settings.expressKeys);
    if (keys.length === 0) {
        sendJson(res, 401, openaiError('未配置 Express API Key，请到插件设置页填写', 'authentication_error'));
        return;
    }

    const { payload, modelName, prefillText } = buildGeminiPayload(body, settings);
    const key = keys[0];
    const streamState = { prefillText, prefillSent: false };
    const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    let sentAny = false;
    const write = (obj) => {
        sentAny = true;
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
        const splitter = createSseSplitter((chunk) => {
            const { delta, finishReason, usage } = geminiChunkToDelta(chunk, streamState);
            if (usage) {
                write({
                    id, object: 'chat.completion.chunk', created, model: modelName,
                    choices: [{ index: 0, delta: {}, finish_reason: null }],
                    usage: {
                        prompt_tokens: Number(usage.promptTokenCount || 0),
                        completion_tokens: Number(usage.candidatesTokenCount || 0),
                        total_tokens: Number(usage.totalTokenCount || 0),
                    },
                });
            }
            if (Object.keys(delta).length === 0 && !finishReason) return;
            write({
                id, object: 'chat.completion.chunk', created, model: modelName,
                choices: [{ index: 0, delta, finish_reason: finishReason }],
            });
        });

        await request({
            url: upstreamUrl(modelName, true),
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify(payload),
            proxyUrl: settings.proxyUrl || '',
            timeoutMs: 300000,
            onData: (chunk) => splitter.push(chunk),
            signal: controller.signal,
        });
        splitter.flush();

        write({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (err) {
        if (!controller.signal.aborted) {
            log('流式调用异常：', err.message);
        }
        if (!sentAny) {
            // 还没写出任何内容，可以正常返回错误 JSON
            sendJson(res, 502, openaiError(`流式请求失败：${err.message}`, 'server_error'));
            return;
        }
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\n`);
        res.end();
    }
}

async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (route === '/health') {
        const keys = parseKeyList(state.settings.expressKeys);
        sendJson(res, 200, {
            ok: true,
            keys: keys.length,
            projectId: state.settings.projectId || null,
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
            if (typeof merged.expressKeys === 'string') {
                merged.expressKeys = parseKeyList(merged.expressKeys);
            }
            if (typeof merged.models === 'string') {
                merged.models = parseKeyList(merged.models);
            }
            state.settings = merged;
            saveSettings(PLUGIN_DIR, merged);
            log('设置已保存到', settingsPath(PLUGIN_DIR));
            res.json({ ok: true, port: merged.port });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
    router.get('/selftest', async (req, res) => {
        const model = String(req.query?.model || '').trim()
            || parseKeyList(state.settings.models)[0]
            || DEFAULT_SETTINGS.models[0];
        try {
            const result = await callOnce(
                { model, messages: [{ role: 'user', content: '只回复两个字：收到' }], stream: false },
                state.settings,
            );
            if (result.error) {
                res.json({ ok: false, error: result.error.body?.error?.message || '调用失败', model });
                return;
            }
            const content = result.data?.choices?.[0]?.message?.content || '';
            res.json({ ok: true, model, reply: content.trim().slice(0, 120) });
        } catch (err) {
            res.json({ ok: false, error: err.message, model });
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
