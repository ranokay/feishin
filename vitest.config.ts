import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        hookTimeout: 30000,
        include: ['tests/**/*.test.ts'],
        pool: 'forks',
        testTimeout: 30000,
    },
});
