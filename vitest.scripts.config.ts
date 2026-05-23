import { defineConfig } from 'vitest/config';

export default defineConfig({
	define: {
		DEBUG_MODE: false,
	},
	test: {
		include: ['scripts/**/*.test.ts'],
		exclude: ['**/node_modules/**'],
		globals: true,
	},
});
