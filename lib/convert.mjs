/**
 * OpenAI 协议 <-> Gemini 原生协议的双向转换。
 * 只做角色扮演真正需要的部分：文本消息、采样参数、思考配置、预填充兼容。
 */

import { getProfile, applySamplingPolicy, resolveThinking } from './models.mjs';

const DEFAULT_PREFILL_INSTRUCTION =
    '（上面这段是你要接着写下去的开头，请从它的末尾无缝继续，不要重复、不要另起话题）\n\n';

/** 取出一条消息的纯文本（content 可能是字符串，也可能是 [{type:'text',text}] 数组）。 */
function messageText(message) {
    const c = message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        return c
            .filter(p => p && (p.type === 'text' || typeof p.text === 'string'))
            .map(p => (typeof p.text === 'string' ? p.text : ''))
            .join('');
    }
    return '';
}

function toGeminiRole(role) {
    if (role === 'assistant' || role === 'model') return 'model';
    return 'user';
}

/**
 * 处理末尾 assistant 预填充。
 *
 * 酒馆预设普遍用一条 assistant 消息作为思维链的开标签（预填充），让模型接着写。
 * Gemini 3.x 拒绝以 model 轮次结尾，必须转成续写指令塞进 user 轮次，
 * 否则请求直接被拒；转换后还要把预填充文本拼回输出开头，预设的正则才抓得到。
 */
function applyPrefill(messages, allowModelLast, instruction) {
    const list = messages.slice();
    let prefillText = '';

    if (list.length && (list[list.length - 1].role === 'assistant' || list[list.length - 1].role === 'model')) {
        const last = list[list.length - 1];
        prefillText = messageText(last);

        if (allowModelLast && prefillText.trim()) {
            // 老模型允许 model 结尾，原生透传让它直接续写
            return { messages: list, prefillText };
        }

        list.pop();
        const tpl = (instruction || '').trim() || DEFAULT_PREFILL_INSTRUCTION;
        const nudge = `${tpl}${prefillText}`;

        // 并进最后一条 user；没有 user 就新建一条
        let idx = -1;
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].role === 'user') { idx = i; break; }
        }
        if (idx >= 0) {
            list[idx] = { ...list[idx], content: `${messageText(list[idx])}\n\n${nudge}` };
        } else {
            list.push({ role: 'user', content: nudge });
        }
    }

    return { messages: list, prefillText };
}

/** OpenAI messages -> Gemini contents + systemInstruction。 */
function buildContents(messages) {
    const systemParts = [];
    const contents = [];

    for (const msg of messages) {
        const text = messageText(msg);
        if (!text.trim()) continue;

        if (msg.role === 'system' || msg.role === 'developer') {
            systemParts.push(text);
            continue;
        }

        const role = toGeminiRole(msg.role);
        const last = contents[contents.length - 1];
        // 合并连续同角色轮次：Gemini 不接受相邻的同 role 轮次
        if (last && last.role === role) {
            last.parts.push({ text });
        } else {
            contents.push({ role, parts: [{ text }] });
        }
    }

    return { contents, systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined };
}

function buildGenerationConfig(body, modelName, settings, prefillActive) {
    const profile = applySamplingPolicy(getProfile(modelName), settings);
    const cfg = {};

    const put = (key, value, allowed) => {
        if (value === undefined || value === null) return;
        if (!allowed.has(key)) return;
        cfg[key] = value;
    };

    put('temperature', body.temperature, profile.allowedSampling);
    put('topP', body.top_p ?? body.topP, profile.allowedSampling);
    put('topK', body.top_k ?? body.topK, profile.allowedSampling);
    put('candidateCount', body.n > 1 ? body.n : undefined, profile.allowedSampling);

    const maxTokens = body.max_tokens ?? body.maxTokens ?? body.max_completion_tokens;
    if (maxTokens !== undefined && maxTokens !== null) cfg.maxOutputTokens = Number(maxTokens);

    const stop = body.stop;
    if (typeof stop === 'string' && stop) cfg.stopSequences = [stop];
    else if (Array.isArray(stop) && stop.length) cfg.stopSequences = stop.filter(Boolean).slice(0, 5);

    const thinking = resolveThinking(modelName, body, settings, prefillActive);
    if (thinking.mode === 'level') {
        cfg.thinkingConfig = {
            thinkingLevel: thinking.level.toUpperCase(),
            includeThoughts: thinking.includeThoughts,
        };
    } else if (body.reasoning_effort && getProfile(modelName).family === 'legacy') {
        cfg.thinkingConfig = undefined;
    }

    return { cfg, profile };
}

