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
			chunkIds: 'named',
			splitChunks: {
				cacheGroups: {
					mammoth: {
						test: /[\\/]node_modules[\\/](mammoth|jszip|mathml-to-latex|underscore)[\\/]/,
						name: 'mammoth-vendor',
						// Exclude content entry: content scripts can't load async chunks via
						// <script> tag injection unless those chunks are in web_accessible_resources
						// (which would require listing them explicitly in manifest — fragile).
						// Inlining into content.js is simpler and content.js is already large.
						chunks: 'async',
						priority: 10,
						enforce: true,
					},
				},
			},
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
			// Fix dynamic chunk loading in content script.
			// Webpack auto-detects publicPath from document.currentScript.src. In a
			// content script (injected by browser, not via <script> tag), this is null
			// and the fallback picks the page's own last <script> URL (e.g.
			// docs.gtimg.com/...), causing import('mammoth') to load from the wrong
			// origin and fail.
			//
			// The fix: after webpack emits content.js, we do a source-level patch:
			// replace the "Automatic publicPath is not supported" throw block with a
			// chrome.runtime.getURL('') call. The target pattern is the scriptUrl
			// auto-detection IIFE that ends with setting __webpack_require__.p.
			{
				apply: (compiler) => {
					compiler.hooks.thisCompilation.tap('ContentScriptPublicPathPlugin', (compilation) => {
						compilation.hooks.processAssets.tap(
							{
								name: 'ContentScriptPublicPathPlugin',
								stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
							},
							(assets) => {
								if (!assets['content.js']) return;
								let src = assets['content.js'].source().toString();
								// Patch: replace the auto-publicPath detection with chrome.runtime.getURL.
								// In content scripts, document.currentScript is null (not injected via
								// <script> tag), so webpack's auto-detection falls back to the page's
								// own script URL (e.g. docs.gtimg.com/...) — wrong origin.
								// We locate the exact throw-and-set block in the emitted JS and replace
								// it with a chrome.runtime.getURL('') assignment.
								// NOTE: each \ in content.js needs \\\\ in JS string literal here.
								const needle = 'if(!scriptUrl)throw new Error("Automatic publicPath is not supported in this browser");scriptUrl=scriptUrl.replace(/^blob:/,"").replace(/#.*$/,"").replace(/\\?.*$/,"").replace(/\\/[^\\/]+$/,"/"),__webpack_require__.p=scriptUrl';
								const patch = '__webpack_require__.p=(typeof chrome!=="undefined"&&chrome.runtime&&chrome.runtime.getURL)?chrome.runtime.getURL(""):""';
								if (src.includes(needle)) {
									src = src.replace(needle, patch);
									compilation.updateAsset(
										'content.js',
										new webpack.sources.RawSource(src)
									);
									console.log('[ContentScriptPublicPathPlugin] Patched content.js publicPath → chrome.runtime.getURL');
								} else {
									// Pattern didn't match — warn so we notice if webpack changes its runtime
									console.warn('[ContentScriptPublicPathPlugin] WARNING: publicPath detection pattern not found in content.js — dynamic imports may fail in extension content scripts');
								}
							}
						);
					});
				}
			},
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
