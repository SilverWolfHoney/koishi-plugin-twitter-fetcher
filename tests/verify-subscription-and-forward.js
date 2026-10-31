// 验证移植后的构建产物：从 lib/index.js 提取补丁相关函数体并跑断言。
// 适配新产物格式：无 __name 包装、const 声明、UTF-8 中文字面量。
const fs = require('fs')

const file = process.argv[2] || 'lib/index.js'
const src = fs.readFileSync(file, 'utf8')
const g = (re, name) => {
  const m = src.match(re)
  if (!m) throw new Error('extract fail: ' + name)
  return m[1]
}

const isMediaTweetBody = g(/function isMediaTweet\(tweet\) \{([\s\S]*?)\n\}/, 'isMediaTweet')
const apiBody = g(/async function getLatestTweetUrlByApi\(ctx, username, excludeRetweets, filterMode, log, proxyUrl\) \{([\s\S]*?)\n\}\n/, 'getLatestTweetUrlByApi')
const orchBody = g(/async function getLatestTweetUrl\(ctx, puppeteer, username, cookie, excludeRetweets, filterMode, log, proxyUrl\) \{([\s\S]*?)\n\}\n/, 'getLatestTweetUrl')
const fallbackBody = g(/function buildFallbackForwardBody\(textBody, mediaCount\) \{([\s\S]*?)\n  \}/, 'buildFallbackForwardBody')
const sendBody = g(/async function sendProcessedTweet\(send, result\) \{([\s\S]*?)\n  \}/, 'sendProcessedTweet')
const noticeLit = g(/const MEDIA_DROPPED_NOTICE = ("(?:[^"\\]|\\.)*");/, 'MEDIA_DROPPED_NOTICE')

const warnings = []
const logger = { warn: (...a) => warnings.push(a.join(' ')), info: () => {} }

function makeFactory(browserImpl) {
  return new Function('require', 'process', 'URL', 'browserImpl', 'logger', `
    var TRANS_API_COOLDOWN_UNTIL = 0;
    var state = { cooldown: () => TRANS_API_COOLDOWN_UNTIL, set: (v) => { TRANS_API_COOLDOWN_UNTIL = v; } };
    function proxyHttpOptions(p) { return p ? { proxyAgent: p } : {}; }
    function isMediaTweet(tweet) {${isMediaTweetBody}}
    async function getLatestTweetUrlByApi(ctx, username, excludeRetweets, filterMode, log, proxyUrl) {${apiBody}}
    var getLatestTweetUrlByPuppeteer = browserImpl;
    async function getLatestTweetUrl(ctx, puppeteer, username, cookie, excludeRetweets, filterMode, log, proxyUrl) {${orchBody}}
    var MEDIA_DROPPED_NOTICE = ${noticeLit};
    function buildFallbackForwardBody(textBody, mediaCount) {${fallbackBody}}
    async function sendProcessedTweet(send, result) {${sendBody}}
    return { getLatestTweetUrlByApi, getLatestTweetUrl, state, buildFallbackForwardBody, sendProcessedTweet, MEDIA_DROPPED_NOTICE };
  `)(require, process, URL, browserImpl, logger)
}

let pass = 0, fail = 0
const t = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n) } else { fail++; console.log('FAIL  ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')) } }

