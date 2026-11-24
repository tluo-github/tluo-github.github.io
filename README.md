# Bruce 的博客

https://tluo-github.github.io ，用 [Astro](https://astro.build) 搭建，部署在 GitHub Pages。

## 写文章

在 `src/content/blog/` 里新建一个 `.md` 文件，文件名就是网址（如 `my-post.md` → `/blog/my-post/`）：

```markdown
---
title: 文章标题
description: 一句话简介（可选）
pubDate: 2026-11-24
tags: [Java, Dubbo]   # 可选
draft: true           # 可选，草稿只在本地预览显示，不会发布
---

正文……
```

图片放到 `public/images/` 下，文中用 `![说明](/images/xxx.png)` 引用。

## 英文版

网站是中英双语：中文在 `/`，英文在 `/en/`，导航栏右上角可以切换。

- 英文译文放在 `src/content/blog-en/`，**文件名和中文版相同**，两边就会自动互相关联。
- 没有英文版的中文文章，会出现在英文站的文章列表里，并标注 “Chinese”。
- 英文标签要用英文写（如 `Scheduling`、`Networking`）。
- 首页、关于页、项目页等界面文字：`src/i18n.ts`（界面文案）、`src/consts.ts`（站点信息、项目介绍）、`src/views/About.astro`（关于页）。

## 本地预览

```sh
npm install      # 第一次
npm run dev      # 打开 http://localhost:4321
```

## 发布

推送到 `main` 分支，GitHub Actions 会自动构建并发布，一两分钟后生效。

## 改站点信息

- 标题、简介、项目列表：`src/consts.ts`
- 界面文案（中英）：`src/i18n.ts`
- 首页、文章列表、关于、项目等页面：`src/views/`（`src/pages/` 下只是路由）
- 样式：`src/styles/global.css`
