# 名著学习工作台（MZlearn）

初中语文名著学习工具：8 部名著的结构化资料（章节目录 / 名句积累 / 读书方法 / 时间线 / 人物卡 / 鱼骨图 / 核心考点 / 掌握要求 / 随机测试）。学习进度与错题本保存在浏览器本地（localStorage），无后端、无账号。

纯静态站点，`index.html` 直接打开即可运行；线上部署为 GitHub Pages。

## 目录结构

```
index.html            首页（书库 + 搜索）
detail.html           书籍详情页（11 个 Tab）
settings.html         模型配置页（API Key / 默认模型 / 连接测试）
books/                8 本书的 markdown 资料 + manifest.json（书库索引）
assets/               样式、解析器、渲染、存储、UI 逻辑
assets/books.bundle.js  构建产物：books/*.md + manifest 的内联合并（页面加载用）
```

## 模型配置（settings.html）

首页顶栏「⚙ 模型配置」进入：粘贴 / 保存 / 清除 DeepSeek API Key（掩码显示、可显隐）、切换默认模型（Chat 快 / Reasoner 深度推理）、一键测试连接（GET api.deepseek.com/models 验活）。Key 只存本浏览器 localStorage；未配置时 AI 生成不可用，阅读 / 测试 / 错题本不受影响。

## AI 生成新书（可选功能）

首页「AI 生成新书」按钮调用 DeepSeek 生成结构化名著资料：

- **需要自己的 DeepSeek API Key**：到 platform.deepseek.com 申请充值，在弹窗里粘贴一次（仅存本浏览器 localStorage，不进仓库、不上传服务器）
- 没有 Key 时点击按钮会提示粘贴；「手动录入 JSON」路径不受影响
- 生成结果默认按草稿处理（skeleton），保存前需人工复核，不与完整书混淆

## 更新内容后重新发布

内容源在源码项目（`books/*.md` 是唯一可编辑源，本目录是发布产物）：

1. 改 `books/*.md` → 跑 `python3 tools/build_bundle.py` 重新生成内联产物
2. 跑测试：`node tools/test_offline.js`（应 231/0）与 `node tools/test_e2e_md.js`（应 30/0）
3. 公网构建：同步 `index.html`/`detail.html`/`settings.html`/`assets/`/`books/` 到本目录；`assets/config.js` 保持 `HXW_PUBLIC_CONFIG = {}`（公网不内置任何密钥）
4. 提交推送，GitHub Pages 约 1 分钟自动更新

## 线上地址

https://www.izq.cc
