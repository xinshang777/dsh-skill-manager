/* dsh-skill-manager —— 浏览器半边
 * 在「设置」里注册一个「技能管理」分区：列出你自己的技能（项目 / 用户目录、手动登记的，
 * 不含 dsh 自带的），用开关控制某个技能是否出现在对话的 / 菜单（关掉 = 挂一个同名影子，
 * 不改磁盘文件），并可就地编辑某个技能的 name / description（这一项会写回它的 SKILL.md）。
 * 只通过同源 fetch 调 host 半边注册的 /dsh-skill-manager/* 路由；除了 dsh 自带的 Modal
 * 组件（弹层的遮罩 / 层级 / Esc 行为跟产品一致），不 import 任何 dsh 内部包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // 用 dsh 自己的 Modal（不是自造弹层）：遮罩、圆角、层级、关闭按钮、Esc 行为都跟产品一致
    const { Modal } = require('@deepseek-ai/dsh-client-ui-primitives')

    const API = '/dsh-skill-manager'

    // apply 里赋上，供组件取 uiWorkspace —— dsh 自带的系统目录选择器就在它上面
    // （native 后端才会开系统对话框；browse 后端是站内浏览，本插件不掺和）。
    let hostCtx = null

    const CSS = `
.dsm-section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}
.dsm-card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);min-width:0;overflow:visible}
.dsm-cardhead{padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l4);display:flex;flex-direction:column;gap:2px}
.dsm-title{font-size:13px;line-height:20px;font-weight:500}
.dsm-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsm-rows{display:flex;flex-direction:column}
.dsm-row{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l4)}
.dsm-row:last-child{border-bottom:0}
.dsm-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsm-nameline{display:flex;align-items:center;gap:6px;min-width:0}
.dsm-name{font-size:13px;line-height:20px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-tag{flex:0 0 auto;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:0 6px}
.dsm-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-meta-bad{color:var(--dsw-alias-state-error-primary)}
.dsm-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
.dsm-switch[aria-checked='true']{background:var(--dsw-alias-state-business-primary)}
.dsm-switch:disabled{cursor:default;opacity:.5}
.dsm-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsm-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.dsm-switch[aria-checked='true'] .dsm-thumb{transform:translateX(16px)}
.dsm-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.dsm-btn{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;background:0 0;padding:4px 10px;transition:background-color 120ms ease,border-color 120ms ease,opacity 120ms ease}
.dsm-btn:hover:not(:disabled):not(.dsm-btn-primary):not(.dsm-btn-danger){background:var(--dsw-alias-interactive-bg-hover)}
.dsm-btn:disabled{cursor:not-allowed;opacity:.5}
/* 点不了但不装死：悬停时轻微提亮，文字反而更清楚 */
.dsm-btn:disabled:hover{opacity:.62}
.dsm-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsm-btn-primary{--dsm-fill:var(--dsw-alias-state-business-primary);background:var(--dsm-fill);border-color:var(--dsm-fill);color:var(--dsw-alias-label-primary-foreground)}
/* 实心按钮的悬停只能用同色加深：--dsw-alias-interactive-bg-hover 是 6% 透明叠层，
   拿它当填充色会把蓝底抹掉，白字就压不住了 */
