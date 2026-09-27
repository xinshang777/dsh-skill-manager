import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 纯数据层：不依赖任何 @deepseek-ai/* 包，只用 node 内置模块，
// 这样 link: 安装的包（仓库根即插件包，从仓库目录起解析）也不需要 dsh 的 node_modules。

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** SKILL.md 正文超过这个长度就截断（字符数） */
const MAX_BODY = 32 * 1024

/** DSH 数据根目录：优先取环境变量，退回 ~/.dsh（与 dsh.ps1 shim 的推导一致） */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return path.resolve(env.trim())
  return path.join(os.homedir(), '.dsh')
}

const DATA_DIR = path.join(dshHome(), 'skill-manager')
export const DATA_FILE = path.join(DATA_DIR, 'skills.json')

/** 把任意文本规范成 kebab-case 技能名片段（可能返回空串） */
function normalizeSlug(input) {
  return String(input == null ? '' : input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 与 @deepseek-ai/dsh-skill 的 SKILL_NAME 同一语法 */
export function isValidSlug(name) {
  return SKILL_NAME_RE.test(String(name))
}

/**
 * 规范化一条记录；认不出来就返回 null（丢一行脏数据，而不是让整份文件失效）。
 * @param raw - 数据文件里的一条原始记录
 * @returns 规范后的记录，或 null
 */
function normalizeRecord(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : ''
  if (!isValidSlug(slug)) return null
  const record = {
    slug,
    enabled: raw.enabled !== false,
    // 早期版本只存过 /add 登记的技能，那时没有 managed 字段，缺省按手动登记处理
    managed: raw.managed !== false,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    target: typeof raw.target === 'string' ? raw.target : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  }
  return record
}

/**
 * 读取持久化状态。
 * 文件不存在视为空；文件存在但内容损坏则抛错（避免静默清空用户数据）。
 */
export function readState() {
  let text
  try {
    text = fs.readFileSync(DATA_FILE, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { version: 1, skills: [] }
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`技能数据文件不是合法 JSON：${DATA_FILE}`)
  }
  const skills = parsed && Array.isArray(parsed.skills)
    ? parsed.skills.map(normalizeRecord).filter((record) => record !== null)
    : []
  return { version: 1, skills }
}

/** 先写临时文件再 rename，避免写一半崩溃留下半个文件 */
export function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${DATA_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, skills: state.skills }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, DATA_FILE)
}

function unquote(value) {
  const s = String(value).trim()
  if (s.length >= 2) {
    const first = s[0]
    if (first === '"' && s.endsWith('"')) {
      return s
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
    }
    if (first === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'")
  }
  return s
}

/** 极简 YAML 子集：只认顶层 `key: value` 与块标量（`|` / `>`），更深的结构整体忽略（够 SKILL.md frontmatter 用） */
function parseSimpleYaml(block) {
  const out = {}
  const lines = String(block).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s/.test(line)) continue
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim()
    const scalar = /^([|>])[+-]?\d*$/.exec(value)
    if (!scalar) {
      if (value !== '') out[m[1]] = unquote(value)
      continue
    }
    // 块标量：紧跟其后的缩进行都是它的内容，`|` 保留换行，`>` 折成空格
    const folded = scalar[1] === '>'
    const body = []
    let indent = null
    while (i + 1 < lines.length) {
      const next = lines[i + 1]
      if (next.trim() === '') {
        body.push('')
        i += 1
        continue
      }
      const lead = next.length - next.replace(/^\s+/, '').length
      if (lead === 0) break
      if (indent === null) indent = lead
      if (lead < indent) break
      body.push(next.slice(indent))
      i += 1
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    out[m[1]] = folded ? body.join(' ').replace(/\s+/g, ' ').trim() : body.join('\n').trim()
  }
  return out
}

