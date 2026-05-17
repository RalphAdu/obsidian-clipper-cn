// Stub for `webextension-polyfill` so Node can import feishu-extractor.ts.
// The audit pipeline only calls *pure* functions from feishu-extractor
// (convertBlocksToHtml). The browser.runtime.sendMessage path is unreachable
// during audit because we don't call resolveFeishuImages / resolveFeishuSheets.
// If anything in the import graph actually invokes browser.* in Node, we
// want a loud error rather than silent garbage. So throw on access.

const handler: ProxyHandler<object> = {
	get(_target, prop) {
		throw new Error(
			`[feishu-audit] webextension-polyfill stub: property "${String(prop)}" accessed; ` +
			`the audit pipeline should not invoke browser APIs in Node. ` +
			`If you genuinely need this, mock the specific method.`,
		);
	},
};

export const runtime = new Proxy({}, handler) as any;
export const storage = new Proxy({}, handler) as any;
export const tabs = new Proxy({}, handler) as any;
export const i18n = {
	getMessage: (key: string) => key,
};

export default { runtime, storage, tabs, i18n };
