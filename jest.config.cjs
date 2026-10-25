module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/**/tests/unit/**/*.test.cjs'],
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: ['Carrom/carrom-rules.js', 'Carrom/carrom-physics.js'],
  coverageDirectory: 'coverage',
};
