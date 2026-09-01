// Targets Chromium 47 explicitly (2017 Samsung Tizen 3.0 TV browsers) rather
// than relying on a browserslist guess — preset-env then transforms exactly
// what that engine lacks (classes, let/const, destructuring, spread,
// optional chaining, nullish coalescing, Proxy-free syntax) and leaves what
// it already supports (arrow functions, template literals, Promises)
// untouched.
module.exports = {
  presets: [
    ['@babel/preset-env', {
      targets: { chrome: '47' },
      useBuiltIns: 'usage',
      corejs: 3,
    }],
    ['@babel/preset-react', { runtime: 'automatic' }],
    '@babel/preset-typescript',
  ],
};
