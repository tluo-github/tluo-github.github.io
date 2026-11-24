import type { APIContext } from 'astro';
import { feed } from '../views/rss';

export const GET = (context: APIContext) => feed('zh', context);
