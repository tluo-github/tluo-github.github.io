import type { Lang } from './i18n';

// 全站信息，改这里就行（按语言分开写）
export const AUTHOR = 'Bruce';
export const GITHUB_URL = 'https://github.com/tluo-github';
export const SINCE = 2022;

export const SITE: Record<Lang, { title: string; description: string; intro: string; role: string; motto: string; location: string }> = {
	zh: {
		title: 'Bruce 的博客',
		description: '用 AI 做产品，也记录 8 年 Java、Kubernetes 与 SRE 的一线实践。',
		intro: '现在主要用 AI 做 Vibe Coding 开发；之前做了 8 年多 Java 后端、Kubernetes 和 SRE。',
		role: 'AI Vibe Coding · 前云原生 SRE',
		motto: '节饮食，慎言语',
		location: '上海',
	},
	en: {
		title: "Bruce's Blog",
		description: 'Building products with AI, and notes from 8 years of hands-on Java, Kubernetes and SRE work.',
		intro: 'I build products with AI (vibe coding). Before that, I spent 8+ years on Java backends, Kubernetes and SRE.',
		role: 'AI Vibe Coding · ex Cloud-Native SRE',
		motto: 'Moderate in eating, careful in speech',
		location: 'Shanghai',
	},
};

// 项目卡片上的语言色点（GitHub 配色）
export const LANG_COLORS: Record<string, string> = {
	Swift: '#F05138',
	Java: '#B07219',
	JavaScript: '#F1E05A',
};

type Text = Record<Lang, string>;

// 项目页分组（ai = 用 AI 做的工具，infra = 云原生与中间件）
export const PROJECT_GROUPS: { key: string; title: Text; desc: Text }[] = [
	{
		key: 'ai',
		title: { zh: '用 AI 做的工具', en: 'Built with AI' },
		desc: { zh: 'Vibe Coding 做出来的小产品，日常自己在用。', en: 'Small products made by vibe coding, which I use every day.' },
	},
	{
		key: 'infra',
		title: { zh: '云原生与中间件', en: 'Cloud native & middleware' },
		desc: { zh: '工作中沉淀下来的组件，在生产环境落地过。', en: 'Components distilled from my day job and proven in production.' },
	},
];

export type Project = { name: string; group: string; url?: string; repo: string; lang: string; fork?: string; desc: Text };

export const PROJECTS: Project[] = [
	{
		name: 'quotlet',
		group: 'ai',
		url: 'https://quotlet.com',
		repo: 'https://github.com/tluo-github/quotlet',
		lang: 'Swift',
		desc: {
			zh: '在 macOS 菜单栏里查看 Claude Code、Codex、Gemini 的用量额度、实时输出速度（tok/s）、会话和按 API 计价的成本。',
			en: 'Track Claude Code, Codex and Gemini usage limits, live output speed (tok/s), sessions and API-equivalent cost from the macOS menu bar.',
		},
	},
	{
		name: 'markread',
		group: 'ai',
		repo: 'https://github.com/tluo-github/markread',
		lang: 'Swift',
		desc: {
			zh: '极简、免费、离线的 Markdown 阅读器，支持 macOS 和 Windows，Typora 风格排版、Highlight.js 代码高亮、Finder 快速预览。',
			en: 'A minimal, free and offline Markdown reader for macOS and Windows, with Typora-style typography, Highlight.js and Finder Quick Look.',
		},
	},
	{
		name: 'dubbo-cluster-loadbalance-ema',
		group: 'infra',
		repo: 'https://github.com/tluo-github/dubbo-cluster-loadbalance-ema',
		lang: 'Java',
		desc: {
			zh: '基于 EMA 的 Dubbo 柔性负载均衡：按 RT 实时调权，支持预热、优雅下线和错误惩罚。在搜推链路生产落地，RT 异常波动降低 10%。',
			en: 'EMA-based adaptive load balancing for Dubbo: weights follow live RT, with warm-up, graceful shutdown and error penalty. Cut RT spikes by 10% in production.',
		},
	},
	{
		name: 'dubbo-loadbalance-test',
		group: 'infra',
		repo: 'https://github.com/tluo-github/dubbo-loadbalance-test',
		lang: 'Java',
		desc: {
			zh: '多 provider 的 Dubbo 负载均衡测试床，包含 EmaLoadBalance 等策略的 consumer / provider 示例。',
			en: 'A multi-provider testbed for Dubbo load balancing strategies, including EmaLoadBalance, with consumer and provider examples.',
		},
	},
	{
		name: 'youtube-digest',
		group: 'ai',
		repo: 'https://github.com/tluo-github/youtube-digest',
		lang: 'JavaScript',
		fork: 'zarazhangrui/youtube-digest',
		desc: {
			zh: '把 YouTube 视频变成深度学习资料：字幕、双语翻译、AI 概览、讲解和笔记，自带 API Key 即可使用。',
			en: 'Turn YouTube videos into study material: transcripts, bilingual translation, AI overviews, explanations and notes. Bring your own API key.',
		},
	},
];
