# 修改记录（相对上游 `koishi-plugin-twitter-fetcher` 2.1.2）

- 上游仓库：<https://github.com/WhiteBr1ck/koishi-plugin-twitter-fetcher>
- 基线版本：`2.1.2`（commit `43f6b26`）
- 许可证：MIT（与上游一致，见 [LICENSE](./LICENSE)）
- 本修改版：`@silverwolfhoney/koishi-plugin-twitter-fetcher@1.0.0`

本修改版保留上游 2.1.2 的全部功能（话题标签订阅、ChatLuna 模型翻译、订阅去重与逐群投递跟踪、Google 翻译分段），
在此基础上叠加了一批针对国内网络环境与 NapCat/QQ 场景的修复。以下按功能列出。

## 1. 订阅取数：浏览器优先

**问题**：`syndication.twitter.com/srv/timeline-profile/screen-name/<user>` 返回的并不是时间线，而是
Top（热门）榜 —— `entries` 顺序与时间无关，`pageProps.latest_tweet_id` 等于 `entries[0]`（往往是置顶帖），
账号真正的最新推文根本不在响应里。原实现取 `entries[0]`，会把几年前的置顶/热门帖当成「最新推文」推送，
并写进 `last_tweet_url`，此后新推文因「链接没变化」被静默漏推。

**修改**：

- 新增 `getLatestTweetUrl(ctx, puppeteer, ...)`：**浏览器优先**，只有浏览器彻底失败时才走 API 兜底；
- 新增 `getLatestTweetUrlByApi`（兜底路径）：
  - 不再取 `entries[0]`，遍历全部 entries 取 `created_at` 最新的一条；
  - 缺 `created_at` 的条目直接丢弃；
  - 仅当最新一条落在 **7 天**内才采用，否则判定「无更新」—— 宁可漏、不误推旧热帖；
  - `429` 冷却保留（10 分钟），命中后直接走浏览器。
- 新增 `isMediaTweet` / `targetGroupKeys` / `TRANS_API_COOLDOWN_UNTIL`。

## 2. 代理支持（只影响本插件）

新增配置项：

```text
isProxy:   Schema.boolean().default(false)   // 总开关
proxyHost: Schema.string().default('http://127.0.0.1:7890')
proxyApi:  Schema.boolean().default(false)   // API 请求是否也走代理
```

- 按需启动**独立浏览器实例**（`BrowserManager`），`--proxy-server` 只给本插件，不碰共享的 `ctx.puppeteer`；
- 代理账密不能内联进 `--proxy-server`（Chromium 报 `ERR_NO_SUPPORTED_PROXIES`），凭据由 `page.authenticate()` 提供；
- 代理为 HTTPS（自签证书）时追加 **`--ignore-certificate-errors`**，否则 Chromium 在「连代理」的 TLS 握手阶段就失败；
- 所有 HTTP 出口（syndication API、vxtwitter/fxtwitter、谷歌翻译、媒体下载）统一带 `proxyAgent`。

## 3. 浏览器资源防护

- 懒启动，空闲 **5 分钟**自动关闭；所有定时器 `unref()`；
- 三重保护：并发信号量 `BROWSER_MAX_PAGES = 1`、页面持有超时 **3 分钟**、浏览器空闲 **5 分钟**；
- `cleanupChromeProfiles()`：启动后每 5 分钟清一次残留 profile（保护期 3 分钟内的不动）。

> 背景：代理连接 hang 住时 chromium 曾堆积到 40 个、`load average` 冲到 55，导致 docker/sshd 无响应。

## 4. 页面加载（`loadTweetPage` / `gotoPage`）

- 统一 `waitUntil: 'domcontentloaded'`：X 页面网络永不空闲，`networkidle2` 实测 30s 必然超时；
- 等待条件改为「出现第一条**非置顶**推文」，而不是任意 `article`（首条往往是置顶帖，提取逻辑会跳过它）；
- 超时放宽：订阅路径 `waitMs 50s / gotoMs 45s`，截图路径 `40s / 45s`（经代理首条推文约 19–28s 才出现）；
- 重试 3 次（`reload`），`closed / detached / Target` 类错误直接抛出。

## 5. 媒体

- `MEDIA_NOISE` 排除 `profile_images|profile_banners|/emoji/|hashflags|card_img|abs.twimg.com`（避免把头像当媒体）；
- `getVideoId()` 把「视频封面」与真实视频统一归一到 `video:<id>` 键；
- `maxVideoMB`（先发 `Range: bytes=0-0` 探测远端大小，不下载整个文件）+ `skipVideo`；
- `imageTransferMode/videoTransferMode = url` 在开代理时自动降为 `buffer`（NapCat 直连 twimg 国内不通）；
- `fetchFileViaProxy()`：**绕过 `ctx.http.file()`** —— 它内部只透传 `timeout`，会静默丢弃 `proxyAgent`。

## 6. 合并转发

- 每个媒体拆成独立 `<message>` 节点：`adapter-onebot` 的 `flush()` 在 `forward` 分支会把累积 children 打包成
  一个 node，导致 QQ 安卓对「单节点多条媒体」只能点开第一张；用 `<message>` 包裹后逐个可点，整体仍是同一个合并转发；
- 发送失败降级为纯文本 + `⚠️ 媒体发送失败（可能因文件过大或平台审核），已省略。`；
- **`Timeout` 类错误不降级重发**：超时的那条往往已经投递成功，重发会导致同一条推文出现两次；
- 发送统一走 `session.bot.sendMessage()`，不用 `session.send()`（后者会 `catch` 掉发送异常并返回空，降级逻辑永远不触发）。

## 7. 订阅推送

- `测试群组推送` 只推**当前群**（按 `session.guildId ?? session.channelId` 过滤），不再推所有群；
- 手动测试**不写库**（避免把测试当成已推送，导致正式检查漏掉这条推文）；
- 群号统一转字符串比较（配置里是字符串、`session.guildId` 可能是数字）；
- 与上游 2.1.2 的逐群投递跟踪合并：逐群 try/catch，仅当至少 1 个群成功后推进 `last_tweet_url`。

## 8. 翻译

- 保留上游 2.1.2 的 `translationProvider`（google/chatluna）、ChatLuna 模型翻译、同语言跳过、谷歌分段；
- 额外支持 Koishi 的 `translator` 服务（chatluna-translator）：默认（谷歌）路径下若存在该服务则优先使用；
- 翻译标签按实际来源动态生成：`【翻译】` / `【ChatLuna 翻译】` / `【谷歌翻译】`；
- 谷歌翻译请求带 `proxyAgent`（`isProxy` 开启时）。

## 与上游的兼容性

- 配置项只增不减，上游已有配置可原样迁移；
- 数据库只新增 `twitter_hashtag_states`（上游 2.1.0 引入），`twitter_subscriptions` 结构未变；
- 话题标签订阅、ChatLuna 翻译、订阅去重等上游 2.1.x 功能全部保留。

## 构建与发布

```bash
npm install
npm run build        # esbuild -> lib/index.js；tsc -> lib/index.d.ts
npm run build:client # 可选：client 未改动，产物与上游一致
npm publish --access public
```

## 许可

本项目以 **MIT** 许可发布（与上游一致）。原版版权归 WhiteBr1ck 所有；本修改版的改动同样以 MIT 提供。
