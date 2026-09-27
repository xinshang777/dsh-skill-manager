# dsh-skill-manager

DSH Web 设置里的「技能管理」页：用本地路径登记技能、开关启用状态；启用的技能会出现在 `/` 菜单并注入模型上下文。

## 功能

- 列出当前所有技能（区分 host 层与 agent-preset 作用域层），DSH 自带技能默认隐藏
- 通过本地路径（目录或 SKILL.md）**登记**一个技能，自动写入 `~/.dsh/skill-manager/skills.json`
- **开关**某技能的「用户可调用」状态（隐藏 = 注册同名影子把 invocation 全置 false）
- **编辑**技能名 / 简介（写回 SKILL.md 的 frontmatter，链接技能拒绝改写）
- **删除**登记记录
- Windows 下支持系统「选择文件」对话框直接选 SKILL.md（其他平台粘贴路径即可）
- 改动后自动通知会话刷新 `/` 菜单技能目录，无需手动刷新

## 安装

```bash
dsh plugin --profile web add link:.
# 或
dsh plugin --profile web add github:xinshang777/dsh-skill-manager
```

安装后重启 `dsh web`，在设置里进入「技能管理」。

## 兼容性

- 需要 `webServer`、`skills` 服务；功能上还会用到 `agentPresets`、`sessionController`
- 「选择文件」系统对话框目前 **仅 Windows** 可用，其他平台请在输入框直接粘贴路径
- 零运行时依赖，数据存于 `~/.dsh/skill-manager/skills.json`

## 配置

无需配置。

## 本地开发

```bash
dsh plugin --profile web add link:.
```

## License

MIT
