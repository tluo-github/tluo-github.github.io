---
title: "Hello, blog"
description: "The first post: why I started this blog and how it is built."
pubDate: 2026-11-24
tags: ["Notes"]
---

The blog is open.

## Why a blog

I have fallen into plenty of pits while building things, and picked up a few ideas I think are worth keeping. Rather than leaving them scattered across notes, I'd like to turn them into posts: it helps me think more clearly, and it might help someone who runs into the same problem.

## How this blog is built

- Framework: [Astro](https://astro.build); every post is a Markdown file
- Hosting: GitHub Pages, at `tluo-github.github.io`
- Deployment: pushing to the `main` branch triggers GitHub Actions to build and publish

Writing a new post just means adding a `.md` file under `src/content/blog/` (English translations live in `src/content/blog-en/`):

```markdown
---
title: Post title
description: A one-line summary
pubDate: 2026-11-24
tags: [Java, Dubbo]
---

Body…
```

> Moderate in eating, careful in speech.

From here on I'll write about two things: building products with AI, and the pitfalls I ran into over 8 years of hands-on Java, Kubernetes and SRE work.
