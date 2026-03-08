// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// https://astro.build/config
export default defineConfig({
	site: 'https://abokhalill.github.io',
	base: '/lshaz-writeup',
	markdown: {
		remarkPlugins: [remarkMath],
		rehypePlugins: [rehypeKatex],
	},
	integrations: [
		starlight({
			title: 'lshaz',
			description: 'Technical deep dives and systems engineering writeups.',
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/abokhalill/lshaz',
				},
			],
			sidebar: [
				{
					label: 'Writeups',
					autogenerate: { directory: 'writeups' },
				},
			],
			head: [
				{
					tag: 'link',
					attrs: {
						rel: 'stylesheet',
						href: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
						integrity: 'sha384-nB0miv6/jRmo5YCBER1viGlHEhFhKQ+0fY+raxMfQruDhHa2hzgCWFLJ69kGLkm',
						crossorigin: 'anonymous',
					},
				},
			],
			customCss: ['./src/styles/custom.css'],
			components: {
				Head: './src/components/Head.astro',
			},
		}),
	],
});
