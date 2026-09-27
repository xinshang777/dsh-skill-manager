import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  inspect,
  isValidSlug,
  locateSkill,
  readState,
  skillContent,
  updateSkillMeta,
  writeState,
} from './store.js'

const API = '/dsh-skill-manager'
const LIST_PATH = `${API}/list`
const ADD_PATH = `${API}/add`
const TOGGLE_PATH = `${API}/toggle`
const UPDATE_PATH = `${API}/update`
const DELETE_PATH = `${API}/delete`
const INSPECT_PATH = `${API}/inspect`
const PICK_FILE_PATH = `${API}/pick-file`

/** 技能简要介绍的长度上限（frontmatter 里是单行） */
const MAX_DESCRIPTION = 500

/** 本插件注册的运行时技能带的 source 值，用来和 dsh 自己扫描到的技能区分 */
const PLUGIN_SOURCE = 'skill-manager'

/** 宿主自身那一层注册表的 target id */
const HOST_TARGET = 'host'

const SOURCE_LABELS = {
  'project-dsh': '项目 .dsh/skills',
  'project-agents': '项目 .agents/skills',
  custom: '自定义目录',
  'user-dsh': '~/.dsh/skills',
  'user-agents': '~/.agents/skills',
  bundled: '内置技能',
  [PLUGIN_SOURCE]: '手动登记',
  runtime: '插件注册',
}

/** 落在 node_modules 里的技能目录 = 由某个包分发出来的 */
const PACKAGE_PATH_RE = /[\\/]node_modules[\\/]/

/**
 * 这个页面只管用户自己的技能，dsh 自带的不列出来。
 *
 * 「自带」有两类：内置技能根（source 为 bundled），以及随安装包分发的 ——
 * 比如 @deepseek-ai/dsh-agent-preset 的 skills 目录，它由 web-app 的 cordis 预设
 * 通过 customSkillDirs 注册，source 会是 custom，只能靠路径认出来。
 */
function isShippedSkill(entry) {
  if (String(entry.source || '') === 'bundled') return true
  return PACKAGE_PATH_RE.test(String(entry.path || ''))
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

const BODY_LIMIT = 64 * 1024

function errorText(err) {
  return String((err && err.message) || err)
}

// —— 系统「选择文件」对话框（Windows）——

/*
 * 浏览器拿不到绝对路径（<input type="file"> 只给文件名，File System Access API 也一样），
 * 所以「选文件」只能由宿主开原生对话框。dsh 自带的目录选择器只管文件夹（IFileOpenDialog +
 * FOS_PICKFOLDERS），没有选文件的能力，这里就用 Windows PowerShell 的 OpenFileDialog。
 *
 * 宿主是后台起的进程，弹窗有可能落在别的窗口后面：先显示一个最小化的 TopMost 窗体当 owner，
 * 再以它为父窗口弹对话框，让它跟着拿到前台（dsh 的目录选择器也是等价做法）。
 * 脚本用 UTF-16LE + base64 传，绕开引号与中文在命令行上的编码问题。
 */
const PICK_FILE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.ShowInTaskbar = $false',
  '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
  '$owner.TopMost = $true',
  '$owner.Show()',
  '$owner.Activate()',
  '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
  "$dlg.Title = '选择技能文件（SKILL.md）'",
  "$dlg.Filter = 'Markdown (*.md)|*.md|所有文件 (*.*)|*.*'",
  '$dlg.CheckFileExists = $true',
  '$dlg.DereferenceLinks = $true',
  '$dlg.RestoreDirectory = $true',
  '$picked = $dlg.ShowDialog($owner)',
  'if ($picked -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }',
  '$owner.Dispose()',
].join('\r\n')

/** 同一时刻只允许一个选择窗口，避免连点开出一排对话框 */
let pickingFile = false

/**
 * 开系统文件对话框，等人选完。
 * @returns 选中的绝对路径；用户取消时为 null
 */
