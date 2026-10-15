# vertex2openai for SillyTavern

把 [vertex2openai](https://github.com/bad-woman/vertex2openai) 的核心能力做成一个 **SillyTavern 服务端插件**：
在酒馆进程内直接跑一个 OpenAI 兼容端点，把请求转发到 **Gemini Express Mode**（GCP 快速模式）。

不用在手机容器里装 Python、不用装依赖、不用自己拉服务，装完插件就能用；不想用了在酒馆里卸载插件即可，不留残余。

## 它解决什么问题

| 之前的做法 | 麻烦在哪 |
|---|---|
| 电脑上跑 Python 反代 | 电脑得一直开着，手机在外面就用不了 |
| 手机容器里部署 Python 服务 | 要进终端装 venv、装依赖，卸载要手动删一堆文件 |
| 酒馆直连 Vertex AI | 能用，但没有原生思考控制，遇到 Gemini 3.x 只吐思考、不出正文时没法调 |

插件版的好处：

- **跑在酒馆进程内**，手机填 `http://127.0.0.1:8050` 就行，不存在安卓上「不同 App 的 127.0.0.1 互相访问不到」的问题
- **零第三方依赖**，只用 Node 内置模块，装完即用
- **自带设置页**，原生思考控制、代理、Key 都能在浏览器里改

## 安装

### 1. 开启服务端插件

编辑酒馆目录下的 `config.yaml`，确认这一项：

```yaml
enableServerPlugins: true
```

手机上（SillyDroid 终端）可以用这条命令改，改完重启酒馆：

```bash
sed -i 's/^enableServerPlugins:.*/enableServerPlugins: true/' config.yaml
grep enableServerPlugins config.yaml
```

如果文件里没有这一行，手动加到最后一行即可。

### 2. 安装插件

酒馆界面：**扩展 → 下载扩展/插件** → 粘贴本仓库地址 → 安装 → 重启酒馆。

或者手动装（终端里）：

```bash
cd plugins && git clone <本仓库地址> vertex2openai
```

### 装成功但没生效？

服务端插件**在「扩展」面板里没有开关**，别去找它。它只有两个状态：文件在不在 `plugins/` 目录里，以及 `enableServerPlugins` 开没开。三者缺一都不会加载，且界面上不会有任何提示。

按顺序查：

1. **看目录对不对。** 插件必须落在酒馆的 `plugins/` 下，路径形如

   ```
   <酒馆目录>/plugins/sillytavern-vertex2openai/index.mjs
   ```

   如果它被装进了 `public/scripts/extensions/third-party/`，那是 UI 扩展的位置，服务端永远不会加载它。手动挪过去即可。

2. **看开关。** `config.yaml` 里必须是 `enableServerPlugins: true`，改完**重启酒馆**（不是刷新页面）。

3. **看启动日志。** 重启后服务端控制台里搜这几个关键词，能直接定位：

   | 日志 | 含义 |
   |---|---|
   | `Initializing plugin from .../index.mjs` | 加载成功 |
   | `1 server plugin(s) are currently loaded` | 已生效 |
   | `Failed to load plugin from ...` | 入口文件加载失败，括号里是具体报错 |
   | `Failed to load plugin module; plugin info missing field` | `info` 缺 id/name/description |
   | 以上全都搜不到 | `enableServerPlugins` 没开，或目录不对 |

4. **确认更新拉到了。** `plugins/` 下是 git 仓库时，酒馆启动会自动 `git pull`。如果 SillyDroid 里没有 git 或网络不通，手动进目录 `git pull` 一次。

### 3. 填 Key

浏览器打开（把端口换成你酒馆的端口）：

```
http://<酒馆地址>/api/plugins/vertex2openai/settings
```

填这几项：

- **Express API Key** —— Google 发的那把凭证（`AQ.` 或 `AIza` 开头）。多个用换行分隔，会自动轮换
- **GCP 项目 ID** —— 用来钉死区域，避免 Google 把请求路由到没有该模型的区域
- **区域** —— Express 模式填 `global`
- **出网代理** —— 见下面的说明

填完点「连通性自检」，会真的发一条消息到 Google 验证整条链路，成功会显示模型回的内容。

### 4. 配置酒馆连接

| 项 | 值 |
|---|---|
| API 类型 | Chat Completion / 自定义（OpenAI 兼容） |
| 接口地址 | `http://127.0.0.1:8050/v1` |
| 密钥 | 设置页里填的「访问口令」（留空则随便填一个） |
| 模型 | 手动输入，例如 `gemini-3.6-flash` |

## 出网代理（手机上的关键一步）

手机上访问 Google 需要代理。两种做法选一个：

**A. Clash 开全局/VPN 模式** —— 代理栏留空，流量自动走系统 VPN，最省事。

**B. 填 HTTP 代理地址** —— 需要注意：**安卓上不同 App 的 127.0.0.1 是隔离的**，
在插件里填 `127.0.0.1:7890` 到不了 Clash 那个 App。要在 Clash 里打开「允许局域网连接」，
然后填手机的局域网地址，例如 `http://192.168.31.115:7890`。

只支持 HTTP 代理（Clash 的混合端口就是），不支持 SOCKS。

## 两条通道：Express 与 Cookie

Express（官方 API Key）被限流是常态，尤其是刚开通的试用额度。插件因此内置了第二条通道。

| | Express | Cookie 直连 |
|---|---|---|
| 凭证 | Google 发的 API Key | 浏览器登录态的 Cookie |
| 端点 | 官方 `aiplatform.googleapis.com` | Cloud Console 前端私有的 `batchGraphql` |
| 配额 | API 配额池 | **网页端那一份，和 API 是分开算的** |
| 稳定性 | 有官方兼容承诺 | 无承诺，Google 可能随时改签名或封掉 |
| 安全 | 泄露只影响 API 调用 | **等同整个 Google 账号权限** |

**设置里的「通道选择」：**

- `自动`（推荐）——先走 Express，被限流或拒绝时**静默切到 Cookie**，酒馆完全感知不到
- `只用 Express` / `只用 Cookie` —— 需要单独排查某条通道时选

自动切换的判定：Express 返回非 200，或者上游报错但**还没吐出任何一个字**时才切。一旦开始输出内容就不再切换，避免半截回复。

### 怎么拿 Cookie

1. 电脑浏览器登录 `console.cloud.google.com`（必须是**已开通 Vertex AI / Express 试用**的那个 Google 账号）
2. `F12` 打开开发者工具 → 「网络 Network」→ 随便触发一个请求（刷新页面即可）
3. 点任意一条请求 → 右侧「标头 Headers」→ 请求头里找 **`cookie:`** 那一行
4. **整条原样复制**，粘贴到设置页的 Cookie 框里

必须包含 `SAPISID` 或 `__Secure-3PAPISID`，否则算不出认证头，插件会在设置页直接提示你。

还需要填**项目 ID**（Cookie 通道必须有，留空会复用上面 Express 那个）。

> **粘进去发现它自动折成好几行？不用管，这是正常的。**
> 浏览器只是把超长的一行显示成多行，实际内容并没有换行符，插件会当一条 Cookie 处理。
> 只有在你**确实想配多条轮换**时，才需要在两条之间**空一行**（连续两个回车）。

### Cookie 什么时候会失效

退出 Google 登录、改密码、或者过一段时间都会失效，表现是**突然全部 401**。
重新按上面的步骤抓一次粘进去即可，不用动别的设置。设置页的 Cookie 框下方会实时显示「已填 N 条，均含 SAPISID」的校验结果。

### 风险提示（认真看）

- Cookie **等同完整的 Google 账号权限**，拿到它可以操作你的云资源。只放在自己的设备上，**不要发给别人、不要填进任何第三方服务**
- 这是**未公开的私有接口**，GitHub 上同类项目都标注了「无兼容性承诺、可能违反 GCP 服务条款」。要不要用自己权衡
- 插件不会把 Cookie 上传到任何地方，它只存在你设备上的 `settings.json`

## 关于「只吐思考、不出正文」

SillyTavern 每次请求都会硬发 `reasoning_effort=xhigh`，会把 Gemini 3.x 的思考档位顶到最高，
表现是模型一直在思考、正文出不来，最后返回 `FINISH_REASON_UNSPECIFIED`。

插件默认就是 **关闭原生思考**（把档位压到该模型最低合法档并隐藏思考），忽略客户端传来的档位，
让预设自带的思维链接管。想改的话在设置页的「原生思考控制」里选。

如果你的预设在末尾放了一条 assistant 条目作为思维链开标签（预填充），插件会自动把它转成续写指令
（Gemini 3.x 不接受以 model 轮次结尾），并把这段文本拼回输出开头，保证预设里的正则能匹配到。
相关开关是「检测到预填充时自动压制原生思考」。

## 端口冲突

默认 8050。如果这个端口被别的程序占了，插件会在酒馆启动日志里提示，设置页仍然可以打开，
换个端口点「保存并重启服务」即可。

## 安全提示

- 设置文件 `settings.json` 存着你的 API Key，**已在 .gitignore 里排除**，不会进仓库
- 如果服务监听 `0.0.0.0`，局域网内任何人都能用它（扣的是你的额度）。只给酒馆自己用就把监听地址设成 `127.0.0.1`
- 服务端插件不受沙箱限制，安装前请确认来源可信

## 卸载

酒馆里卸载插件，或者终端里删目录：

```bash
rm -rf plugins/vertex2openai
```
