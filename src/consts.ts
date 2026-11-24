// 全站信息，改这里就行
export const SITE_TITLE = 'Bruce 的博客';
export const SITE_DESCRIPTION = '用 AI 做产品，也记录 8 年 Java、Kubernetes 与 SRE 的一线实践。';
export const AUTHOR = 'Bruce';
export const MOTTO = '节饮食，慎言语';
export const LOCATION = '上海';
export const ROLE = 'AI Vibe Coding · 前云原生 SRE';
// 首页自我介绍
export const INTRO = '现在主要用 AI 做 Vibe Coding 开发；之前做了 8 年多 Java 后端、Kubernetes 和 SRE。';
export const SINCE = 2022;

// 项目卡片上的语言色点（GitHub 配色）
export const LANG_COLORS: Record<string, string> = {
	Swift: '#F05138',
	Java: '#B07219',
	JavaScript: '#F1E05A',
};
export const GITHUB_URL = 'https://github.com/tluo-github';

// 项目页展示的项目（group：ai = 用 AI 做的工具，infra = 云原生与中间件）
export const PROJECT_GROUPS = [
	{ key: 'ai', title: '用 AI 做的工具', desc: 'Vibe Coding 做出来的小产品，日常自己在用。' },
	{ key: 'infra', title: '云原生与中间件', desc: '工作中沉淀下来的组件，在生产环境落地过。' },
];

export const PROJECTS = [
	{
		name: 'quotlet',
		group: 'ai',
		url: 'https://quotlet.com',
		repo: 'https://github.com/tluo-github/quotlet',
		lang: 'Swift',
		desc: '在 macOS 菜单栏里查看 Claude Code、Codex、Gemini 的用量额度、实时输出速度（tok/s）、会话和按 API 计价的成本。',
	},
	{
		name: 'markread',
		group: 'ai',
		repo: 'https://github.com/tluo-github/markread',
		lang: 'Swift',
		desc: '极简、免费、离线的 Markdown 阅读器，支持 macOS 和 Windows，Typora 风格排版、Highlight.js 代码高亮、Finder 快速预览。',
	},
	{
		name: 'dubbo-cluster-loadbalance-ema',
		group: 'infra',
		repo: 'https://github.com/tluo-github/dubbo-cluster-loadbalance-ema',
		lang: 'Java',
		desc: '基于 EMA 的 Dubbo 柔性负载均衡：按 RT 实时调权，支持预热、优雅下线和错误惩罚。在搜推链路生产落地，RT 异常波动降低 10%。',
	},
	{
		name: 'dubbo-loadbalance-test',
		group: 'infra',
		repo: 'https://github.com/tluo-github/dubbo-loadbalance-test',
		lang: 'Java',
		desc: '多 provider 的 Dubbo 负载均衡测试床，包含 EmaLoadBalance 等策略的 consumer / provider 示例。',
	},
	{
		name: 'youtube-digest',
		group: 'ai',
		repo: 'https://github.com/tluo-github/youtube-digest',
		lang: 'JavaScript',
		fork: 'zarazhangrui/youtube-digest',
		desc: '把 YouTube 视频变成深度学习资料：字幕、双语翻译、AI 概览、讲解和笔记，自带 API Key 即可使用。',
	},
];
