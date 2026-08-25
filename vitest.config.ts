import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '/@/shared': resolve('src/shared'),
        },
    },
    test: {
        hookTimeout: 30000,
        include: ['tests/**/*.test.ts'],
        pool: 'forks',
        testTimeout: 30000,
    },
});
