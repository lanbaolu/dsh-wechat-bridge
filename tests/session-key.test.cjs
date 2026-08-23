#!/usr/bin/env node
/**
 * 多用户支持 P1-2 / M2 session key 单测。
 *
 * 跑法：先 `bash scripts/build.sh`，再 `node tests/session-key.test.cjs`。
 * 覆盖：makeSessionKey / makeSessionFileStem / parseSessionKey / migrateLegacySessionKey
 * 的文件名安全化与旧 key 迁移。
 */
'use strict'

// 测试卫生：隔离数据目录，防止模块副作用污染真实 ~/.dsh/wechat-bridge。
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sessionkey-test-'))
process.env.DSH_BRIDGE_DATA_DIR = tmpDataDir

const { makeSessionKey, makeSessionFileStem, parseSessionKey, migrateLegacySessionKey } =
  require(path.join(__dirname, '..', 'lib', 'bridge', 'session-key.js'))

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

const BOT = '600db998f90c@im.bot'
const OWNER = 'wxid_owner_001'
const USER2 = 'wxid_stranger_007'

// 1) key 构造
{
  console.log('key 构造')
  const key = makeSessionKey(BOT, OWNER)
  check('格式 ${bot}::${user}', key === `${BOT}::${OWNER}`, key)
  check('文件名 stem 用 __ 替换 ::', makeSessionFileStem(BOT, OWNER) === `${BOT}__${OWNER}`)
  check('非法 userId（含 /）拒绝', (() => { try { makeSessionKey(BOT, 'wxid/abc'); return false } catch { return true } })())
  check('空 userId 拒绝', (() => { try { makeSessionKey(BOT, ''); return false } catch { return true } })())
}

// 2) 解析
{
  console.log('解析')
  const parsed = parseSessionKey(`${BOT}::${USER2}`)
  check('正常 key 解析', parsed && parsed.botAccountId === BOT && parsed.userId === USER2)
  const legacy = parseSessionKey(BOT)
  check('旧单段 key 解析（userId 空）', legacy && legacy.botAccountId === BOT && legacy.userId === '')
  check('空 key 返回 null', parseSessionKey('') === null)
}

// 3) 迁移
{
  console.log('迁移')
  const oldPath = `/data/sessions/${BOT}.json`
  const migrated = migrateLegacySessionKey(oldPath, BOT, OWNER)
  check('迁移出新路径', migrated && migrated.newPath === `/data/sessions/${BOT}__${OWNER}.json`, migrated)
  check('迁移出新 key', migrated && migrated.newKey === `${BOT}::${OWNER}`)
  check('owner 为空不迁移', migrateLegacySessionKey(oldPath, BOT, '') === null)
  check('非法 owner 不迁移', migrateLegacySessionKey(oldPath, BOT, 'bad/path') === null)
}

// 4) 与 session store 联动：新 key 文件名 = 迁移目标
{
  console.log('联动一致性')
  const key = makeSessionKey(BOT, OWNER)
  const stem = makeSessionFileStem(BOT, OWNER)
  const migrated = migrateLegacySessionKey(`/x/${BOT}.json`, BOT, OWNER)
  check('store 文件名与迁移目标一致', migrated.newPath.endsWith(`${stem}.json`), migrated?.newPath)
}

console.log('')
console.log(`通过：${pass} · 失败：${fail}`)
process.exit(fail === 0 ? 0 : 1)
