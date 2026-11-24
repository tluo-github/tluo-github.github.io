---
title: 你好，博客
description: 第一篇文章，聊聊为什么开这个博客，以及它是怎么搭起来的。
pubDate: 2026-11-24
tags: [随笔]
---

博客开张了。

## 为什么写博客

做项目的过程中踩过很多坑，也有一些自己觉得不错的想法。与其散落在笔记里，不如整理成文章，一来帮自己理清思路，二来也许能帮到遇到同样问题的人。

## 这个博客怎么搭的

- 框架：[Astro](https://astro.build)，文章就是 Markdown 文件
- 托管：GitHub Pages，域名是 `tluo-github.github.io`
- 部署：推送到 `main` 分支后，GitHub Actions 自动构建发布

写一篇新文章只需要在 `src/content/blog/` 里加一个 `.md` 文件：

```markdown
---
title: 文章标题
description: 一句话简介
pubDate: 2026-11-24
tags: [Java, Dubbo]
---

正文……
```

> 节饮食，慎言语。

以后会在这里写两类东西：一是用 AI 做产品的过程和心得，二是过去 8 年在 Java、Kubernetes、SRE 一线踩过的坑。
