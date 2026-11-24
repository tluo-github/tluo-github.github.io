export type Lang = 'zh' | 'en';
export const LANGS: Lang[] = ['zh', 'en'];

/** 给站内路径加语言前缀：中文在根目录，英文在 /en 下 */
export const url = (lang: Lang, path: string) => (lang === 'en' ? '/en' + path : path);

/** 从当前网址判断语言，并去掉语言前缀 */
export function parseUrl(pathname: string): { lang: Lang; path: string } {
	if (pathname === '/en' || pathname.startsWith('/en/')) return { lang: 'en', path: pathname.slice(3) || '/' };
	return { lang: 'zh', path: pathname };
}

export const UI = {
	zh: {
		htmlLang: 'zh-CN',
		posts: '文章',
		projects: '项目',
		about: '关于',
		switchTo: 'EN',
		switchLabel: 'Switch to English',
		hello: (name: string) => `你好，我是 ${name}`,
		based: (loc: string) => `坐标${loc}`,
		aboutMe: '关于我',
		recentPosts: '最近文章',
		allPosts: '全部文章 →',
		allProjects: '全部项目 →',
		tags: '标签',
		allTags: '所有标签',
		minutes: (n: number) => `约 ${n} 分钟`,
		postCount: (n: number, from?: number, to?: number) => `共 ${n} 篇 · ${from} – ${to}`,
		rss: 'RSS 订阅',
		toc: '目录',
		backToTop: '↑ 回到顶部',
		newer: '← 上一篇',
		older: '下一篇 →',
		backToPosts: '← 所有文章',
		updated: '更新于',
		tagTitle: (t: string) => `标签：${t}`,
		tagDesc: (t: string) => `标签为「${t}」的文章`,
		tagCount: (n: number) => `${n} 篇文章`,
		viewAll: '查看全部文章',
		projectsDesc: '我做的一些开源项目',
		projectsIntro: '一些开源项目，更多见',
		website: '主页 ↗',
		source: '源码 ↗',
		forkedFrom: 'Fork 自',
		copy: '复制',
		copied: '已复制',
		otherLang: '英文',
	},
	en: {
		htmlLang: 'en',
		posts: 'Posts',
		projects: 'Projects',
		about: 'About',
		switchTo: '中文',
		switchLabel: '切换到中文',
		hello: (name: string) => `Hi, I'm ${name}`,
		based: (loc: string) => `Based in ${loc}`,
		aboutMe: 'About me',
		recentPosts: 'Recent posts',
		allPosts: 'All posts →',
		allProjects: 'All projects →',
		tags: 'Tags',
		allTags: 'All tags',
		minutes: (n: number) => `${n} min read`,
		postCount: (n: number, from?: number, to?: number) => `${n} posts · ${from} – ${to}`,
		rss: 'RSS feed',
		toc: 'Contents',
		backToTop: '↑ Back to top',
		newer: '← Newer',
		older: 'Older →',
		backToPosts: '← All posts',
		updated: 'Updated',
		tagTitle: (t: string) => `Tag: ${t}`,
		tagDesc: (t: string) => `Posts tagged “${t}”`,
		tagCount: (n: number) => `${n} ${n === 1 ? 'post' : 'posts'}`,
		viewAll: 'View all posts',
		projectsDesc: 'Some open-source projects I have built',
		projectsIntro: 'Some open-source projects. More on',
		website: 'Website ↗',
		source: 'Source ↗',
		forkedFrom: 'Forked from',
		copy: 'Copy',
		copied: 'Copied',
		otherLang: 'Chinese',
	},
} as const;

export type UIStrings = (typeof UI)['zh'] | (typeof UI)['en'];
export const t = (lang: Lang): UIStrings => UI[lang];
