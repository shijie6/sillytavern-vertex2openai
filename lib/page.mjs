/**
 * 设置页 HTML。通过酒馆的 /api/plugins/vertex2openai/settings 访问。
 * 保存走酒馆路由，因此需要带 CSRF token —— 打开时先取一次 /csrf-token。
 */

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function selected(current, value) {
    return String(current) === String(value) ? ' selected' : '';
}

function checked(flag) {
    return flag ? ' checked' : '';
}

export function renderSettingsPage(s) {
    const keys = Array.isArray(s.expressKeys) ? s.expressKeys.join('\n') : String(s.expressKeys || '');
    const models = Array.isArray(s.models) ? s.models.join('\n') : String(s.models || '');
    const cookies = Array.isArray(s.cookies) ? s.cookies.join('\n') : String(s.cookies || '');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vertex2OpenAI 设置</title>
<style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; line-height: 1.6; background: #f7f8fa; color: #1f2328; }
    @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e6e6e6; } }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
    @media (prefers-color-scheme: dark) { .sub { color: #9aa3ad; } }
    .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 18px; margin-bottom: 16px; }
    @media (prefers-color-scheme: dark) { .card { background: #1e2127; border-color: #2f343b; } }
    label { display: block; font-weight: 600; font-size: 13px; margin: 12px 0 4px; }
    label:first-child { margin-top: 0; }
    input[type=text], input[type=number], textarea, select {
        width: 100%; box-sizing: border-box; padding: 7px 9px; font-size: 13px; font-family: inherit;
        border: 1px solid #d0d5db; border-radius: 6px; background: #fff; color: inherit;
    }
    @media (prefers-color-scheme: dark) { input[type=text], input[type=number], textarea, select { background: #14171c; border-color: #3a4048; } }
    textarea { min-height: 74px; resize: vertical; }
    .hint { font-size: 12px; color: #6b7280; margin-top: 4px; }
    @media (prefers-color-scheme: dark) { .hint { color: #9aa3ad; } }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .row > div { flex: 1 1 200px; }
    button { padding: 9px 18px; font-size: 14px; border-radius: 6px; border: 1px solid #0d6efd; background: #0d6efd; color: #fff; cursor: pointer; font-family: inherit; }
    button.secondary { background: transparent; color: #0d6efd; }
    button:disabled { opacity: .6; cursor: default; }
    #msg { margin-left: 12px; font-size: 13px; }
    code { background: rgba(125,125,125,.15); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
    .ok { color: #1a7f37; } .err { color: #c0392b; }
</style>
</head>
<body>
<h1>Vertex2OpenAI · Gemini Express 反代</h1>
<div class="sub">设置保存在插件目录的 <code>settings.json</code>；改完端口需要重启服务，改其他项即时生效。</div>

<div class="card">
    <label>通道选择</label>
    <select id="channel">
        <option value="auto"${selected(s.channel, 'auto')}>自动（Express 被限流时自动转 Cookie，推荐）</option>
        <option value="express"${selected(s.channel, 'express')}>只用 Express（官方 API Key）</option>
        <option value="cookie"${selected(s.channel, 'cookie')}>只用 Cookie 直连</option>
    </select>
    <div class="hint">两条通道的配额是分开算的：Express 走 API 配额，Cookie 走网页端那一份。
    Express 被限流时 Cookie 往往还能用，这就是加它的意义。</div>

    <label>Express API Key（每行一把，多把自动轮换）</label>
    <textarea id="expressKeys" placeholder="AQ.Ab8RN...">${esc(keys)}</textarea>
    <div class="hint">Google 发的那把凭证（常见 <code>AQ.</code> 或 <code>AIza</code> 开头）。不是你自己编的访问口令。</div>

    <div class="row">
        <div>
            <label>GCP 项目 ID</label>
            <input type="text" id="projectId" value="${esc(s.projectId)}" placeholder="central-star-x83d0">
            <div class="hint">钉死区域用。留空则由 Google 自行路由，可能落到没有该模型的区域。</div>
        </div>
        <div>
            <label>区域</label>
            <input type="text" id="location" value="${esc(s.location)}" placeholder="global">
            <div class="hint">Express 模式一般填 <code>global</code>。</div>
        </div>
    </div>
</div>

<div class="card">
    <div class="row">
        <div>
            <label>监听端口</label>
            <input type="number" id="port" value="${esc(s.port)}">
            <div class="hint">改完需点「保存并重启服务」。</div>
        </div>
        <div>
            <label>监听地址</label>
            <input type="text" id="host" value="${esc(s.host)}">
            <div class="hint">只给酒馆自己用填 <code>127.0.0.1</code>；要局域网其他设备访问填 <code>0.0.0.0</code>。</div>
        </div>
    </div>

    <label>访问口令（可留空）</label>
    <input type="text" id="accessKey" value="${esc(s.accessKey)}" placeholder="留空表示不校验">
    <div class="hint">客户端 <code>Authorization: Bearer</code> 需要匹配。只在需要防局域网内其他人时用。</div>

    <label>出网代理（可留空）</label>
    <input type="text" id="proxyUrl" value="${esc(s.proxyUrl)}" placeholder="http://192.168.31.115:7890">
    <div class="hint">只支持 HTTP 代理（Clash 的混合端口就是）。手机已开 VPN/TUN 全局模式时留空即可。<br>
    注意：安卓上不同 App 的 127.0.0.1 是隔离的，这里要填 Clash 的<b>局域网</b>地址和端口，并开启「允许局域网连接」。</div>
</div>

<div class="card">
    <label>原生思考控制</label>
    <select id="nativeThinkingMode">
        <option value="off"${selected(s.nativeThinkingMode, 'off')}>关闭原生思考（推荐，让预设思维链接管）</option>
        <option value="request"${selected(s.nativeThinkingMode, 'request')}>跟随客户端档位</option>
        <option value="console"${selected(s.nativeThinkingMode, 'console')}>强制使用下面设的档位</option>
    </select>
    <div class="hint">酒馆每次请求都会硬发 <code>reasoning_effort=xhigh</code>，会把 Gemini 3.x 的思考顶到最高档，
    表现为只吐思考、不出正文。选「关闭」即可忽略它。</div>

    <label>强制档位（仅上面选「强制」时生效）</label>
    <select id="thinkingLevel">
        <option value=""${selected(s.thinkingLevel, '')}>跟随模型默认</option>
        <option value="minimal"${selected(s.thinkingLevel, 'minimal')}>minimal</option>
        <option value="low"${selected(s.thinkingLevel, 'low')}>low</option>
        <option value="medium"${selected(s.thinkingLevel, 'medium')}>medium</option>
        <option value="high"${selected(s.thinkingLevel, 'high')}>high</option>
    </select>

    <label><input type="checkbox" id="prefillSuppressThinking"${checked(s.prefillSuppressThinking)}> 检测到预填充时自动压制原生思考</label>
    <div class="hint">预设末尾放了 assistant 条目（思维链开标签）时勾选，避免两套思考打架。</div>

    <label>采样参数策略</label>
    <select id="samplingPolicy">
        <option value="auto"${selected(s.samplingPolicy, 'auto')}>自动（按模型版本判定）</option>
        <option value="deprecated"${selected(s.samplingPolicy, 'deprecated')}>强制剥离 temperature/top_p/top_k</option>
        <option value="allowed"${selected(s.samplingPolicy, 'allowed')}>强制保留</option>
    </select>

    <label><input type="checkbox" id="debug"${checked(s.debug)}> 输出调试日志（打印出站参数）</label>
</div>

<div class="card">
    <label>模型列表（每行一个，粘贴时逗号/分号分隔也能认）</label>
    <textarea id="models">${esc(models)}</textarea>
    <div class="hint">保存时会自动拆分并去掉空白，不用担心格式。</div>
</div>

<div class="card">
    <h1 style="font-size:16px;margin:0 0 8px">Cookie 直连（网页端配额）</h1>
    <div class="sub" style="margin-bottom:12px">
        走 Cloud Console 前端的私有接口，配额池和 API Key 是分开的。
        <b>风险提示：这是未公开接口，Google 随时可能改签名或封掉；Cookie 等同完整 Google 账号权限，
        别外传、别填到任何第三方服务里。</b>
    </div>

    <label>浏览器 Cookie（一整条粘进来即可；想配多条轮换，中间空一行）</label>
    <textarea id="cookies" placeholder="SEARCH_SAMESITE=...; SID=...; SAPISID=...; ...">${esc(cookies)}</textarea>
    <div class="hint">
        拿法：电脑浏览器登录 <code>console.cloud.google.com</code> → F12 → 网络(Network) →
        随便点一个请求 → 请求头里找 <code>cookie:</code> 那一整行 → 复制全部内容。<br>
        必须含 <code>SAPISID</code> 或 <code>__Secure-3PAPISID</code>，否则算不出认证头。<br>
        <b>粘进来看到它自动折成好几行是正常的</b>，插件会当一条处理；只有在你确实想配多条时才需要空一行隔开。<br>
        退出 Google 登录、改密码或一段时间后 Cookie 会失效，表现为突然 401，重新抓一次即可。
    </div>

    <div class="row">
        <div>
            <label>Cookie 通道的项目 ID</label>
            <input type="text" id="cookieProjectId" value="${esc(s.cookieProjectId)}" placeholder="留空则用上面的项目 ID">
            <div class="hint">Cookie 通道必须有项目 ID。</div>
        </div>
        <div>
            <label>安全过滤</label>
            <select id="cookieSafety">
                <option value="OFF"${selected(s.cookieSafety, 'OFF')}>OFF（关掉过滤器）</option>
                <option value="BLOCK_NONE"${selected(s.cookieSafety, 'BLOCK_NONE')}>BLOCK_NONE（评分但不拦截）</option>
            </select>
            <div class="hint">角色扮演一般选 OFF，否则正常剧情也可能被拦。</div>
        </div>
    </div>
    <div class="hint" id="cookieStatus"></div>
</div>

<div class="card">
    <label>连通性自检（真发一条消息到 Google）</label>
    <div class="row">
        <div>
            <label>模型</label>
            <select id="testModel"></select>
        </div>
        <div>
            <label>通道</label>
            <select id="testChannel">
                <option value="">按上面的通道设置</option>
                <option value="express">强制走 Express</option>
                <option value="cookie">强制走 Cookie</option>
            </select>
        </div>
    </div>
    <div class="hint">默认选 gemini-3.6-flash。想确认哪条通道能用，就选定通道再测。</div>

    <div style="margin-top:12px">
        <button id="scan" class="secondary">批量探测全部模型</button>
    </div>
    <div class="hint">
        逐个真发一条最短消息，列出哪些模型在当前通道下实际可用。<br>
        <b>注意：这会消耗 N 次请求配额</b>（N = 模型列表长度），配额已经很紧张时别点。
    </div>
    <pre id="scanOut" style="display:none;white-space:pre-wrap;background:rgba(125,125,125,.12);padding:10px;border-radius:6px;font-size:12px;margin-top:8px"></pre>
</div>

<div>
    <button id="save">保存</button>
    <button id="saveRestart" class="secondary">保存并重启服务</button>
    <button id="test" class="secondary">连通性自检</button>
    <span id="msg"></span>
</div>

<script>
const $ = id => document.getElementById(id);
const msg = (text, cls) => { $('msg').textContent = text; $('msg').className = cls || ''; };

let csrf = '';
async function getCsrf() {
    if (csrf) return csrf;
    try {
        const r = await fetch('/csrf-token', { credentials: 'same-origin' });
        if (r.ok) { const d = await r.json(); csrf = d.token || ''; }
    } catch (e) { /* 服务端可能已关闭 CSRF */ }
    return csrf;
}

function collect() {
    return {
        channel: $('channel').value,
        cookies: $('cookies').value,
        cookieProjectId: $('cookieProjectId').value.trim(),
        cookieSafety: $('cookieSafety').value,
        expressKeys: $('expressKeys').value,
        projectId: $('projectId').value.trim(),
        location: $('location').value.trim(),
        port: Number($('port').value) || 8050,
        host: $('host').value.trim() || '0.0.0.0',
        accessKey: $('accessKey').value.trim(),
        proxyUrl: $('proxyUrl').value.trim(),
        nativeThinkingMode: $('nativeThinkingMode').value,
        thinkingLevel: $('thinkingLevel').value,
        prefillSuppressThinking: $('prefillSuppressThinking').checked,
        samplingPolicy: $('samplingPolicy').value,
        debug: $('debug').checked,
        models: $('models').value,
    };
}

async function post(path, data) {
    const token = await getCsrf();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-CSRF-Token'] = token;
    const r = await fetch('/api/plugins/vertex2openai' + path, {
        method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(data || {}),
    });
    return await r.json().catch(() => ({ ok: false, error: '响应解析失败（HTTP ' + r.status + '）' }));
}

$('save').onclick = async () => {
    msg('保存中...');
    const r = await post('/config', collect());
    msg(r.ok ? '已保存' : ('保存失败：' + (r.error || '')), r.ok ? 'ok' : 'err');
};

$('saveRestart').onclick = async () => {
    msg('保存并重启中...');
    const r1 = await post('/config', collect());
    if (!r1.ok) { msg('保存失败：' + (r1.error || ''), 'err'); return; }
    const r2 = await post('/restart', {});
    msg(r2.ok ? ('已重启，端口 ' + r2.port) : ('重启失败：' + (r2.error || '')), r2.ok ? 'ok' : 'err');
};

function refreshTestModels() {
    const list = $('models').value.split(/[\\n,;]+/).map(s => s.trim()).filter(Boolean);
    const sel = $('testModel');
    const keep = sel.value;
    sel.innerHTML = '';
    for (const m of list) {
        const o = document.createElement('option');
        o.value = m; o.textContent = m;
        sel.appendChild(o);
    }
    // 默认别挑 gemini-4-argon：名字靠前但不一定有额度，容易误判成配置有问题
    const fallback = list.find(m => m === 'gemini-3.6-flash') || list[0];
    sel.value = list.includes(keep) ? keep : (fallback || '');
}

$('models').addEventListener('input', refreshTestModels);
refreshTestModels();

$('test').onclick = async () => {
    const model = $('testModel').value;
    if (!model) { msg('模型列表为空，先填模型再自检', 'err'); return; }
    const ch = $('testChannel').value;
    const chLabel = ch ? ({ express: 'Express', cookie: 'Cookie' })[ch] : '当前通道';
    msg('正在用 ' + model + ' 经 ' + chLabel + ' 发一条测试消息...');
    const qs = '?model=' + encodeURIComponent(model) + (ch ? '&channel=' + encodeURIComponent(ch) : '');
    const r = await get('/selftest' + qs);
    const out = $('scanOut');
    if (r.ok) {
        const via = { express: 'Express', cookie: 'Cookie' }[r.channel] || r.channel;
        msg('成功（' + via + '）：' + (r.reply || '').slice(0, 60), 'ok');
        out.style.display = 'none';
    } else {
        const kind = r.kind || '其他';
        const hint = r.hint || '';
        msg('失败[' + kind + ']：' + (r.error || '').slice(0, 90), 'err');
        out.style.display = 'block';
        out.textContent = ['类型：' + kind, hint ? '建议：' + hint : '', '', '上游原始报错：', r.error || ''].join('\\n');
    }
};

$('scan').onclick = async () => {
    const ch = $('testChannel').value;
    const btn = $('scan');
    const out = $('scanOut');
    btn.disabled = true;
    out.style.display = 'block';
    out.textContent = '探测中，请稍候...';
    try {
        const r = await post('/scan', { channel: ch });
        if (!r.ok) { out.textContent = '探测失败：' + (r.error || ''); return; }
        const okList = r.results.filter(x => x.ok).map(x => x.model);
        const lines = [
            '通道：' + r.channel + ' | 可用 ' + okList.length + ' / ' + r.results.length,
            '',
            ...r.results.map(x => (x.ok ? '  ✅ ' + x.model : '  ❌ ' + x.model + '  [' + x.kind + '] ' + x.error)),
        ];
        if (okList.length) {
            lines.push('');
            lines.push('只保留可用模型的话，把下面这段粘到模型列表框：');
            lines.push(okList.join('\\n'));
        }
        out.textContent = lines.join('\\n');
    } finally {
        btn.disabled = false;
    }
};

function showCookieStatus() {
    // 注意：这段脚本本身位于 JS 模板字符串里，正则里的反斜杠必须写成 \\r \\n，
    // 否则会被模板先转义成真实回车换行，正则字面量被切断 -> 整段 script 语法错误，
    // 表现为页面上所有按钮点了都没反应。
    const lines = $('cookies').value.split(/[\\r\\n]+/).map(s => s.trim()).filter(Boolean);
    const el = $('cookieStatus');
    if (!lines.length) { el.textContent = ''; return; }
    const bad = lines.filter(c => !/SAPISID/i.test(c));
    el.textContent = bad.length
        ? ('其中 ' + bad.length + ' 条没找到 SAPISID 字段，可能无法使用')
        : ('已填 ' + lines.length + ' 条，均含 SAPISID');
}

$('cookies').addEventListener('input', showCookieStatus);
showCookieStatus();

async function get(path) {
    const r = await fetch('/api/plugins/vertex2openai' + path, { credentials: 'same-origin' });
    return await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
}
</script>
</body>
</html>`;
}
