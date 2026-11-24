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

## 本地预览

```sh
npm install      # 第一次
npm run dev      # 打开 http://localhost:4321
```

## 发布

推送到 `main` 分支，GitHub Actions 会自动构建并发布，一两分钟后生效。

## 改站点信息

- 标题、简介、项目列表：`src/consts.ts`
- 首页：`src/pages/index.astro`
- 关于页：`src/pages/about.astro`
- 样式：`src/styles/global.css`
