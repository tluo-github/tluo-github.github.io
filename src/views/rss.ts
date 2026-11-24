import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { SITE } from '../consts';
import type { Lang } from '../i18n';
import { getPosts, postUrl } from '../lib/posts';

export async function feed(lang: Lang, context: APIContext) {
	const posts = await getPosts(lang);
	return rss({
		title: SITE[lang].title,
		description: SITE[lang].description,
		site: context.site!,
		customData: `<language>${lang === 'en' ? 'en' : 'zh-cn'}</language>`,
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			categories: post.data.tags,
			link: postUrl(lang, post.id),
		})),
	});
}
