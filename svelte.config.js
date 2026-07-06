import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			// Emulate Cloudflare bindings (the R2 `EVENTS` bucket) during `vite dev`,
			// reading them from wrangler.jsonc and persisting local state under .wrangler/
			platformProxy: {
				configPath: 'wrangler.jsonc',
				persist: true
			}
		})
	}
};

export default config;
