import { defineConfig } from 'vitest/config';

/** 使用模拟网页和虚拟配置验证边界，不连接真实翻译服务。 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 10000,
  },
});
