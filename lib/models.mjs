/**
 * 模型能力档案 / 思考档位解析 / 采样参数策略。
 * 规则移植自 vertex2openai（Python 版）的 model_capabilities.py，按 Express 通道实测行为校准。
 */

const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k', 'candidateCount', 'maxOutputTokens', 'stopSequences'];

/** 去掉别名后缀，得到判断家族用的基础名。 */
function stripSuffixes(name) {
    let n = String(name || '').toLowerCase();
    for (const suf of ['-search', '-1k', '-2k', '-4k', '-512']) {
        if (n.endsWith(suf)) n = n.slice(0, -suf.length);
    }
    return n.replace(/-(minimal|low|medium|high|off|none)$/, '');
}

/** 自 Gemini 3.6 Flash 与 3.5 Flash-Lite 起，temperature/top_p/top_k 被废弃（传了会被忽略，未来直接 400）。 */
function tempDeprecated(name) {
    const n = String(name || '').toLowerCase();
    const m = n.match(/gemini-(\d+)(?:\.(\d+))?/);
    if (!m) return true; // 未知型号按已废弃处理，前向安全
    const major = Number(m[1]);
    const minor = Number(m[2] || 0);
    if (major >= 4) return true;
    if (major === 3 && minor >= 6) return true;
    if (major === 3 && minor === 5 && n.includes('flash-lite')) return true;
    return false;
}

export function getProfile(modelName) {
    const name = stripSuffixes(modelName);

    if (name.includes('image') || name.includes('nano-banana')) {
        return {
            family: 'image',
            isImage: true,
            thinkingKind: 'level',
            levels: new Set(['minimal', 'medium', 'high']),
            defaultLevel: 'high',
            allowedSampling: new Set(),
            requiresUserLastTurn: true,
        };
    }

    const m = name.match(/gemini-(\d+)(?:\.(\d+))?/);
    const major = m ? Number(m[1]) : 3;
    const isPro = name.includes('pro');

    if (major >= 3) {
        const levels = new Set(['low', 'medium', 'high']);
        if (major > 3 || (major === 3 && !isPro)) levels.add('minimal');
        let defaultLevel = 'medium';
        if (name.includes('flash-lite')) defaultLevel = 'minimal';
        else if (isPro) defaultLevel = 'high';

        const allowed = new Set(SAMPLING_KEYS);
        allowed.delete('candidateCount');
        if (tempDeprecated(name)) {
            allowed.delete('temperature');
            allowed.delete('top_p');
            allowed.delete('top_k');
        }
        return {
            family: 'g3',
            isImage: false,
            thinkingKind: 'level',
            levels,
            defaultLevel,
            allowedSampling: allowed,
            requiresUserLastTurn: true,
        };
    }

    return {
        family: 'legacy',
        isImage: false,
        thinkingKind: null,
        levels: new Set(),
        defaultLevel: '',
        allowedSampling: new Set(SAMPLING_KEYS),
        requiresUserLastTurn: false,
    };
}

/** 采样策略开关：auto 用版本判定，deprecated 强制剥离，allowed 强制保留。 */
export function applySamplingPolicy(profile, settings) {
    const policy = String(settings?.samplingPolicy || 'auto').toLowerCase();
    if (policy !== 'deprecated' && policy !== 'allowed') return profile;
    const allowed = new Set(profile.allowedSampling);
    if (policy === 'deprecated') {
        allowed.delete('temperature');
        allowed.delete('top_p');
        allowed.delete('top_k');
    } else {
        allowed.add('temperature');
        allowed.add('top_p');
        allowed.add('top_k');
        if (profile.family === 'g3') allowed.delete('candidateCount');
    }
    return { ...profile, allowedSampling: allowed };
}

/** 把档位就近向下夹取到该模型支持的集合里。 */
function clampLevel(level, levels) {
    if (levels.has(level)) return level;
    const order = ['minimal', 'low', 'medium', 'high'];
    const idx = order.indexOf(level);
    for (let i = idx; i >= 0; i--) {
        if (levels.has(order[i])) return order[i];
    }
    for (let i = idx + 1; i < order.length; i++) {
        if (levels.has(order[i])) return order[i];
    }
    return [...levels][0];
}

const EFFORT_ALIASES = {
    min: 'minimal', minimal: 'minimal',
    low: 'low', medium: 'medium', med: 'medium',
    high: 'high', max: 'high', xhigh: 'high', 'x-high': 'high', very_high: 'high',
    none: 'off', off: 'off',
};

function normEffort(e) {
    if (typeof e !== 'string') return null;
    const s = e.trim().toLowerCase();
    if (!s || s === 'auto') return null;
    return EFFORT_ALIASES[s] || s;
}

/**
 * 解析思考配置，返回 { mode: null } 或 { level, includeThoughts }。
 *
 * off 模式是酒馆场景的推荐值：SillyTavern 每次请求都硬发 reasoning_effort=xhigh，
 * 会把 Gemini 3.x 的思考档位顶到最高，导致只吐思考、不出正文。off 会忽略客户端档位，
 * 压到该模型最低合法档并隐藏思考，让预设自带的思维链接管。
 */
export function resolveThinking(modelName, request, settings, prefillActive = false) {
    const profile = getProfile(modelName);
    if (profile.thinkingKind === null) return { mode: null };

    const s = settings || {};
    let mode = s.nativeThinkingMode;
    if (!['request', 'off', 'console'].includes(mode)) mode = 'request';

    // 检测到预填充时同样压制原生思考：预设思维链要接管，两套思考会打架。
    const suppress = mode === 'off' || (prefillActive && s.prefillSuppressThinking !== false);
    const ignoreClient = suppress || mode === 'console';
    const reqEffort = ignoreClient ? null : normEffort(request?.reasoning_effort);

    if (profile.thinkingKind === 'level') {
        if (suppress) {
            return { mode: 'level', level: clampLevel('minimal', profile.levels), includeThoughts: false };
        }
        const raw = reqEffort || String(s.thinkingLevel || '').toLowerCase() || profile.defaultLevel;
        const level = raw === 'off' || raw === 'none' ? 'minimal' : raw;
        return {
            mode: 'level',
            level: clampLevel(level, profile.levels),
            includeThoughts: true,
        };
    }

    return { mode: null };
}