function pickFileWithSystemDialog() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PICK_FILE_SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true },
    )
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(err).toString('utf8').trim()
        reject(new Error(detail || `对话框进程退出码 ${code}`))
        return
      }
      const text = Buffer.concat(out).toString('utf8').trim()
      resolve(text === '' ? null : text)
    })
  })
}

// —— 回环/同源校验：这些都是有副作用的写接口，不能允许跨站页面或 DNS 重绑定触发 ——

function isLoopbackHostname(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function guard(req, res) {
  const headers = (req && req.headers) || {}
  const deny = (code) => {
    try {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
    } catch (err) {}
    return true
  }
  let hostUrl = null
  try {
    hostUrl = new URL('http://' + String(headers.host || ''))
  } catch (err) {
    return deny(403)
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return deny(403)
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return deny(403)
  const origin = headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    let originUrl = null
    try {
      originUrl = new URL(origin)
    } catch (err) {
      return deny(403)
    }
    if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return deny(403)
  }
  return false
}

function sendJson(res, code, payload) {
  res.writeHead(code, JSON_HEADERS)
  res.end(JSON.stringify(payload))
}

function ok(res, payload) {
  sendJson(res, 200, { ok: true, ...payload })
}

function fail(res, code, message) {
  sendJson(res, code, { ok: false, error: message })
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        try {
          req.destroy()
        } catch (err) {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export default {
  name: 'dsh-skill-manager',
  inject: ['webServer', 'skills'],
  apply(ctx) {
    const disposers = []
    // slug → Map<targetId, dispose>：本插件为了「隐藏」或「补一份」而注册的运行时技能。
    // 运行时技能的 disposer 归注册表自己的 fiber 管，不随本插件卸载自动回收，得自己记着。
    const shadows = new Map()
    // slug → 最近一次失败原因，供列表页展示
    const failures = new Map()
    // 作用域 key（对象身份）→ 稳定的 target id
    const scopeTargetIds = new WeakMap()
    let nextScopeTargetId = 1
    // 最近一次同步时见过的 target 集合，用来发现「新挂载出来的预设作用域」
    let syncedTargets = ''
    // 浏览器把 / 菜单的技能目录按会话缓存在页面里，只有收到 agent-preset/selected 才会失效。
    // 这个事件在 dsh 的转发白名单里（宿主 emit → 广播给所有连接的页面），所以存下会话 id，
    // 改完开关后逐个发一次，就能免掉「刷新页面」这一步。
    const sessionIds = new Set()
    disposers.push(
      ctx.on('api-session/added', (summary) => {
        const id = summary && typeof summary.sessionId === 'string' ? summary.sessionId : ''
        if (id) sessionIds.add(id)
      }),
      ctx.on('api-session/removed', (id) => {
        if (typeof id === 'string') sessionIds.delete(id)
      }),
    )

    function logWarn(message) {
      try {
        const logger = ctx.logger
        if (logger && typeof logger.warn === 'function') logger.warn(message)
        else console.warn(`[dsh-skill-manager] ${message}`)
      } catch (err) {}
    }

    function targetIdOf(key) {
      let id = scopeTargetIds.get(key)
      if (id === undefined) {
        id = 'scope-' + nextScopeTargetId
        nextScopeTargetId += 1
        scopeTargetIds.set(key, id)
      }
      return id
    }

    /**
     * 需要写影子的注册表。
     *
     * 技能不是只挂在宿主那一层：agent 预设各自把 skill provider 挂进自己的作用域层，
     * 而作用域层整体压过宿主层（同名技能近的层直接赢）。所以宿主注册表 + 每个预设
     * 作用域注册表都要写一遍，会话里才真的看不到。
     *
     * 预设作用域注册表从 `agentPresets.generations` 里拿：
     * generation.scope.ctx 是带作用域标记的上下文，它的 `skills` 就是那一层的注册表。
     */
    function targets() {
      const list = [{ id: HOST_TARGET, skills: ctx.skills }]
      try {
        const presets = ctx.get('agentPresets')
        const generations = presets && presets.generations
        if (!generations || typeof generations.entries !== 'function') return list
        for (const [key, generation] of generations) {
          const scopedCtx = generation && generation.scope ? generation.scope.ctx : null
          if (!scopedCtx) continue
          let skills = null
          try {
            skills = scopedCtx.get('skills')
          } catch (err) {
            skills = null
          }
          if (!skills || typeof skills.register !== 'function') continue
          list.push({ id: targetIdOf(key), key, skills })
        }
      } catch (err) {
        logWarn(`读取预设作用域失败：${errorText(err)}`)
      }
      return list
    }

    function safeDispose(dispose) {
      try {
        dispose()
      } catch (err) {}
    }

    /** 撤掉某个技能在本插件所有 target 上的干预 */
    function release(slug) {
      const held = shadows.get(slug)
      shadows.delete(slug)
      if (!held) return
      for (const dispose of held.values()) safeDispose(dispose)
    }

    function releaseAll() {
      for (const slug of [...shadows.keys()]) release(slug)
    }

    /**
     * 合并所有 target 的清单。
     * 同一个技能在多个作用域里出现时，描述/路径取后读到的那个，
     * 可见性按「任一层可见即可见」算 —— 只要有一处还露着，就算没藏住。
     */
    async function discover() {
      const merged = new Map()
      for (const target of targets()) {
        let entries
        try {
          entries = target.key === undefined ? await target.skills.list({}) : await target.skills.list({ scope: target.key })
        } catch (err) {
          logWarn(`读取技能清单失败（${target.id}）：${errorText(err)}`)
          continue
        }
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          const previous = merged.get(entry.name)
          if (previous === undefined) {
            merged.set(entry.name, entry)
            continue
          }
          merged.set(entry.name, {
            ...entry,
            invocation: {
              modelInvocable: previous.invocation.modelInvocable || entry.invocation.modelInvocable,
              userInvocable: previous.invocation.userInvocable || entry.invocation.userInvocable,
            },
          })
        }
      }
      return merged
    }

    function descriptionOf(record, entry) {
      const candidates = [
        entry && entry.description,
        record && record.description,
        record && record.displayName,
        record && record.slug,
      ]
      for (const value of candidates) {
        if (typeof value === 'string' && value.length > 0) return value
      }
      return 'skill'
    }

    /**
     * 让注册表与一条记录一致。
     * 「隐藏」= 在每个 target 上注册同名影子（invocation 全 false，rank 250 压过用户/内置根）；
     * 「补一份」= 技能不在扫描根里或本身只给模型用，只能自己注册一份完整的。
     * 一致时不留任何痕迹。
     */
    async function applyRecord(record) {
      release(record.slug)
      failures.delete(record.slug)
      const entry = (await discover()).get(record.slug) || null
      const natural = entry !== null && entry.invocation.userInvocable === true
      if (record.enabled === natural) return
      const held = new Map()
      shadows.set(record.slug, held)
      let info = null
      if (record.enabled) {
        const target = (record.managed && record.target) || (entry && entry.path) || record.target
        if (!target) {
          failures.set(record.slug, '这条记录没有技能文件路径，无法启用')
          return
        }
        try {
          info = inspect(target)
        } catch (err) {
          failures.set(record.slug, errorText(err))
          return
        }
      }
      for (const target of targets()) {
        try {
          const dispose = record.enabled
            ? target.skills.register({
                name: record.slug,
                description: info.description || descriptionOf(record, entry),
                source: PLUGIN_SOURCE,
                path: info.file,
                resourceBase: { kind: 'directory', path: info.dir },
                content: skillContent(info),
                invocation: { modelInvocable: true, userInvocable: true },
              })
            : target.skills.register({
                name: record.slug,
                description: descriptionOf(record, entry),
                source: PLUGIN_SOURCE,
                invocation: { modelInvocable: false, userInvocable: false },
              })
          held.set(target.id, dispose)
        } catch (err) {
          const message = errorText(err)
          failures.set(record.slug, message)
          logWarn(`技能「${record.slug}」在 ${target.id} 上注册失败：${message}`)
        }
      }
    }

    /**
     * 让页面里的 / 菜单立刻重新拉一次技能目录。
     * 客户端（dsh-client-ui-skill）只在收到这个事件时才丢掉按会话缓存的清单，
     * 而且它正是 dsh 允许宿主转发给浏览器的事件之一。对没有缓存的会话发也无害。
     */
    async function notifySkillCatalog() {
      const ids = new Set(sessionIds)
      try {
        const controller = ctx.get('sessionController')
        if (controller && typeof controller.list === 'function') {
          for (const summary of await controller.list()) {
            if (summary && typeof summary.sessionId === 'string') ids.add(summary.sessionId)
          }
        }
      } catch (err) {
        logWarn(`读取会话列表失败：${errorText(err)}`)
      }
      for (const id of ids) {
        try {
          ctx.emit('agent-preset/selected', id, '')
        } catch (err) {
          logWarn(`通知会话 ${id} 刷新技能目录失败：${errorText(err)}`)
        }
      }
    }

    /** 预设是启动之后才挂载的，target 集合变了就整体重来一遍 */
    async function ensureApplied() {
      const list = targets()
      const signature = list.map((target) => target.id).join(',')
      if (signature === syncedTargets) return
      syncedTargets = signature
      let state
      try {
        state = readState()
      } catch (err) {
        logWarn(`读取技能数据失败：${errorText(err)}`)
        return
      }
      for (const record of state.skills) {
        try {
          await applyRecord(record)
        } catch (err) {
          logWarn(`技能「${record.slug}」同步失败：${errorText(err)}`)
        }
      }
    }

    function rowOf(entry, record) {
      const invocation = entry && entry.invocation ? entry.invocation : null
      const effectiveUser = invocation ? invocation.userInvocable === true : false
      const effectiveModel = invocation ? invocation.modelInvocable === true : false
      const natural = invocation ? effectiveUser : false
      const enabled = record ? record.enabled === true : natural
      const slug = entry ? entry.name : record.slug
      const target = (record && record.target) || (entry && entry.path) || ''
      const source = (entry && entry.source) || ''
      let error = failures.get(slug) || ''
      if (!error && entry !== null && enabled !== effectiveUser) {
        error = enabled ? '未能启用：同名技能来自优先级更高的目录' : '未能隐藏：同名技能来自优先级更高的目录'
      }
      let exists = true
      if (target) {
        try {
          fs.statSync(target)
        } catch (err) {
          exists = false
        }
      }
      if (!error && !exists) error = '路径不存在，请检查后删除这条记录'
      let note = ''
      if (!error && record !== null && !enabled) note = '已隐藏'
      else if (!error && !effectiveUser && effectiveModel) note = '仅模型可调用'
      return {
        slug,
        displayName: (record && record.displayName) || slug,
        description: (entry && entry.description) || (record && record.description) || '',
        enabled,
        recorded: record !== null,
        managed: record !== null && record.managed === true,
        target,
        source,
        sourceLabel: SOURCE_LABELS[source] || source,
        editable: target !== '',
        error,
        note,
      }
    }

    async function buildRows() {
      await ensureApplied()
      const state = readState()
      const records = new Map(state.skills.map((record) => [record.slug, record]))
      const rows = []
      const seen = new Set()
      for (const [name, entry] of await discover()) {
        const record = records.get(name) || null
        // dsh 自带的技能不进列表；但已经有一条记录的（用户手动动过）要留着，否则没法删
        if (record === null && isShippedSkill(entry)) continue
        rows.push(rowOf(entry, record))
        seen.add(name)
      }
      for (const record of state.skills) {
        if (seen.has(record.slug)) continue
        rows.push(rowOf(null, record))
      }
      rows.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0))
      return rows
    }

    // 启动时先按当前作用域同步一遍；预设晚挂载的情况由 ensureApplied 兜住
    let startupError = ''
    const ready = (async () => {
      try {
        readState()
      } catch (err) {
        startupError = errorText(err)
        logWarn(`读取技能数据失败：${startupError}`)
        return
      }
      try {
        await ensureApplied()
      } catch (err) {
        startupError = errorText(err)
        logWarn(`启动同步失败：${startupError}`)
      }
    })()

    /**
     * 三个写接口共用的前半段：回环校验 → 只收 POST → 解析 JSON → 等启动同步完成 → 读数据文件。
     * 任何一步不通过就直接回包并返回 null，调用方只管后面的业务。
     */
    async function beginPost(req, res) {
      if (guard(req, res)) return null
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' })
        res.end('method not allowed')
        return null
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        fail(res, 400, errorText(err))
        return null
      }
      await ready
      try {
        return { body, state: readState() }
      } catch (err) {
        fail(res, 500, errorText(err))
        return null
      }
    }

    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: LIST_PATH,
        handler: async (req, res) => {
          if (guard(req, res)) return
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' })
            res.end('method not allowed')
            return
          }
          await ready
          try {
            ok(res, { startupError, skills: await buildRows() })
          } catch (err) {
            fail(res, 500, errorText(err))
          }
        },
      }),
    )

    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: ADD_PATH,
        handler: async (req, res) => {
          const input = await beginPost(req, res)
          if (input === null) return
          const { body, state } = input
          const target = typeof body.target === 'string' ? body.target.trim() : ''
          if (!target) return fail(res, 400, '请填写技能所在路径')
          // 页面上的名称 / 简介是带默认值的可编辑项：传了就写回 SKILL.md，没传就沿用文件里现有的
          const patch = {}
          if (body.name !== undefined) {
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            if (!name) return fail(res, 400, '技能名不能为空')
            if (!isValidSlug(name)) return fail(res, 400, '技能名只允许小写字母、数字和连字符')
            patch.name = name
          }
          if (body.description !== undefined) {
            const description = typeof body.description === 'string' ? body.description.trim() : ''
            if (!description) return fail(res, 400, '简要介绍不能为空')
            if (description.length > MAX_DESCRIPTION) {
              return fail(res, 400, `简要介绍不能超过 ${MAX_DESCRIPTION} 个字`)
            }
            patch.description = description
          }
          // 先确定写入后会叫什么名字，好在动 SKILL.md 之前就把重名挡掉
          let before = null
          if (patch.name === undefined) {
            try {
              before = inspect(target)
            } catch (err) {
              return fail(res, 400, errorText(err))
            }
          }
          const slug = patch.name === undefined ? before.slug : patch.name
          if (state.skills.some((record) => record.slug === slug)) {
            return fail(res, 409, `技能名「${slug}」已存在，换个目录名或改 SKILL.md 的 name`)
          }
          let info
          if (patch.name === undefined && patch.description === undefined) {
            info = before
          } else {
            try {
              info = updateSkillMeta(target, patch)
            } catch (err) {
              return fail(res, 400, errorText(err))
            }
          }
          const record = {
            slug: info.slug,
            enabled: true,
            managed: true,
            displayName: info.displayName,
            description: info.description,
            target: path.resolve(target),
            createdAt: new Date().toISOString(),
          }
          state.skills.push(record)
          try {
            writeState(state)
          } catch (err) {
            return fail(res, 500, errorText(err))
          }
          try {
            await applyRecord(record)
          } catch (err) {
            logWarn(`技能「${record.slug}」登记失败：${errorText(err)}`)
          }
          await notifySkillCatalog()
          ok(res, { slug: record.slug })
        },
      }),
    )

    /*
     * 「浏览」选完路径后的校验：把目录解析成里面的 SKILL.md，或者直接认这个 .md 文件，
     * 然后解析 frontmatter，让页面能立刻告诉用户「这是哪个技能」。
     * 只读，不写任何东西 —— 真正的登记仍然走 /add。
     */
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: INSPECT_PATH,
        handler: async (req, res) => {
          const input = await beginPost(req, res)
          if (input === null) return
          const raw = typeof input.body.path === 'string' ? input.body.path.trim() : ''
          if (!raw) return fail(res, 400, '没有拿到路径')
          const abs = path.resolve(raw)
          let stat
          try {
            stat = fs.statSync(abs)
          } catch (err) {
            return fail(res, 400, `路径不存在：${abs}`)
          }
          let file = abs
          if (stat.isDirectory()) {
            try {
              file = locateSkill(abs)
            } catch (err) {
              return fail(res, 400, errorText(err))
            }
          } else if (!stat.isFile()) {
            return fail(res, 400, `既不是文件也不是目录：${abs}`)
          } else if (!/\.(md|markdown)$/i.test(abs)) {
            return fail(res, 400, '请选择 Markdown 文件（技能的 SKILL.md）')
          }
          let info
          try {
            info = inspect(file)
          } catch (err) {
            return fail(res, 400, errorText(err))
          }
          // dsh 的原生扫描要求 frontmatter 同时有 name 和 description，缺一个整份文件被忽略。
          // 这两种情况值得提醒一句：添加时的确认框能直接补上。
          let note = ''
          if (!info.declaredName) note = 'frontmatter 里没有 name，技能名暂时取自目录名；dsh 的原生扫描会忽略它，可以在添加时填上名称，会写回 SKILL.md'
          else if (!info.description) note = 'frontmatter 里没有 description；dsh 的原生扫描会忽略它，可以在添加时填上简介，会写回 SKILL.md'
          ok(res, {
            file: info.file,
            dir: info.dir,
            slug: info.slug,
            displayName: info.displayName,
            description: info.description,
            note,
          })
        },
      }),
    )

    /* 开一次系统「选择文件」对话框。取消返回 cancelled，不当作错误。 */
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: PICK_FILE_PATH,
        handler: async (req, res) => {
          if (guard(req, res)) return
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' })
            res.end('method not allowed')
            return
          }
          if (process.platform !== 'win32') {
            return fail(res, 400, '系统文件对话框目前只有 Windows 可用，请直接把路径粘贴到输入框')
          }
          if (pickingFile) return fail(res, 409, '已经有一个选择窗口开着，先处理它')
          pickingFile = true
          try {
            const picked = await pickFileWithSystemDialog()
            ok(res, picked === null ? { cancelled: true } : { path: picked })
          } catch (err) {
            fail(res, 500, `打开系统对话框失败：${errorText(err)}`)
          } finally {
            pickingFile = false
          }
        },
      }),
    )

    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: TOGGLE_PATH,
        handler: async (req, res) => {
          const input = await beginPost(req, res)
          if (input === null) return
          const { body, state } = input
          const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
          const enabled = body.enabled === true
          if (!isValidSlug(slug)) return fail(res, 400, '技能名不合法')
          const existing = state.skills.find((record) => record.slug === slug) || null
          // 先把本插件的干预全撤掉，再看这个技能的自然状态
          release(slug)
          let entry
          try {
            entry = (await discover()).get(slug) || null
          } catch (err) {
            return fail(res, 500, errorText(err))
          }
          if (entry === null && existing === null) return fail(res, 404, `没有找到技能「${slug}」`)
          const natural = entry !== null && entry.invocation.userInvocable === true
          const record = {
            slug,
            enabled,
            managed: existing ? existing.managed === true : false,
            displayName: (existing && existing.displayName) || (entry ? entry.name : slug),
            description: (entry && entry.description) || (existing && existing.description) || '',
            target: (existing && existing.target) || (entry && entry.path) || '',
            createdAt: (existing && existing.createdAt) || new Date().toISOString(),
          }
          // 手动登记的技能删掉记录就再也找不回来了；只是「隐藏」用的记录，
          // 一旦回到自然状态就没有存在的意义，直接丢掉，别让数据文件长草。
          const keep = record.managed || enabled !== natural
          const skills = state.skills.filter((item) => item.slug !== slug)
          if (keep) skills.push(record)
          try {
            writeState({ version: 1, skills })
          } catch (err) {
            return fail(res, 500, errorText(err))
          }
          try {
            await applyRecord(record)
          } catch (err) {
            logWarn(`技能「${slug}」切换失败：${errorText(err)}`)
          }
          await notifySkillCatalog()
          ok(res, { slug })
        },
      }),
    )

    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: UPDATE_PATH,
        handler: async (req, res) => {
          const input = await beginPost(req, res)
          if (input === null) return
          const { body, state } = input
          const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
          if (!isValidSlug(slug)) return fail(res, 400, '技能名不合法')

          const known = await discover()
          const entry = known.get(slug) || null
          const record = state.skills.find((item) => item.slug === slug) || null
          if (entry === null && record === null) return fail(res, 404, `没有找到技能「${slug}」`)
          // 隐藏中的技能已经被 list() 过滤掉了，只能靠记录里的路径找回它的文件
          const file =
            (entry && typeof entry.path === 'string' ? entry.path : '') || (record && record.target) || ''
          if (!file) {
            return fail(res, 400, '这个技能由插件直接注册，没有可编辑的 SKILL.md')
          }

          const patch = {}
          if (body.name !== undefined) {
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            if (!isValidSlug(name)) return fail(res, 400, '技能名只允许小写字母、数字和连字符')
            if (name !== slug && (known.has(name) || state.skills.some((item) => item.slug === name))) {
              return fail(res, 409, `已经有叫「${name}」的技能了`)
            }
            patch.name = name
          }
          if (body.description !== undefined) {
            const description = typeof body.description === 'string' ? body.description.trim() : ''
            if (!description) return fail(res, 400, '简要介绍不能为空')
            if (description.length > MAX_DESCRIPTION) {
              return fail(res, 400, `简要介绍不能超过 ${MAX_DESCRIPTION} 个字`)
            }
            patch.description = description
          }
          if (patch.name === undefined && patch.description === undefined) {
            return fail(res, 400, '没有要修改的内容')
          }

          let updated
          try {
            updated = updateSkillMeta(file, patch)
          } catch (err) {
            return fail(res, 400, errorText(err))
          }

          // 改名会让记录里的 slug 失效，把记录迁到新名字上，隐藏状态跟着走
          if (record !== null && updated.slug !== slug) {
            const moved = { ...record, slug: updated.slug, displayName: '', description: '', target: updated.file }
            const skills = state.skills.map((item) => (item === record ? moved : item))
            try {
              writeState({ version: 1, skills })
            } catch (err) {
              return fail(res, 500, errorText(err))
            }
            release(slug)
            try {
              await applyRecord(moved)
            } catch (err) {
              logWarn(`技能「${moved.slug}」改名后同步失败：${errorText(err)}`)
            }
          }

          // 扫描器对文件变化有 200ms 的稳定性阈值，等它重扫完再让页面拉新清单
          await new Promise((resolve) => setTimeout(resolve, 300))
          await notifySkillCatalog()
          ok(res, { slug: updated.slug })
        },
      }),
    )

    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: DELETE_PATH,
        handler: async (req, res) => {
          const input = await beginPost(req, res)
          if (input === null) return
          const { body, state } = input
          const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
          if (!isValidSlug(slug)) return fail(res, 400, '技能名不合法')
          if (!state.skills.some((record) => record.slug === slug)) {
            return fail(res, 404, `没有找到技能「${slug}」`)
          }
          const skills = state.skills.filter((record) => record.slug !== slug)
          try {
            writeState({ version: 1, skills })
          } catch (err) {
            return fail(res, 500, errorText(err))
          }
          release(slug)
          failures.delete(slug)
          await notifySkillCatalog()
          ok(res, { slug })
        },
      }),
    )

    ctx.effect(() => () => {
      releaseAll()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (err) {}
      }
    })
  },
}