/** OpenAI 请求体 -> Gemini generateContent 请求体。 */
export function buildGeminiPayload(body, settings) {
    const rawName = String(body.model || '').trim();
    const grounded = rawName.endsWith('-search');
    const modelName = grounded ? rawName.slice(0, -'-search'.length) : rawName;

    const profile = getProfile(modelName);
    const { messages, prefillText } = applyPrefill(
        Array.isArray(body.messages) ? body.messages : [],
        !profile.requiresUserLastTurn,
        settings.prefillInstruction,
    );

    const { contents, systemInstruction } = buildContents(messages);
    const { cfg } = buildGenerationConfig(body, modelName, settings, Boolean(prefillText.trim()));

    const payload = { contents, generationConfig: cfg };
    if (systemInstruction) payload.systemInstruction = systemInstruction;

    if (grounded) payload.tools = [{ googleSearch: {} }];

    return { payload, modelName, prefillText, profile, grounded };
}

function mapFinishReason(reason) {
    switch (String(reason || '').toUpperCase()) {
        case 'STOP': return 'stop';
        case 'MAX_TOKENS': return 'length';
        case 'SAFETY':
        case 'PROHIBITED_CONTENT':
        case 'BLOCKLIST':
        case 'SPII': return 'content_filter';
        case 'RECITATION': return 'content_filter';
        default: return 'stop';
    }
}

/** 从一条候选里拆出正文与思考文本。 */
function splitParts(candidate) {
    let text = '';
    let reasoning = '';
    const parts = candidate?.content?.parts || [];
    for (const p of parts) {
        if (typeof p?.text !== 'string') continue;
        if (p.thought) reasoning += p.text;
        else text += p.text;
    }
    return { text, reasoning };
}

/** Gemini 非流式响应 -> OpenAI chat.completion 对象。 */
export function geminiToOpenai(response, modelName, prefillText = '') {
    const candidate = response?.candidates?.[0] || {};
    const { text, reasoning } = splitParts(candidate);

    let content = text;
    if (prefillText && content) {
        // 续写模式下模型不会重复开头，这里把预填充拼回去
        content = content.startsWith(prefillText) ? content : prefillText + content;
    }

    const message = { role: 'assistant', content };
    if (reasoning) message.reasoning_content = reasoning;

    const usage = response?.usageMetadata || {};
    return {
        id: `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{
            index: 0,
            message,
            finish_reason: mapFinishReason(candidate.finishReason),
        }],
        usage: {
            prompt_tokens: Number(usage.promptTokenCount || 0),
            completion_tokens: Number(usage.candidatesTokenCount || 0),
            total_tokens: Number(usage.totalTokenCount || (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0)),
        },
    };
}

/** Gemini 流式增量 -> OpenAI delta。 */
export function geminiChunkToDelta(chunk, state) {
    const candidate = chunk?.candidates?.[0] || {};
    const { text, reasoning } = splitParts(candidate);

    const delta = {};
    if (reasoning) {
        delta.reasoning_content = reasoning;
    }
    if (text) {
        // 首个正文块前补回预填充，保证酒馆正则能匹配到思考开标签
        if (!state.prefillSent && state.prefillText && !text.startsWith(state.prefillText)) {
            delta.content = state.prefillText + text;
            state.prefillSent = true;
        } else {
            delta.content = text;
            if (state.prefillText) state.prefillSent = true;
        }
    } else if (state.prefillText && !state.prefillSent && candidate.finishReason) {
        delta.content = state.prefillText;
        state.prefillSent = true;
    }

    return {
        delta,
        finishReason: candidate.finishReason ? mapFinishReason(candidate.finishReason) : null,
        usage: chunk?.usageMetadata || null,
    };
}

/** 构造一个非流式的 OpenAI 错误响应体。 */
export function openaiError(message, type = 'invalid_request_error', code = null) {
    return { error: { message, type, param: null, code } };
}
