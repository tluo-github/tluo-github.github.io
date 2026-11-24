import type { Lang } from '../i18n';
import { getAllTags, getPosts, tagSlug } from '../lib/posts';

export async function tagPaths(lang: Lang) {
	const posts = await getPosts(lang);
	const tags = getAllTags(posts);
	return tags.map(([tag]) => ({
		params: { tag: tagSlug(tag) },
		props: { lang, tag, tags, posts: posts.filter((p) => p.data.tags.includes(tag)) },
	}));
}
