// Prebuilt browser bundles of kuroshiro and its kuromoji analyzer. The package roots pull in
// node-only modules (path) that the Angular webpack build cannot resolve; these UMD files are
// self-contained. Neither package ships typings.
declare module 'kuroshiro/dist/kuroshiro.min.js';
declare module 'kuroshiro-analyzer-kuromoji/dist/kuroshiro-analyzer-kuromoji.min.js';