/** 拆出 frontmatter 与正文 */
function splitFrontmatter(text) {
  const src = String(text).replace(/^\uFEFF/, '')
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  if (!m) return { data: {}, body: src }
  return { data: parseSimpleYaml(m[1]), body: src.slice(m[0].length) }
}

/** 技能入口文件的候选文件名 */
const SKILL_FILENAMES = ['SKILL.md', 'skill.md', 'Skill.md']

/** 目标路径 → 技能入口文件；目录则找 SKILL.md */
function resolveSkillFile(target) {
  const abs = path.resolve(String(target))
  let st
  try {
    st = fs.statSync(abs)
  } catch (err) {
    throw new Error(`路径不存在：${abs}`)
  }
  if (st.isDirectory()) {
    for (const name of SKILL_FILENAMES) {
      const candidate = path.join(abs, name)
      if (fs.existsSync(candidate)) return { file: candidate, dir: abs, kind: 'directory' }
    }
    throw new Error(`目录里没有找到 SKILL.md：${abs}`)
  }
  if (!st.isFile()) throw new Error(`既不是文件也不是目录：${abs}`)
  return { file: abs, dir: path.dirname(abs), kind: 'file' }
}

/** 往下的搜索深度与扫描条目上限：选到一个大目录（比如整个 D 盘）时不能没完没了地翻 */
const LOCATE_MAX_DEPTH = 3
const LOCATE_MAX_SCAN = 2000
const LOCATE_SKIP_DIRS = new Set(['node_modules', '.git'])

/**
 * 在一个目录里定位 SKILL.md：先看这一层，找不到再往下翻。
 * 翻到多个不给猜 —— 猜错就是把用户登记到了另一个技能上。
 * @param dir - 用户选中的目录
 * @returns SKILL.md 的绝对路径
 */
export function locateSkill(dir) {
  const abs = path.resolve(String(dir))
  let rootStat
  try {
    rootStat = fs.statSync(abs)
  } catch (err) {
    throw new Error(`路径不存在：${abs}`)
  }
  if (!rootStat.isDirectory()) return abs
  for (const name of SKILL_FILENAMES) {
    const candidate = path.join(abs, name)
    if (fs.existsSync(candidate)) return candidate
  }
  const found = []
  let scanned = 0
  // 技能目录常常是软链接 / junction（dsh 里很常见），dirent 对它们报的是 symbolicLink
  // 而不是 directory，得跟一层真实类型，否则会把链接当成文件跳过。
  const isDir = (target) => {
    try {
      return fs.statSync(target).isDirectory()
    } catch (err) {
      return false
    }
  }
  const walk = (current, depth) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const entry of entries) {
      if (found.length > 1 || scanned > LOCATE_MAX_SCAN) return
      const full = path.join(current, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDir(full))) {
        if (depth < LOCATE_MAX_DEPTH && !LOCATE_SKIP_DIRS.has(entry.name)) walk(full, depth + 1)
        continue
      }
      scanned += 1
      if (entry.isSymbolicLink() && !fs.existsSync(full)) continue
      if (SKILL_FILENAMES.includes(entry.name)) found.push(full)
    }
  }
  walk(abs, 0)
  if (found.length === 0) {
    if (scanned > LOCATE_MAX_SCAN) {
      throw new Error(`目录太大，翻了 ${LOCATE_MAX_SCAN} 个文件也没找到 SKILL.md，请直接选到技能所在的那一层：${abs}`)
    }
    throw new Error(`该目录里没有 SKILL.md：${abs}`)
  }
  if (found.length > 1) {
    throw new Error(`这个目录里有多个 SKILL.md，请直接选中其中一个：\n${found.slice(0, 3).join('\n')}`)
  }
  return found[0]
}

/**
 * 读取并解析一个技能目标。
 * @returns {{file: string, dir: string, slug: string, displayName: string, description: string, declaredName: boolean, body: string}}
 */
