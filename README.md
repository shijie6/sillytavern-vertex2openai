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
