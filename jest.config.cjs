module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/**/tests/unit/**/*.test.cjs'],
  clearMocks: true,
  restoreMocks: true,
  transform: { '^.+\\.tsx?$': '<rootDir>/scripts/jest-typescript.cjs' },
  collectCoverageFrom: ['Carrom/carrom-rules.js', 'Carrom/carrom-physics.js', '29_Card/src/**/*.{ts,tsx}'],
  coverageDirectory: 'coverage',
};