.dsm-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsm-fill) 86%,#000);border-color:color-mix(in srgb,var(--dsm-fill) 86%,#000)}
.dsm-btn-primary:active:not(:disabled){background:color-mix(in srgb,var(--dsm-fill) 74%,#000);border-color:color-mix(in srgb,var(--dsm-fill) 74%,#000)}
.dsm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsm-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dsm-add{display:flex;gap:8px;align-items:center;padding:12px 16px 10px}
.dsm-input{flex:1;min-width:0;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);height:36px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;padding:0 12px}
.dsm-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsm-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsm-edit{display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l4)}
.dsm-edit:last-child{border-bottom:0}
.dsm-editrow{display:flex;align-items:center;gap:8px;min-width:0}
.dsm-editlabel{flex:0 0 40px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsm-edithint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-empty{padding:22px 16px;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsm-msg{padding:0 16px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-all}
.dsm-browse{position:relative;flex:0 0 auto}
.dsm-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;display:flex;flex-direction:column;min-width:132px;padding:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);box-shadow:0 6px 20px rgba(0,0,0,.16)}
.dsm-menuitem{border:0;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;padding:6px 10px;cursor:pointer}
.dsm-menuitem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-menuitem:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.dsm-form{display:flex;flex-direction:column;gap:14px}
.dsm-field{display:flex;flex-direction:column;gap:6px}
.dsm-field-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsm-field .dsm-input{width:100%;flex:none}
.dsm-dlg-note{margin-top:12px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dsm-dlg-error{margin-top:12px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary);word-break:break-all}
.dsm-picked{padding:0 16px 12px;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-skill-manager"]')) return
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', 'dsh-skill-manager')
      tag.setAttribute('data-plugin-css', 'dsh-skill-manager')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    ensureStyle()

    function messageOf(err) {
      return String((err && err.message) || err)
    }

    function request(route, body) {
      const init = { cache: 'no-store', credentials: 'same-origin' }
      if (body !== undefined) {
        init.method = 'POST'
        init.headers = { 'Content-Type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      return fetch(API + route, init).then(function (res) {
        return res
          .json()
          .catch(function () {
            return null
          })
          .then(function (data) {
            if (!res.ok || !data || data.ok !== true) {
              throw new Error(data && data.error ? data.error : '请求失败（HTTP ' + res.status + '）')
            }
            return data
          })
      })
    }

    // 与宿主 dsh-client-ui-primitives 的 Switch 同构：role=switch + aria-checked，
    // 外观由 aria-checked 驱动，视觉状态不会和辅助技术读到的不一致。
    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked,
          'aria-label': props.label,
          title: props.title,
          disabled: props.disabled === true,
          className: 'dsm-switch',
          onClick: function () {
            if (props.disabled === true) return
            props.onChange(!props.checked)
          },
        },
        h('span', { className: 'dsm-thumb' }),
      )
    }

    function SkillManagerSection() {
      const [skills, setSkills] = React.useState(null)
      const [target, setTarget] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [confirmSlug, setConfirmSlug] = React.useState('')
      const [draft, setDraft] = React.useState(null)
      const [menuOpen, setMenuOpen] = React.useState(false)
      // 「添加」确认框：名称 / 简介预填 SKILL.md 里的现值，用户改过的才写回去
      const [dialogOpen, setDialogOpen] = React.useState(false)
      const [name, setName] = React.useState('')
      const [description, setDescription] = React.useState('')
      const [touched, setTouched] = React.useState({ name: false, description: false })
      const [hint, setHint] = React.useState('')
      const menuRef = React.useRef(null)
      // 上一次认出来的入口文件，避免 settle 之后又被自动重认一遍
      const resolvedRef = React.useRef('')

      const reload = React.useCallback(function () {
        return request('/list')
          .then(function (data) {
            setSkills(Array.isArray(data.skills) ? data.skills : [])
            setError(data.startupError || '')
          })
          .catch(function (err) {
            setSkills([])
            setError(messageOf(err))
          })
      }, [])

      React.useEffect(function () {
        reload()
      }, [reload])

      function run(key, promise) {
        setBusy(key)
        setConfirmSlug('')
        return promise
          .then(function () {
            setError('')
            return reload()
          })
          .catch(function (err) {
            // 先刷列表再落错误：reload 里的 setError(startupError) 会把刚拿到的错误冲掉
            return reload().then(function () {
              setError(messageOf(err))
            })
          })
          .then(function () {
            setBusy('')
          })
      }

      function closeDialog() {
        if (busy === 'add') return
        setDialogOpen(false)
      }

      // 打开确认框前先清掉上一次的错误，免得把无关的红字带进来
      function openAddDialog() {
        if (busy || target.trim() === '') return
        setError('')
        setDialogOpen(true)
      }

      function resetForm() {
        resolvedRef.current = ''
        setTarget('')
        setName('')
        setDescription('')
        setTouched({ name: false, description: false })
        setHint('')
      }

      function submitAdd() {
        if (busy) return
        const value = target.trim()
        if (!value) return
        const payload = { target: value }
        // 只把用户真正动过的字段发回去；没动就完全不用重写 SKILL.md
        if (touched.name) payload.name = name.trim()
        if (touched.description) payload.description = description.trim()
        // 成功才收摊：失败（重名、名称不合法）时输入留着让人改
        const done = function () {
          setDialogOpen(false)
          resetForm()
        }
        run('add', request('/add', payload).then(done))
      }

      // 把宿主校验过的路径填进输入框，并用文件里的现有值当默认值；识别不出来就报错，输入框保持原样
      function settle(path) {
        return request('/inspect', { path: path }).then(function (data) {
          resolvedRef.current = data.file
          setTarget(data.file)
          setName(data.displayName)
          setDescription(data.description)
          setTouched({ name: false, description: false })
          setHint(data.note)
          setConfirmSlug('')
        })
      }

      // 路径变了就去认一下，好让确认框里拿到默认值（用户已经在改名称时就不打扰了）
      React.useEffect(
        function () {
          const value = target.trim()
          if (!value || busy || touched.name || touched.description || value === resolvedRef.current) return undefined
          const timer = setTimeout(function () {
            request('/inspect', { path: value })
              .then(function (data) {
                resolvedRef.current = data.file
                setTarget(data.file)
                setName(data.displayName)
                setDescription(data.description)
                setHint(data.note)
                setConfirmSlug('')
              })
              .catch(function () {})
          }, 400)
          return function () {
            clearTimeout(timer)
          }
        },
        [target, busy, touched],
      )

      function pickFile() {
        setMenuOpen(false)
        setBusy('pick')
        setHint('')
        setError('')
        request('/pick-file', {})
          .then(function (data) {
            // 取消不算错误：什么都不动
            if (data.cancelled === true) return null
            return settle(data.path)
          })
          .catch(function (err) {
            setError(messageOf(err))
          })
          .then(function () {
            setBusy('')
          })
      }

      function pickFolder() {
        setMenuOpen(false)
        const workspace = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('uiWorkspace') : null
        if (!workspace || typeof workspace.pickDirectory !== 'function') {
          setError('当前环境没有可用的系统目录选择器，请直接把路径粘贴到输入框')
          return
        }
        setBusy('pick')
        setHint('')
        setError('')
        workspace
          .pickDirectory()
          .then(function (dir) {
            if (dir === null || dir === undefined) return null
            return settle(dir)
          })
          .catch(function (err) {
            setError(messageOf(err))
          })
          .then(function () {
            setBusy('')
          })
      }

      // 菜单点外面或按 Esc 就收起来
      React.useEffect(function () {
        if (!menuOpen) return undefined
        function onPointerDown(event) {
          if (menuRef.current && menuRef.current.contains(event.target)) return
          setMenuOpen(false)
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') setMenuOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [menuOpen])

      function onToggle(skill) {
        if (busy) return
        run(skill.slug, request('/toggle', { slug: skill.slug, enabled: skill.enabled !== true }))
      }

      function onDelete(skill) {
        if (busy) return
        if (confirmSlug !== skill.slug) {
          setConfirmSlug(skill.slug)
          return
        }
        run(skill.slug, request('/delete', { slug: skill.slug }))
      }

      function startEdit(skill) {
        if (busy) return
        setError('')
        setDraft({ slug: skill.slug, name: skill.slug, description: skill.description || '' })
      }

      function onSave(skill) {
        if (busy || draft === null) return
        const name = draft.name.trim()
        const description = draft.description.trim()
        if (!name || !description) {
          setError('名称和简要介绍都不能为空')
          return
        }
        setBusy(skill.slug)
        request('/update', { slug: skill.slug, name: name, description: description })
          .then(function () {
            setError('')
            setDraft(null)
          })
          .catch(function (err) {
            setError(messageOf(err))
          })
          .then(function () {
            setBusy('')
            return reload()
          })
      }

      function editRow(skill) {
        const patch = function (field) {
          return function (event) {
            const next = { slug: draft.slug, name: draft.name, description: draft.description }
            next[field] = event.target.value
            setDraft(next)
          }
        }
        const keys = function (event) {
          if (event.key === 'Enter') onSave(skill)
          if (event.key === 'Escape') setDraft(null)
        }
        return h(
          'div',
          { className: 'dsm-edit', key: skill.slug },
          h(
            'div',
            { className: 'dsm-editrow' },
            h('span', { className: 'dsm-editlabel' }, '名称'),
            h('input', {
              className: 'dsm-input',
              type: 'text',
              value: draft.name,
              placeholder: '小写字母、数字和连字符',
              spellCheck: false,
              onChange: patch('name'),
              onKeyDown: keys,
            }),
          ),
          h(
            'div',
            { className: 'dsm-editrow' },
            h('span', { className: 'dsm-editlabel' }, '简介'),
            h('input', {
              className: 'dsm-input',
              type: 'text',
              value: draft.description,
              placeholder: '一句话说明这个技能做什么',
              spellCheck: false,
              onChange: patch('description'),
              onKeyDown: keys,
            }),
          ),
          h(
            'div',
            { className: 'dsm-editrow' },
            h('span', { className: 'dsm-editlabel' }, ''),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn dsm-btn-primary',
                disabled: busy !== '',
                onClick: function () {
                  onSave(skill)
                },
              },
              busy === skill.slug ? '保存中…' : '保存',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn',
                disabled: busy !== '',
                onClick: function () {
                  setDraft(null)
                },
              },
              '取消',
            ),
            h('span', { className: 'dsm-edithint', title: skill.target }, '写回 ' + skill.target),
          ),
        )
      }

      const rows = (skills || []).map(function (skill) {
        if (draft !== null && draft.slug === skill.slug) return editRow(skill)
        const name = skill.displayName || skill.slug
        const bad = !!skill.error
        const meta = skill.error
          ? skill.error
          : (skill.note ? skill.note + ' · ' : '') + (skill.description || skill.target || skill.slug)
        const tag = skill.sourceLabel
        return h(
          'div',
          { className: 'dsm-row', key: skill.slug },
          h(
            'div',
            { className: 'dsm-main' },
            h(
              'div',
              { className: 'dsm-nameline' },
              h('span', { className: 'dsm-name', title: skill.target || skill.slug }, name),
              tag ? h('span', { className: 'dsm-tag', title: skill.sourceLabel }, tag) : null,
            ),
            h('div', { className: 'dsm-meta' + (bad ? ' dsm-meta-bad' : ''), title: meta }, meta),
          ),
          h(
            'div',
            { className: 'dsm-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn',
                disabled: busy !== '' || skill.editable !== true,
                title: skill.editable === true
                  ? '编辑名称与简介，写回该技能的 SKILL.md'
                  : '这个技能由插件直接注册，没有可编辑的 SKILL.md',
                onClick: function () {
                  startEdit(skill)
                },
              },
              '编辑',
            ),
            skill.recorded
              ? h('button', {
                  type: 'button',
                  className: confirmSlug === skill.slug ? 'dsm-btn dsm-btn-danger' : 'dsm-btn',
                  disabled: busy !== '',
                  onClick: function () {
                    onDelete(skill)
                  },
                  onBlur: function () {
                    if (confirmSlug === skill.slug) setConfirmSlug('')
                  },
                }, confirmSlug === skill.slug
                  ? (skill.managed ? '确认删除' : '确认恢复')
                  : (skill.managed ? '删除' : '恢复默认'))
              : null,
            h(Switch, {
              checked: skill.enabled === true,
              disabled: busy !== '',
              label: (skill.enabled === true ? '隐藏「' : '显示「') + name + '」',
              title: skill.enabled === true ? '点击后从 / 菜单中隐藏' : '点击后重新出现在 / 菜单',
              onChange: function () {
                onToggle(skill)
              },
            }),
          ),
        )
      })

      let headHint = '关闭开关即让技能从 / 菜单和模型上下文中消失，不会改动磁盘文件。'
      if (skills !== null) {
        const hidden = skills.filter(function (skill) {
          return skill.enabled !== true
        }).length
        headHint = '共 ' + skills.length + ' 个技能' + (hidden > 0 ? '，已隐藏 ' + hidden + ' 个' : '') + '。' + headHint
      }

      let body
      if (skills === null) {
        body = h('div', { className: 'dsm-empty' }, '加载中…')
      } else if (rows.length === 0) {
        body = h('div', { className: 'dsm-empty' }, '还没有发现任何技能。')
      } else {
        body = h('div', { className: 'dsm-rows' }, rows)
      }

      const confirmLabel = busy === 'add' ? '添加中…' : '确认'

      const dialogBody = h(
        'div',
        { className: 'dsm-form' },
        h(
          'label',
          { className: 'dsm-field' },
          h('span', { className: 'dsm-field-label' }, '技能名称'),
          h('input', {
            className: 'dsm-input',
            type: 'text',
            value: name,
            placeholder: 'my-skill',
            spellCheck: false,
            'data-modal-autofocus': true,
            onChange: function (event) {
              setName(event.target.value)
              setTouched(function (prev) {
                return { name: true, description: prev.description }
              })
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') submitAdd()
            },
          }),
        ),
        h(
          'label',
          { className: 'dsm-field' },
          h('span', { className: 'dsm-field-label' }, '简要介绍'),
          h('input', {
            className: 'dsm-input',
            type: 'text',
            value: description,
            placeholder: '一句话说明这个技能干什么',
            spellCheck: false,
            onChange: function (event) {
              setDescription(event.target.value)
              setTouched(function (prev) {
                return { name: prev.name, description: true }
              })
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') submitAdd()
            },
          }),
        ),
        hint ? h('div', { className: 'dsm-dlg-note' }, hint) : null,
        error ? h('div', { className: 'dsm-dlg-error' }, error) : null,
      )

      const dialog = dialogOpen
        ? h(
            Modal,
            {
              open: true,
              onClose: closeDialog,
              title: '添加技能',
              closeLabel: '关闭',
              description: '路径：' + target.trim(),
              footer: h(
                React.Fragment,
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-btn',
                    disabled: busy === 'add',
                    onClick: closeDialog,
                  },
                  '取消',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-btn dsm-btn-primary',
                    disabled: busy !== '',
                    onClick: submitAdd,
                  },
                  confirmLabel,
                ),
              ),
            },
            dialogBody,
          )
        : null

      return h(
        'div',
        { className: 'dsm-section' },
        h(
          'div',
          { className: 'dsm-card' },
          h(
            'div',
            { className: 'dsm-cardhead' },
            h('div', { className: 'dsm-title' }, '技能管理'),
            h('div', { className: 'dsm-hint' }, headHint),
          ),
          h(
            'div',
            { className: 'dsm-add' },
            h('input', {
              className: 'dsm-input',
              type: 'text',
              value: target,
              placeholder: '技能目录 / SKILL.md 路径',
              spellCheck: false,
              onChange: function (event) {
                // 换路径 = 换技能：清掉上一次的提示和「已改过」标记，重新取默认值
                setTarget(event.target.value)
                setHint('')
                setTouched({ name: false, description: false })
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') openAddDialog()
              },
            }),
            h(
              'div',
              { className: 'dsm-browse', ref: menuRef },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsm-btn',
                  disabled: busy !== '',
                  'aria-haspopup': 'menu',
                  'aria-expanded': menuOpen,
                  onClick: function () {
                    setMenuOpen(!menuOpen)
                  },
                },
                busy === 'pick' ? '选择中…' : '浏览',
              ),
              menuOpen
                ? h(
                    'div',
                    { className: 'dsm-menu', role: 'menu' },
                    h(
                      'button',
                      { type: 'button', role: 'menuitem', className: 'dsm-menuitem', onClick: pickFile },
                      '选择文件…',
                    ),
                    h(
                      'button',
                      { type: 'button', role: 'menuitem', className: 'dsm-menuitem', onClick: pickFolder },
                      '选择文件夹…',
                    ),
                  )
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn dsm-btn-primary',
                disabled: busy !== '' || target.trim() === '',
                onClick: openAddDialog,
              },
              busy === 'add' ? '添加中…' : '添加',
            ),
          ),
          hint ? h('div', { className: 'dsm-picked' }, hint) : null,
          error && !dialogOpen ? h('div', { className: 'dsm-msg' }, error) : null,
          body,
        ),
        dialog,
      )
    }

    return {
      name: 'dsh-skill-manager',
      inject: ['slots'],
      apply(ctx) {
        hostCtx = ctx
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'skill-manager',
              order: 50,
              label: function () {
                return '技能管理'
              },
            },
            SkillManagerSection,
          )
        })
      },
    }
  },
})
