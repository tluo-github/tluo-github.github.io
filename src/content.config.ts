import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const schema = z.object({
	title: z.string(),
	description: z.string().optional(),
	pubDate: z.coerce.date(),
	updatedDate: z.coerce.date().optional(),
	tags: z.array(z.string()).default([]),
	draft: z.boolean().default(false),
});

// 中文文章：src/content/blog/；英文译文：src/content/blog-en/，文件名与中文版相同
const blog = defineCollection({ loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }), schema });
const blogEn = defineCollection({ loader: glob({ base: './src/content/blog-en', pattern: '**/*.{md,mdx}' }), schema });

export const collections = { blog, blogEn };
