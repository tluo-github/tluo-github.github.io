import { type CollectionEntry, getCollection } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/** 已发布文章，按日期从新到旧；draft: true 的只在本地 dev 显示 */
export async function getPosts() {
	const posts = await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** 阅读时长（分钟）：去掉代码块和图片后按每分钟约 350 字估算 */
export function readingMinutes(post: Post) {
	const text = (post.body ?? '').replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
	const cjk = (text.match(/[一-鿿]/g) ?? []).length;
	const words = (text.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9]+/g) ?? []).length;
	return Math.max(1, Math.ceil((cjk + words) / 350));
}

/** 有意义的简介：为空或与标题相同时返回 undefined */
export function summaryOf(post: Post) {
	const d = post.data.description?.trim();
	return d && d !== post.data.title ? d : undefined;
}

/** 所有标签及篇数，按篇数从多到少 */
export function getAllTags(posts: Post[]) {
	const m = new Map<string, number>();
	for (const p of posts) for (const t of p.data.tags) m.set(t, (m.get(t) ?? 0) + 1);
	return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export const tagUrl = (tag: string) => `/tags/${encodeURIComponent(tag)}/`;
