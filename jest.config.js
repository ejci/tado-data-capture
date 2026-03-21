module.exports = {
  // Clear mocks between tests so that usage counts reset.
  clearMocks: true,

  // Restore mock state before every test.
  restoreMocks: true,

  // Run a setup file before testing starts to configure the environment.
  setupFiles: ['<rootDir>/jest.setup.js'],

  // The directory where Jest should output its coverage files.
  coverageDirectory: 'coverage',

  // Specify the test environment (node vs browser).
  testEnvironment: 'node',
};
