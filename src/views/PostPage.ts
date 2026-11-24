import { type Lang, url } from '../i18n';
import { getPosts, hasTranslation, type Post, postUrl } from '../lib/posts';

/** 生成某个语言的全部文章页路径，附上上一篇/下一篇和语言切换地址 */
export async function postPaths(lang: Lang) {
	const posts = await getPosts(lang);
	const other: Lang = lang === 'zh' ? 'en' : 'zh';
	return Promise.all(
		posts.map(async (post, i) => {
			const translated = await hasTranslation(other, post.id);
			return {
				params: { slug: post.id },
				props: {
					post,
					lang,
					next: posts[i - 1] as Post | undefined,
					prev: posts[i + 1] as Post | undefined,
					switchHref: translated ? postUrl(other, post.id) : url(other, '/blog'),
					hasAlternate: translated,
				},
			};
		}),
	);
}