export function inspect(target) {
  const { file, dir, kind } = resolveSkillFile(target)
  const { data, body } = splitFrontmatter(fs.readFileSync(file, 'utf8'))
  const base = kind === 'file' ? path.basename(file).replace(/\.(md|markdown)$/i, '') : path.basename(dir)
  const frontName = typeof data.name === 'string' ? data.name.trim() : ''
  const displayName = frontName || base
  const slug = normalizeSlug(displayName)
  if (!isValidSlug(slug)) {
    throw new Error(`无法从「${displayName}」得到合法技能名（只允许小写字母、数字和连字符）`)
  }
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  return { file, dir, slug, displayName, description, declaredName: frontName !== '', body }
}

/** 长得像 YAML 原生字面量的值必须加引号，否则会被解析成布尔/数字/空 */
const YAML_LITERAL_RE = /^(?:~|null|true|false|yes|no|on|off|[-+]?\d+(?:\.\d+)?)$/i

/** 渲染一个 YAML 标量：能安全裸写就裸写，否则用双引号包住（JSON 字符串是合法 YAML） */
function yamlScalar(value) {
  const text = String(value)
  const plain =
    text === text.trim() &&
    !/[\n\r\t"'#]/.test(text) &&
    !/: /.test(text) &&
    !/^[-?*&!|>%@`{[,]/.test(text) &&
    !YAML_LITERAL_RE.test(text)
  return plain ? text : JSON.stringify(text)
}

/**
 * 改掉 frontmatter 里某个顶层 key（没有就追加到末尾）。
 * 原来那行是块标量（`description: |-`）时，把下面的缩进内容一起换掉 ——
 * 只替第一行会把旧的多行内容留在原地，写出一份坏掉的 YAML。
 */
function setFrontmatterLine(lines, key, value) {
  const pattern = new RegExp('^' + key + '[ \\t]*:')
  const rendered = `${key}: ${yamlScalar(value)}`
  const index = lines.findIndex((line) => pattern.test(line))
  if (index === -1) {
    lines.push(rendered)
    return
  }
  const isBlockScalar = /^[|>][+-]?\d*$/.test(lines[index].replace(pattern, '').trim())
  lines[index] = rendered
  if (!isBlockScalar) return
  let end = index + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1
  lines.splice(index + 1, end - index - 1)
}

/**
 * 原地改写技能文件的 frontmatter：只动 name / description 两行，其他行（含缩进块）原样保留。
 * 链接技能拒绝改写，避免顺着 symlink 写到扫描根之外。
 * @param target - 技能目录或 SKILL.md 路径
 * @param patch - {{name?: string, description?: string}}，未给出的字段保持原样
 * @returns 改写后重新解析的结果（同 inspect 的返回）
 */
export function updateSkillMeta(target, patch) {
  const { file, dir } = resolveSkillFile(target)
  for (const candidate of [file, dir]) {
    if (fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`链接技能不能编辑：${candidate}`)
    }
  }
  const src = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const matched = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  const lines = matched ? matched[1].split(/\r?\n/) : []
  const body = (matched ? src.slice(matched[0].length) : src).replace(/^[\r\n]+/, '')
  if (patch.name !== undefined) setFrontmatterLine(lines, 'name', patch.name)
  if (patch.description !== undefined) setFrontmatterLine(lines, 'description', patch.description)
  const next = ['---', ...lines, '---', '', body].join(eol)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, next, 'utf8')
  fs.renameSync(tmp, file)
  return inspect(file)
}

/** 组装给模型的技能正文：先点明本地来源路径，再接 SKILL.md 正文 */
export function skillContent(inspected) {
  let body = String(inspected.body).replace(/^[\r\n]+/, '')
  let suffix = ''
  if (body.length > MAX_BODY) {
    body = body.slice(0, MAX_BODY)
    suffix = `\n\n（正文超过 ${MAX_BODY} 字符已截断，完整内容请读取：${inspected.file}）`
  }
  return `技能来源（本地）：${inspected.file}\n\n${body}${suffix}`
}
