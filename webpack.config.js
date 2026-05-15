const path = require('path');
const fs = require('fs');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const ZipPlugin = require('zip-webpack-plugin');
const package = require('./package.json');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');

// Remove .DS_Store files
function removeDSStore(dir) {
	const files = fs.readdirSync(dir);
	files.forEach(file => {
		const filePath = path.join(dir, file);
		if (fs.statSync(filePath).isDirectory()) {
			removeDSStore(filePath);
		} else if (file === '.DS_Store') {
			fs.unlinkSync(filePath);
		}
	});
}

module.exports = (env, argv) => {
	const isFirefox = env.BROWSER === 'firefox';
	const isSafari = env.BROWSER === 'safari';
	const isProduction = argv.mode === 'production';

	// cn 约定：开发与生产构建统一输出到 dist*/。Chrome 等扩展恒定加载 dist/，
	// 避免出现"watch 在 dev/ 而扩展加载 dist/"导致的代码改了 reload 没反应。
	// 开发模式仍带 sourcemap + 不 minify（见 devtool / optimization 配置），
	// production build 写同一目录覆盖之，是预期行为。
	const getOutputDir = () => {
		return isFirefox ? 'dist_firefox' : (isSafari ? 'dist_safari' : 'dist');
	};

	const outputDir = getOutputDir();
	const browserName = isFirefox ? 'firefox' : (isSafari ? 'safari' : 'chrome');

	const mainConfig = {
		mode: argv.mode,
		entry: {
			popup: './src/core/popup.ts',
			settings: './src/core/settings.ts',
			highlights: './src/core/highlights.ts',
			'reader-page': './src/core/reader-view.ts',
			content: './src/content.ts',
			background: './src/background.ts',
			style: './src/style.scss',
			highlighter: './src/highlighter.scss',
			reader: './src/reader.scss',
			'reader-script': './src/reader-script.ts'
		},
		output: {
			path: path.resolve(__dirname, outputDir),
			filename: '[name].js',
			module: false,
		},
		devtool: isProduction ? false : 'source-map',
		optimization: {
			minimize: true,
			minimizer: [
				new TerserPlugin({
					terserOptions: {
						mangle: false,
						compress: {
							defaults: true,
							global_defs: {
								DEBUG_MODE: !isProduction
							},
							unused: true,
							dead_code: true,
							passes: 2,
							ecma: 2020,
							module: false
						},
						format: {
							ascii_only: true,
							comments: false,
							ecma: 2020
						},
						module: false,
						toplevel: true,
						keep_classnames: true,
						keep_fnames: true
					},
					extractComments: false
				})
			],
			moduleIds: 'named',
			chunkIds: 'named'
		},
		experiments: {
			outputModule: false,
		},
		resolve: {
			extensions: ['.ts', '.js'],
			alias: {
				'./utils/browser-polyfill': path.resolve(__dirname, 'node_modules/webextension-polyfill/dist/browser-polyfill.min.js'),
				'../utils/browser-polyfill': path.resolve(__dirname, 'node_modules/webextension-polyfill/dist/browser-polyfill.min.js')
			}
		},
		module: {
			rules: [
				{
					test: /\.tsx?$/,
					use: [
						{
							loader: 'ts-loader',
							options: {
								compilerOptions: {
									module: 'ES2020'
								}
							}
						}
					],
					exclude: /node_modules/,
				},
				{
					test: /\.scss$/,
					use: [
						MiniCssExtractPlugin.loader,
						{
							loader: 'css-loader',
							options: {
								sourceMap: !isProduction
							}
						},
						{
							loader: 'sass-loader',
							options: {
								sourceMap: !isProduction
							}
						}
					]
				}
			]
		},
		plugins: [
			new CopyPlugin({
				patterns: [
					{ 
						from: isFirefox ? "src/manifest.firefox.json" : 
							  (isSafari ? "src/manifest.safari.json" : "src/manifest.chrome.json"), 
						to: "manifest.json" 
					},
					{ from: "src/popup.html", to: "popup.html" },
					{ from: "src/side-panel.html", to: "side-panel.html" },
					{ from: "src/settings.html", to: "settings.html" },
					{ from: "src/highlights.html", to: "highlights.html" },
					{ from: "src/reader.html", to: "reader.html" },
					{ from: "src/icons", to: "icons" },
					{ from: "node_modules/webextension-polyfill/dist/browser-polyfill.min.js", to: "browser-polyfill.min.js" },
					{ from: "src/flatten-shadow-dom.js", to: "flatten-shadow-dom.js" },
					{ from: "src/scys-docx-patch.js", to: "scys-docx-patch.js" },
					{
						from: 'src/_locales',
						to: '_locales'
					}
				],
			}),
			new MiniCssExtractPlugin({
				filename: '[name].css'
			}),
			{
				apply: (compiler) => {
					compiler.hooks.afterEmit.tap('RemoveDSStore', (compilation) => {
						removeDSStore(path.resolve(__dirname, outputDir));
					});
				}
			},
			// Emit a build-marker.txt with the current timestamp every build.
			// The background service worker polls this file when DEBUG_MODE is on
			// and reloads the extension when the contents change. Enables fully
			// automated dev-iteration: edit code, npm build, extension auto-reloads.
			{
				apply: (compiler) => {
					compiler.hooks.thisCompilation.tap('BuildMarkerPlugin', (compilation) => {
						compilation.hooks.processAssets.tap(
							{
								name: 'BuildMarkerPlugin',
								stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
							},
							() => {
								const marker = String(Date.now());
								compilation.emitAsset(
									'build-marker.txt',
									new webpack.sources.RawSource(marker)
								);
							}
						);
					});
				}
			},
			new webpack.DefinePlugin({
				'process.env.NODE_ENV': JSON.stringify(argv.mode),
				'DEBUG_MODE': JSON.stringify(!isProduction)
			}),
			...(isProduction ? [
				new ZipPlugin({
					path: path.resolve(__dirname, 'builds'),
					filename: `obsidian-clipper-cn-${package.version}-${browserName}.zip`,
				})
			] : [])
		]
	};

	return [mainConfig];
};