const NOW = Date.now()
const daysAgo = n => new Date(NOW - n * 864e5).toUTCString()
const makeHtml = entries => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { timeline: { entries } } } })}</script>`
const TWEET = (id, media, ageDays) => ({ content: { tweet: {
  conversation_id_str: id,
  full_text: 'x',
  created_at: daysAgo(ageDays === undefined ? 0 : ageDays),
  entities: media ? { media: [{ id_str: '1' }] } : {},
} } })
const rateLimitErr = () => { const e = new Error('Too Many Requests'); e.response = { status: 429, statusText: 'Too Many Requests' }; return e }
const ctxFor = v => ({ http: { extend: () => ({ get: async () => { if (v instanceof Error) throw v; return makeHtml(v) } }) } })

;(async () => {
  console.log('=== A1) 首次 429 -> 进入冷却，返回 null ===')
  {
    const f = makeFactory(async () => null)
    f.state.set(0)
    let calls = 0
    const ctx = { http: { extend: () => ({ get: async () => { calls++; throw rateLimitErr() } }) } }
    const r = await f.getLatestTweetUrlByApi(ctx, 'u', false, 'all', () => {}, '')
    t('返回 null', r === null, r)
    t('建立冷却', f.state.cooldown() > Date.now(), f.state.cooldown() - Date.now())
    t('真实请求 1 次', calls === 1, calls)
    const leftMin = Math.round((f.state.cooldown() - Date.now()) / 6e4)
    t('冷却约 10 分钟', leftMin >= 9 && leftMin <= 10, leftMin)
  }

  console.log('\n=== A2) 冷却期内 -> 跳过请求 ===')
  {
    const f = makeFactory(async () => null)
    f.state.set(Date.now() + 6e5)
    let calls = 0
    const logs = []
    const ctx = { http: { extend: () => ({ get: async () => { calls++; return makeHtml([]) } }) } }
    const r = await f.getLatestTweetUrlByApi(ctx, 'u', false, 'all', m => logs.push(m), '')
    t('返回 null', r === null, r)
    t('未发起新请求', calls === 0, calls)
    t('日志提示冷却中', logs.some(l => /冷却中/.test(l)), logs.join(' | '))
  }

  console.log('\n=== A3) 非 429 错误 -> 向上抛出且不冷却 ===')
  {
    const f = makeFactory(async () => null)
    f.state.set(0)
    let threw = false
    try { await f.getLatestTweetUrlByApi(ctxFor(new Error('network broken')), 'u', false, 'all', () => {}, '') } catch { threw = true }
    t('抛出原始错误', threw)
    t('不进入冷却', f.state.cooldown() === 0, f.state.cooldown())
  }

  console.log('\n=== B1) 筛选模式仍然正确 ===')
  {
    const f = makeFactory(async () => null)
    f.state.set(0)
    const ctx = ctxFor([TWEET('201', true, 0), TWEET('202', false, 0), TWEET('203', true, 0)])
    t('all -> 201', await f.getLatestTweetUrlByApi(ctx, 'u', false, 'all', () => {}, '') === 'https://x.com/u/status/201')
    t('textOnly -> 202', await f.getLatestTweetUrlByApi(ctx, 'u', false, 'textOnly', () => {}, '') === 'https://x.com/u/status/202')
    t('mediaOnly -> 201', await f.getLatestTweetUrlByApi(ctx, 'u', false, 'mediaOnly', () => {}, '') === 'https://x.com/u/status/201')
  }

  console.log('\n=== B2) 热门榜乱序 -> 取 created_at 最新，而非 entries[0] ===')
  {
    const f = makeFactory(async () => null)
    f.state.set(0)
    const entries = [TWEET('900', false, 400), TWEET('901', false, 600), TWEET('902', false, 3000), TWEET('903', false, 2)]
    const r = await f.getLatestTweetUrlByApi(ctxFor(entries), 'u', false, 'all', () => {}, '')
    t('取到最新那条 903', r === 'https://x.com/u/status/903', r)
  }

  console.log('\n=== C1) 全部过旧(>7天) -> 判定无更新，返回 null ===')
  {
    const f = makeFactory(async () => null)
    f.state.set(0)
    const r = await f.getLatestTweetUrlByApi(ctxFor([TWEET('800', false, 400), TWEET('801', false, 30)]), 'u', false, 'all', () => {}, '')
    t('返回 null', r === null, r)
  }

  console.log('\n=== C2) 缺 created_at 的条目被跳过（保守，不误推）===')
  {
    const f = makeFactory(async () => null)
    f.state.set(0)
    const bad = { content: { tweet: { conversation_id_str: '700', full_text: 'x', entities: {} } } }
    const r = await f.getLatestTweetUrlByApi(ctxFor([bad]), 'u', false, 'all', () => {}, '')
    t('返回 null', r === null, r)
  }

  console.log('\n=== D1) 浏览器成功 -> 直接用浏览器结果，不调 API ===')
  {
    const f = makeFactory(async () => 'https://x.com/u/status/BROWSER')
    f.state.set(0)
    let apiCalls = 0
    const ctx = { http: { extend: () => ({ get: async () => { apiCalls++; return makeHtml([TWEET('999', false, 0)]) } }) } }
    const r = await f.getLatestTweetUrl(ctx, {}, 'u', '', false, 'all', () => {}, '')
    t('采用浏览器结果', r === 'https://x.com/u/status/BROWSER', r)
    t('未调用 API', apiCalls === 0, apiCalls)
  }

  console.log('\n=== D2) 浏览器抛错 -> 回退 API 兜底 ===')
  {
    const f = makeFactory(async () => { throw new Error('browser down') })
    f.state.set(0)
    const logs = []
    const r = await f.getLatestTweetUrl(ctxFor([TWEET('777', false, 0)]), {}, 'u', '', false, 'all', m => logs.push(m), '')
    t('采用 API 兜底结果', r === 'https://x.com/u/status/777', r)
    t('日志说明浏览器失败', logs.some(l => /浏览器方式失败/.test(l)), logs.join(' | '))
  }

  console.log('\n=== D3) 浏览器返回 null -> 回退 API 兜底 ===')
  {
    const f = makeFactory(async () => null)
    f.state.set(0)
    const logs = []
    const r = await f.getLatestTweetUrl(ctxFor([TWEET('666', false, 0)]), {}, 'u', '', false, 'all', m => logs.push(m), '')
    t('采用 API 兜底结果', r === 'https://x.com/u/status/666', r)
    t('日志说明未取到', logs.some(l => /未取到推文/.test(l)), logs.join(' | '))
  }

  console.log('\n=== D4) 浏览器失败 + API 也过旧 -> 返回 null ===')
  {
    const f = makeFactory(async () => { throw new Error('browser down') })
    f.state.set(0)
    const r = await f.getLatestTweetUrl(ctxFor([TWEET('555', false, 500)]), {}, 'u', '', false, 'all', () => {}, '')
    t('返回 null', r === null, r)
  }

  console.log('\n=== E) 合并转发降级 ===')
  const { buildFallbackForwardBody, sendProcessedTweet, MEDIA_DROPPED_NOTICE: NOTICE } = makeFactory(async () => null)
  t('说明文案存在', /媒体发送失败/.test(NOTICE), NOTICE)
  {
    const body = '用户ID: foo\n推文内容: hi'
    t('有媒体 -> 原文 + 说明', buildFallbackForwardBody(body, 2) === body + '\n\n' + NOTICE)
    t('空原文 -> 只有说明', buildFallbackForwardBody('', 1) === NOTICE)
    t('原文首尾空白被 trim', buildFallbackForwardBody('  abc  ', 1) === 'abc\n\n' + NOTICE)
    t('无媒体 -> 空串(不降级)', buildFallbackForwardBody('abc', 0) === '')
  }
  {
    warnings.length = 0
    const sent = []
    await sendProcessedTweet(async m => sent.push(m), { main: 'M', fallbackText: 'F', droppedMediaCount: 1, media: [] })
    t('main 成功 -> 只发一次', sent.length === 1 && sent[0] === 'M', sent)
    t('main 成功 -> 无 warn', warnings.length === 0, warnings)
  }
  {
    warnings.length = 0
    const sent = []
    await sendProcessedTweet(async m => { if (m === 'M') throw new Error('boom'); sent.push(m) }, { main: 'M', fallbackText: 'F', droppedMediaCount: 2, media: [] })
    t('失败 -> 降级重发', sent.length === 1 && sent[0] === 'F', sent)
    const joined = warnings.join(' || ')
    t('记录 warn', /合并转发发送失败/.test(joined), warnings)
    t('warn 含丢弃媒体数', /丢弃 2 项媒体/.test(joined), joined)
    t('warn 含原始错误', /boom/.test(joined), joined)
  }
  {
    warnings.length = 0
    const sent = []
    await sendProcessedTweet(async m => { if (m === 'M') throw new Error('Timeout with request send_group_forward_msg'); sent.push(m) }, { main: 'M', fallbackText: 'F', droppedMediaCount: 1, media: [] })
    t('Timeout -> 不降级重发', sent.length === 0, sent)
    t('Timeout -> 记录 warn', /超时/.test(warnings.join(' ')), warnings)
  }
  {
    const sent = []
    let threw = false
    try { await sendProcessedTweet(async m => { if (m === 'M') throw new Error('boom'); sent.push(m) }, { main: 'M', media: [] }) } catch { threw = true }
    t('无 fallbackText -> 抛原错误', threw && sent.length === 0, { threw, sent })
  }
  {
    let calls = 0, threw = false
    try { await sendProcessedTweet(async () => { calls++; throw new Error('always') }, { main: 'M', fallbackText: 'F', droppedMediaCount: 1, media: [] }) } catch { threw = true }
    t('fallback 也失败 -> 抛出且尝试两次', threw && calls === 2, { threw, calls })
  }
  {
    const sent = []
    await sendProcessedTweet(async m => sent.push(m), { main: 'M', fallbackText: 'F', droppedMediaCount: 0, media: ['m1', 'm2'] })
    t('media 照常发送', sent.join(',') === 'M,m1,m2', sent)
  }
  {
    const sent = []
    await sendProcessedTweet(async m => sent.push(m), { media: ['m1'] })
    t('main 为空 -> 只发 media', sent.join(',') === 'm1', sent)
  }

  console.log(`\n===== ${fail === 0 ? 'ALL PASSED' : fail + ' FAILED'} (pass=${pass}, fail=${fail}) =====`)
  process.exit(fail === 0 ? 0 : 1)
})().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(1) })
