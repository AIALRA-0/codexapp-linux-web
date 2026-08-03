# Codex 统一工作区

这个目录保存以后在服务器 CodexApp 中继续维护的项目。对话记录由 Codex 自己管理，项目源文件只放在这里，不混入 Codex 的内部数据目录。

## 1 文件结构

```text
workspace/
├── README.md
├── projects/
│   ├── audit-skill/
│   ├── expression-skill/
│   ├── career-coaching/
│   ├── usc-course/
│   ├── aialra-email/
│   ├── contabo-vps/
│   │   ├── adaptive-scheduler/
│   │   ├── guandan-lab/
│   │   └── chesskit/
│   ├── trillium-reader/
│   └── aialra-interview/
├── incoming/
├── shared/
└── archive/
```

`projects` 保存长期项目，每个项目拥有自己的 Git 仓库、说明和依赖文件

`incoming` 保存还没有归类的临时材料，完成归类后需要移入对应项目

`shared` 保存多个项目共同使用、且不含账号凭据的资料

`archive` 保存已经停止维护但暂时不能删除的项目快照

## 2 使用规则

第一步 新建对话前，先进入 `projects` 中对应的项目目录；没有目录时先建立项目目录和项目自己的 `README.md`

第二步 源代码、资料和 Git 历史保存在项目目录；`node_modules`、构建结果、测试缓存等可重建内容不作为迁移数据，使用项目锁文件重新安装

第三步 密钥、登录令牌和邮箱凭据只放在项目原有的私密目录或环境文件中，权限限制为项目运行账号可读，不提交到 Git，也不复制到 `shared`

第四步 一个对话只绑定一个主要项目目录；跨项目工作时，把共用结果落到 `shared`，不要把另一个项目整体复制进来

第五步 项目停用时移入 `archive`；确认不再需要并且已经备份后，再单独删除

## 3 迁移原则

旧对话的原始记录文件保持原样，服务器只更新对话对应的工作目录，因此历史内容和模型上下文不会被摘要替代

每条迁移记录必须同时通过文件校验值、对话编号、标题、工作目录、官方列表和只读恢复测试。验证时不启动新回合，不向原始对话追加测试消息
