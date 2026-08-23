#!/usr/bin/env node
/**
 * 多用户支持 P1-2 / M1 信任集单测。
 *
 * 跑法：先 `bash scripts/build.sh`，再 `node tests/trust.test.cjs`。
 * 纯函数测 trust.decideTrust 的五种分支：owner / trusted / bootstrap 首次 /
 * bootstrap 已消耗 / owner-only 陌生人 / manual 陌生人 / addTrusted / removeTrusted / setTrustMode。
 */
'use strict'

// 测试卫生：隔离数据目录，防止 logger 写日志污染真实 ~/.dsh/wechat-bridge。
// 必须在 require 任何 bridge 模块之前设置（constants.js 在 import 时读环境变量）。
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-trust-test-'))
process.env.DSH_BRIDGE_DATA_DIR = tmpDataDir

const { decideTrust, addTrusted, removeTrusted, setTrustMode, listTrusted, isPlausibleUserId } =
  require(path.join(__dirname, '..', 'lib', 'bridge', 'trust.js'))

let pass = 0
let fail = 0
function check(label, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.error(`  ✗ ${label}${detail ? ' — ' + JSON.stringify(detail) : ''}`)
  }
}

const OWNER = 'wxid_owner_001'
const STRANGER = 'wxid_stranger_007'
const ANOTHER = 'wxid_another_999'

// 1) owner-only：永远只放 owner
{
  console.log('owner-only 模式')
  let file = { mode: 'owner-only', trusted: {} }
  const d1 = decideTrust({ fromUserId: OWNER, ownerUserId: OWNER, file })
  check('owner 放行', d1.allowed && d1.reason === 'owner')

  const d2 = decideTrust({ fromUserId: STRANGER, ownerUserId: OWNER, file: d1.file })
  check('陌生人拒绝（无副作用）', !d2.allowed && d2.reason === 'rejected-stranger' && d2.file === d1.file)
}

// 2) bootstrap：首位陌生人自动入集，消耗后下次不再自动
{
  console.log('bootstrap 模式')
  let file = { mode: 'bootstrap', trusted: {} }
  const d1 = decideTrust({ fromUserId: STRANGER, ownerUserId: OWNER, file })
  check('首次陌生人自动入集', d1.allowed && d1.reason === 'bootstrap-auto')
  check('副作用落盘（bootstrapConsumed=true）', d1.file.bootstrapConsumed === true)
  check('副作用落盘（trusted 写入）', d1.file.trusted[STRANGER] && d1.file.trusted[STRANGER].by === 'bootstrap')

  // 已入集的人后续再来：放行且 lastSeenAt 刷新
  const d2 = decideTrust({ fromUserId: STRANGER, ownerUserId: OWNER, file: d1.file })
  check('已入集再次到来放行', d2.allowed && d2.reason === 'trusted')
  check('lastSeenAt 已刷新', typeof d2.file.trusted[STRANGER].lastSeenAt === 'number')
  check('trusted 分支返回新对象（供调用方判定落盘）', d2.file !== d1.file)
  // 原始 file 未被就地修改（lastSeenAt 保持 d1 时刻的值，d2 刷新后更大）
  check('原始 file 未被就地修改', (d2.file.trusted[STRANGER].lastSeenAt || 0) >= (d1.file.trusted[STRANGER].lastSeenAt || 0))

  // 第二个陌生人：bootstrap 已耗尽 → 拒绝
  const d3 = decideTrust({ fromUserId: ANOTHER, ownerUserId: OWNER, file: d2.file })
  check('bootstrap 耗尽后第二个陌生人拒绝', !d3.allowed && d3.reason === 'rejected-stranger')

  // 异常 userId（含 :: / 空格）不被自动入集——避免 keyFor 抛错吞消息
  const bad = 'wxid::bad user'
  const d4 = decideTrust({ fromUserId: bad, ownerUserId: OWNER, file: { mode: 'bootstrap', trusted: {} } })
  check('bootstrap 异常 userId 拒绝且不消耗名额', !d4.allowed && d4.file.bootstrapConsumed === undefined)
}

// 3) manual：永不自动信任，仅 /trust 添加的人
{
  console.log('manual 模式')
  let file = { mode: 'manual', trusted: {} }
  const d1 = decideTrust({ fromUserId: STRANGER, ownerUserId: OWNER, file })
  check('manual 陌生人拒绝', !d1.allowed && d1.reason === 'rejected-stranger')

  // 显式 addTrusted 之后放行
  file = addTrusted(file, STRANGER, 'owner', '老婆')
  const d2 = decideTrust({ fromUserId: STRANGER, ownerUserId: OWNER, file })
  check('manual + 显式信任 → 放行', d2.allowed && d2.reason === 'trusted')
  check('备注透传', d2.file.trusted[STRANGER].note === '老婆')

  // 移除后拒绝
  const removed = removeTrusted(file, STRANGER)
  check('removeTrusted 真删了', !removed.trusted[STRANGER])
  const d3 = decideTrust({ fromUserId: STRANGER, ownerUserId: OWNER, file: removed })
  check('removeTrusted 后被拒绝', !d3.allowed)
}

// 4) 边界：空 fromUserId、empty ownerUserId
{
  console.log('边界')
  const d1 = decideTrust({ fromUserId: '', ownerUserId: OWNER, file: { mode: 'manual', trusted: {} } })
  check('空 fromUserId 拒绝', !d1.allowed)

  // 空 ownerUserId + 来自未信任的 user：拒绝（避免 owner 缺失时放行所有人）
  const d2 = decideTrust({ fromUserId: STRANGER, ownerUserId: '', file: { mode: 'manual', trusted: {} } })
  check('空 owner + manual 陌生人拒绝', !d2.allowed)

  // 空 owner + 信任集里有该 user：放行
  const file = { mode: 'manual', trusted: { [STRANGER]: { addedAt: '2026-01-01T00:00:00Z', by: 'owner' } } }
  const d3 = decideTrust({ fromUserId: STRANGER, ownerUserId: '', file })
  check('空 owner 但 user 在信任集 → 放行', d3.allowed)
}

// 5) setTrustMode / listTrusted 顺序
{
  console.log('setTrustMode / listTrusted')
  let file = { mode: 'owner-only', trusted: {} }
  file = setTrustMode(file, 'manual')
  check('切换模式', file.mode === 'manual')

  const a = addTrusted(file, 'wxid_a', 'owner')
  const b = addTrusted(a, 'wxid_b', 'owner')
  // 强制 b 活跃时间更新
  b.trusted.wxid_b.lastSeenAt = Date.now() + 1000
  b.trusted.wxid_a.lastSeenAt = Date.now() - 1000
  const view = listTrusted(b)
  check('listTrusted 按 lastSeenAt 倒序', view[0].userId === 'wxid_b' && view[1].userId === 'wxid_a')
}

// 6) isPlausibleUserId
{
  console.log('isPlausibleUserId')
  check('合法 userId', isPlausibleUserId('wxid_abc123'))
  check('合法（@）', isPlausibleUserId('user@example'))
  check('拒绝太短', !isPlausibleUserId('abc'))
  check('拒绝太长', !isPlausibleUserId('a'.repeat(65)))
  check('拒绝含空格', !isPlausibleUserId('wxid abc'))
  check('拒绝含 /', !isPlausibleUserId('wxid/abc'))
}

console.log('')
console.log(`通过：${pass} · 失败：${fail}`)
process.exit(fail === 0 ? 0 : 1)
