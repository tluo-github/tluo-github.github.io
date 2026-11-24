import { type CollectionEntry, getCollection } from 'astro:content';
import { type Lang, url } from '../i18n';

export type Post = CollectionEntry<'blog'> | CollectionEntry<'blogEn'>;
/** 列表里的一项：lang 是这篇文章本身的语言（英文站可能列出还没翻译的中文文章） */
export type PostRef = { post: Post; lang: Lang };

const collectionOf = (lang: Lang) => (lang === 'en' ? 'blogEn' : 'blog');
const visible = ({ data }: Post) => import.meta.env.DEV || !data.draft;
const byDate = (a: { post: Post }, b: { post: Post }) => b.post.data.pubDate.valueOf() - a.post.data.pubDate.valueOf();

/** 某个语言自己的文章，按日期从新到旧 */
export async function getPosts(lang: Lang): Promise<Post[]> {
	const posts = (await getCollection(collectionOf(lang), visible)) as Post[];
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** 列表用：英文站会补上还没有英文版的中文文章 */
export async function getPostList(lang: Lang): Promise<PostRef[]> {
	const own = (await getPosts(lang)).map((post) => ({ post, lang }));
	if (lang === 'zh') return own;
	const ids = new Set(own.map((r) => r.post.id));
	const zhOnly = (await getPosts('zh')).filter((p) => !ids.has(p.id)).map((post) => ({ post, lang: 'zh' as Lang }));
	return [...own, ...zhOnly].sort(byDate);
}

/** 另一种语言里是否有同名文章 */
export async function hasTranslation(lang: Lang, id: string) {
	return (await getPosts(lang)).some((p) => p.id === id);
}

export const postUrl = (lang: Lang, id: string) => url(lang, `/blog/${id}/`);

/** 阅读时长（分钟）：去掉代码块和图片后，中文按每分钟 350 字、英文按每分钟 230 词估算 */
export function readingMinutes(post: Post, lang: Lang) {
	const text = (post.body ?? '').replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
	const cjk = (text.match(/[一-鿿]/g) ?? []).length;
	const words = (text.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9]+/g) ?? []).length;
	const n = lang === 'en' ? words / 230 : (cjk + words) / 350;
	return Math.max(1, Math.ceil(n));
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

export const tagSlug = (tag: string) => tag.toLowerCase().replace(/\s+/g, '-');
export const tagUrl = (lang: Lang, tag: string) => url(lang, `/tags/${encodeURIComponent(tagSlug(tag))}/`);
