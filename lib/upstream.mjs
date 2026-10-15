/**
 * 出网层：零第三方依赖，只用 Node 内置 http/https/tls。
 * 代理支持 HTTP CONNECT 隧道（Clash / v2ray 的混合端口就是这种），SOCKS 不支持。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/** 通过 HTTP 代理建立到目标主机的 TCP 隧道。 */
function connectTunnel(proxyUrl, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        let proxy;
        try {
            proxy = new URL(proxyUrl);
        } catch {
            reject(new Error(`代理地址格式不正确：${proxyUrl}`));
            return;
        }

        const req = http.request({
            host: proxy.hostname,
            port: Number(proxy.port) || 80,
            method: 'CONNECT',
            path: `${targetHost}:${targetPort}`,
            headers: { Host: `${targetHost}:${targetPort}` },
        });

        req.setTimeout(15000, () => {
            req.destroy(new Error('连接代理超时'));
        });

        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                reject(new Error(`代理隧道建立失败，HTTP ${res.statusCode}`));
                return;
            }
            resolve(socket);
        });
        req.on('error', reject);
        req.end();
    });
}

async function createConnector(targetUrl, proxyUrl) {
    const u = new URL(targetUrl);
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port) || (isHttps ? 443 : 80);

    if (!proxyUrl) return undefined;

    const socket = await connectTunnel(proxyUrl, u.hostname, port);
    return () => (isHttps
        ? tls.connect({ socket, servername: u.hostname })
        : socket);
}

/**
 * 发起一次请求。
 * @param {object} options
 * @param {string} options.url 完整 URL
 * @param {string} options.method
 * @param {object} options.headers
 * @param {string|null} options.body
 * @param {string} options.proxyUrl
 * @param {number} options.timeoutMs
 * @param {(chunk: Buffer) => void} [options.onData] 传了就走流式，边收边回调
 * @param {AbortSignal} [options.signal] 客户端断开时中止上游
 */
export async function request({
    url, method = 'POST', headers = {}, body = null, proxyUrl = '',
    timeoutMs = 120000, onData = null, signal = null,
}) {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;

    const createConnection = await createConnector(url, proxyUrl);

    const req = mod.request({
        host: u.hostname,
        port: Number(u.port) || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        agent: false,
        ...(createConnection ? { createConnection } : {}),
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => {
            if (settled) return;
            settled = true;
            fn(arg);
        };

        const timer = setTimeout(() => {
            req.destroy(new Error('请求上游超时'));
        }, timeoutMs);

        if (signal) {
            const onAbort = () => req.destroy(new Error('客户端已断开'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        req.on('response', (res) => {
            if (onData) {
                res.on('data', c => onData(c));
                res.on('end', () => done(resolve));
                res.on('error', err => done(reject, err));
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                done(resolve, { status: res.statusCode, headers: res.headers, body: buf.toString('utf8') });
            });
            res.on('error', err => done(reject, err));
        });

        req.on('error', err => done(reject, err));
        req.on('close', () => clearTimeout(timer));

        if (body) req.write(body);
        req.end();
    });
}

/**
 * 按 SSE 帧切分流式响应。Gemini 的流式帧形如 `data: {...}` 后跟空行。
 *
 * 分隔符必须用正则兼容 \r\n\r\n —— 实测上游发的是 CRLF，早先按 "\n\n" 硬找时
 * 一个帧都切不出来，客户端只收到末尾的 [DONE]，表现为"流式永远返回空"。
 */
export function createSseSplitter(onFrame) {
    let buffer = '';
    const separator = /\r?\n\r?\n/;

    const handle = (frame) => {
        const line = frame.split(/\r?\n/).find(l => l.trim().startsWith('data:'));
        if (!line) return;
        const payload = line.slice(line.indexOf(':') + 1).trim();
        if (!payload || payload === '[DONE]') return;
        try {
            onFrame(JSON.parse(payload));
        } catch {
            // 非 JSON 帧（心跳等）忽略
        }
    };

    return {
        push(chunk) {
            buffer += chunk.toString('utf8');
            let m;
            while ((m = separator.exec(buffer)) !== null) {
                const frame = buffer.slice(0, m.index);
                buffer = buffer.slice(m.index + m[0].length);
                handle(frame);
            }
        },
        /** 流结束时把缓冲区里不完整的最后一个帧冲出来。 */
        flush() {
            if (buffer.trim()) handle(buffer);
            buffer = '';
        },
    };
}
