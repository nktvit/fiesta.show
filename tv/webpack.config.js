const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
  mode: 'production',
  entry: './src/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.[contenthash].js',
    // Absolute: served via a Vercel *rewrite* (URL bar keeps the original
    // request path, e.g. "/" or "/movie/tt123"), so relative asset paths
    // would resolve against the wrong path and 404.
    publicPath: '/lite/',
    clean: true,
    // Babel only transforms our own src/ (node_modules is excluded below for
    // build speed); this forces webpack's OWN generated module/runtime glue
    // to ES5 too, since webpack 5 otherwise emits arrow functions/const
    // there regardless of Babel config.
    environment: {
      arrowFunction: false,
      bigIntLiteral: false,
      const: false,
      destructuring: false,
      dynamicImport: false,
      forOf: false,
      module: false,
      optionalChaining: false,
      templateLiteral: false,
    },
  },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  module: {
    rules: [
      { test: /\.(ts|tsx|js)$/, exclude: /node_modules/, use: 'babel-loader' },
      { test: /\.css$/, use: [MiniCssExtractPlugin.loader, 'css-loader'] },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({ template: './public/index.html' }),
    new MiniCssExtractPlugin({ filename: 'styles.[contenthash].css' }),
  ],
  optimization: {
    // Default Terser can re-introduce modern syntax when minifying; pin it.
    minimizer: [new TerserPlugin({ terserOptions: { ecma: 5, safari10: true } })],
    // No automatic vendor/runtime chunk splitting — keep this a single
    // bundle.js so there's no chunk-loading runtime to downlevel.
    splitChunks: false,
    runtimeChunk: false,
  },
  performance: { hints: false },
  devtool: false,
};
