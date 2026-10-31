// v2：媒体键去噪/视频归一、订阅目标群、静态特征校验。
const fs = require('fs')
const src = fs.readFileSync(process.argv[2] || 'lib/index.js', 'utf8')
const g = (re, name) => { const m = src.match(re); if (!m) throw new Error('extract fail: ' + name); return m[1] }

let pass = 0, fail = 0
const t = (n, c, e) => { if (c) { pass++; console.log('PASS  ' + n) } else { fail++; console.log('FAIL  ' + n + (e !== undefined ? '  -> ' + JSON.stringify(e) : '')) } }

const mediaFactory = new Function('URL', `
  var MEDIA_NOISE = ${g(/var MEDIA_NOISE = (\/[^\n]+\/i);/, 'MEDIA_NOISE')};
  function getVideoId(url) {${g(/function getVideoId\(url\) \{([\s\S]*?)\n\}/, 'getVideoId')}}
  function getMediaKey(url) {${g(/function getMediaKey\(url\) \{([\s\S]*?)\n\}/, 'getMediaKey')}}
  return { getMediaKey, getVideoId };
`)(URL)
const { getMediaKey, getVideoId } = mediaFactory

console.log('=== 媒体键 ===')
t('头像 profile_images 被丢弃', getMediaKey('https://pbs.twimg.com/profile_images/123/abc.jpg') === '')
t('横幅被丢弃', getMediaKey('https://pbs.twimg.com/profile_banners/1/x') === '')
t('emoji 被丢弃', getMediaKey('https://abs-0.twimg.com/emoji/v2/svg/1f600.svg') === '')
t('视频缩略图归一到 video:<id>', getMediaKey('https://pbs.twimg.com/ext_tw_video_thumb/12345/pu/img/x.jpg') === 'video:12345')
t('amplify 缩略图归一', getMediaKey('https://pbs.twimg.com/amplify_video_thumb/777/pu/img/y.jpg') === 'video:777')
t('真实视频 URL 归一', getMediaKey('https://video.twimg.com/ext_tw_video/12345/pu/vid/720x1280/x.mp4?tag=12') === 'video:12345')
t('pbs 普通图保留', getMediaKey('https://pbs.twimg.com/media/ABC123.jpg?name=small') === 'https://pbs.twimg.com/media/abc123')
t('getVideoId 提取', getVideoId('/ext_tw_video/555/pu/vid/x.mp4') === '555')

const tgk = new Function(`
  function targetGroupKeys(groupIds, targetGroupId) {${g(/function targetGroupKeys\(groupIds, targetGroupId\) \{([\s\S]*?)\n\}/, 'targetGroupKeys')}}
  return targetGroupKeys;
`)()
console.log('\n=== 目标群 ===')
t('无测试目标 -> 全部群', JSON.stringify(tgk(['1', '2'], null)) === '["1","2"]')
t('数字群号与字符串比较', JSON.stringify(tgk(['100', '200'], 200)) === '["200"]')
t('本群未被订阅 -> 空', JSON.stringify(tgk(['100'], '999')) === '[]')
t('空目标字符串 -> 全部', JSON.stringify(tgk(['100'], '')) === '["100"]')

console.log('\n=== 静态特征 ===')
const checks = [
  ['代理浏览器忽略证书', /--ignore-certificate-errors/],
  ['代理账号密码 page.authenticate', /authenticate\(this\.auth\)/],
  ['并发上限 1', /BROWSER_MAX_PAGES = 1/],
  ['页面持有超时 3 分钟', /holdMs = 3 \* import_koishi\.Time\.minute/],
  ['空闲关闭 5 分钟', /BROWSER_IDLE_MS = 5 \* import_koishi\.Time\.minute/],
  ['定时器 unref', /unref\(\)/],
  ['合并转发每媒体独立 message 节点', /h\)\("message", \{\}, \[part\]\)/],
  ['降级正文 fallbackText', /fallbackText/],
  ['解析走 bot.sendMessage', /session\.bot\.sendMessage\(session\.channelId/],
  ['视频体积探测 Range', /Range: "bytes=0-0"/],
  ['http.file 绕过代理问题', /fetchFileViaProxy/],
  ['浏览器优先编排', /浏览器方式失败，尝试 API 兜底/],
  ['等待非置顶推文', /pinned\|已置顶\|置顶\|固定\|置頂/],
  ['hashtag 订阅保留', /twitter_hashtag_states/],
  ['订阅 ID 比较保留', /latestTweetId !== lastTweetId/],
  ['逐群成功计数保留', /successfulGroups/],
  ['手动测试不写库', /isNew && !isManualTrigger && successfulGroups > 0/],
  ['测试群组推送只推当前群', /本群（\$\{groupId\}）没有被任何订阅推送/],
  ['_name 注入为 0', null],
]
for (const [name, re] of checks) {
  if (re === null) t(name, (src.match(/__name\(/g) || []).length === 0)
  else t(name, re.test(src))
}

console.log(`\n===== ${fail === 0 ? 'ALL PASSED' : fail + ' FAILED'} (pass=${pass}, fail=${fail}) =====`)
process.exit(fail === 0 ? 0 : 1)
