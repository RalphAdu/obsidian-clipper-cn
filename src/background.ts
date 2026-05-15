import browser from 'webextension-polyfill';
import { detectBrowser } from './utils/browser-detection';
import { updateCurrentActiveTab, isValidUrl, isBlankPage, isNormalPageUrl } from './utils/active-tab-manager';
import { TextHighlightData } from './utils/highlighter';
import { debounce } from './utils/debounce';
import { Settings } from './types/types';
import { createLogger } from './utils/logger';
import { debugLog } from './utils/debug';

const bgLogger = createLogger('Background');

const YOUTUBE_EMBED_RULE_ID = 9001;
const BILIBILI_EMBED_RULE_ID = 9002;
const YOUTUBE_INNERTUBE_RULE_ID = 9003;

// Hot reload: poll build-marker.txt (written by webpack on every build) and
// reload the extension when its contents change. Lets `npm run build` trigger
// an automatic chrome.runtime.reload() so iteration doesn't require clicking
// the reload button in chrome://extensions every time.
// Uses chrome.alarms (not setInterval) because MV3 service workers get
// unloaded after ~30s of idle and setInterval doesn't survive that. The
// alarm wakes the worker reliably even after it's been put to sleep.
// Active in all build modes — for users installing from the webstore the
// marker file is written once at build time and never changes, so this only
// ever fires for self-built / unpacked installations.
const HOT_RELOAD_ALARM = 'cn-hot-reload-poll';
const HOT_RELOAD_MARKER_KEY = 'cnHotReloadLastMarker';
async function checkBuildMarker() {
	try {
		const url = chrome.runtime.getURL('build-marker.txt');
		const resp = await fetch(url, { cache: 'no-store' });
		if (!resp.ok) return;
		const current = (await resp.text()).trim();
		// Persist last seen marker across service-worker restarts so we don't
		// erroneously reload after every idle wake-up.
		const stored = await chrome.storage.session.get(HOT_RELOAD_MARKER_KEY);
		const last = stored[HOT_RELOAD_MARKER_KEY] as string | undefined;
		if (!last) {
			await chrome.storage.session.set({ [HOT_RELOAD_MARKER_KEY]: current });
			return;
		}
		if (last !== current) {
			bgLogger.info(`Build marker changed (${last} -> ${current}), reloading extension`);
			chrome.runtime.reload();
		}
	} catch {
		// Service worker may be transitioning; ignore and retry next alarm
	}
}
// Chrome enforces a 30s minimum for periodInMinutes on packed extensions but
// allows shorter periods for unpacked / loaded-from-disk extensions. We need
// the short period to make dev iteration tight.
chrome.alarms.create(HOT_RELOAD_ALARM, { periodInMinutes: 0.05 }); // every 3 seconds (unpacked)
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === HOT_RELOAD_ALARM) checkBuildMarker();
});
// Also check immediately on startup (e.g. just after install)
checkBuildMarker();

function fetchBilibiliJsonViaMainWorld(tabId: number, url: string): Promise<any> {
	if (!isAllowedBilibiliFetchUrl(url)) {
		return Promise.reject(new Error('Blocked Bilibili fetch URL'));
	}

	return chrome.scripting.executeScript({
		target: { tabId },
		world: 'MAIN',
		func: (url: string) => fetch(url, {
			method: 'GET',
			credentials: 'include',
			cache: 'no-store'
		}).then((response: Response) => {
			if (!response.ok) {
				throw new Error(`Bilibili page-context fetch failed with status ${response.status}`);
			}
			return response.json();
		}),
		args: [url],
	}).then((results) => {
		return results?.[0]?.result;
	});
}

// Chrome: declarativeNetRequest to rewrite Referer on YouTube embeds.
// Safari/Firefox use the native video element instead (see reader.ts).
async function enableYouTubeEmbedRule(tabId: number): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID],
		addRules: [{
			id: YOUTUBE_EMBED_RULE_ID,
			priority: 1,
			action: {
				type: 'modifyHeaders' as any,
				requestHeaders: [{
					header: 'Referer',
					operation: 'set' as any,
					value: 'https://obsidian.md/'
				}]
			},
			condition: {
				urlFilter: '||youtube.com/embed/',
				resourceTypes: ['sub_frame' as any],
				tabIds: [tabId]
			}
		}]
	});
}

async function disableYouTubeEmbedRule(): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID]
	});
}

// Firefox: webRequest listener to rewrite Referer on Bilibili embeds.
if (browser.webRequest?.onBeforeSendHeaders) {
	browser.webRequest.onBeforeSendHeaders.addListener(
		(details) => {
			const headers = (details.requestHeaders || []).filter(
				h => h.name.toLowerCase() !== 'referer'
			);
			headers.push({ name: 'Referer', value: 'https://www.bilibili.com/' });
			return { requestHeaders: headers };
		},
		{
			urls: ['*://player.bilibili.com/*'],
			types: ['sub_frame' as browser.WebRequest.ResourceType]
		},
		['blocking', 'requestHeaders']
	);
}

async function enableBilibiliEmbedRule(tabId: number): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [BILIBILI_EMBED_RULE_ID],
		addRules: [{
			id: BILIBILI_EMBED_RULE_ID,
			priority: 1,
			action: {
				type: 'modifyHeaders' as any,
				requestHeaders: [{
					header: 'Referer',
					operation: 'set' as any,
					value: 'https://www.bilibili.com/'
				}]
			},
			condition: {
				urlFilter: '||player.bilibili.com/',
				resourceTypes: ['sub_frame' as any],
				tabIds: [tabId]
			}
		}]
	});
}

async function disableBilibiliEmbedRule(): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [BILIBILI_EMBED_RULE_ID]
	});
}

/**
 * 判断是否允许通过后台代理抓取 B 站接口。
 */
function isAllowedBilibiliFetchUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return parsedUrl.protocol === 'https:'
			&& (
				parsedUrl.hostname === 'api.bilibili.com'
				|| parsedUrl.hostname.endsWith('.hdslb.com')
			);
	} catch {
		return false;
	}
}

/**
 * 通过后台统一抓取 B 站 JSON，复用登录态并补全 Referer。
 */
async function fetchBilibiliJson(url: string): Promise<any> {
	if (!isAllowedBilibiliFetchUrl(url)) {
		throw new Error('Blocked Bilibili fetch URL');
	}

	const response = await fetch(url, {
		method: 'GET',
		credentials: 'include',
		cache: 'no-store',
		headers: {
			Referer: 'https://www.bilibili.com/'
		}
	});

	if (!response.ok) {
		throw new Error(`Bilibili fetch failed with status ${response.status}`);
	}

	return response.json();
}

// Feishu API proxy with token management
let feishuTokenCache: { token: string; expiresAt: number } | null = null;

function isAllowedFeishuFetchUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return parsedUrl.protocol === 'https:'
			&& (parsedUrl.hostname === 'open.feishu.cn' || parsedUrl.hostname === 'open.larksuite.com');
	} catch {
		return false;
	}
}

async function getFeishuTenantToken(): Promise<string> {
	if (feishuTokenCache && Date.now() < feishuTokenCache.expiresAt) {
		bgLogger.debug('Using cached tenant token');
		return feishuTokenCache.token;
	}

	const data = await browser.storage.local.get('feishu_settings');
	const settings = data.feishu_settings as { appId?: string; appSecret?: string } | undefined;
	if (!settings?.appId || !settings?.appSecret) {
		const msg = 'Feishu credentials not configured. Go to Obsidian Clipper settings → General → Feishu / Lark to enter your App ID and App Secret.';
		bgLogger.warn(msg);
		throw new Error(msg);
	}

	bgLogger.debug('Fetching new tenant token', { appId: settings.appId });

	const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
		body: JSON.stringify({ app_id: settings.appId, app_secret: settings.appSecret }),
	});

	if (!response.ok) {
		bgLogger.error('Feishu token request failed', { status: response.status });
		throw new Error(`Feishu token request failed: HTTP ${response.status}. Check your App ID and App Secret.`);
	}

	const result = await response.json();
	if (result.code !== 0 || !result.tenant_access_token) {
		bgLogger.error('Feishu token API error', { code: result.code, msg: result.msg });
		throw new Error(`Feishu token error: ${result.msg || 'unknown'}(code ${result.code}). Verify your App ID and App Secret are correct.`);
	}

	const expiresIn = (result.expire || 7200) * 1000;
	feishuTokenCache = {
		token: result.tenant_access_token,
		expiresAt: Date.now() + expiresIn - 5 * 60 * 1000,
	};

	bgLogger.info('Tenant token acquired', { expiresInMs: expiresIn });
	return feishuTokenCache.token;
}

async function fetchFeishuApi(url: string, options?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<any> {
	if (!isAllowedFeishuFetchUrl(url)) {
		bgLogger.error('Blocked non-Feishu URL', { url });
		throw new Error('Blocked Feishu fetch URL');
	}

	const token = await getFeishuTenantToken();
	const method = options?.method || 'GET';
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json; charset=utf-8',
		...options?.headers,
	};

	bgLogger.debug('Feishu API request', { method, url });

	const fetchOptions: RequestInit = { method, headers, cache: 'no-store' };
	if (options?.body && method !== 'GET') {
		fetchOptions.body = options.body;
	}

	const response = await fetch(url, fetchOptions);
	if (!response.ok) {
		bgLogger.error('Feishu API HTTP error', { status: response.status, url });
		throw new Error(`Feishu API HTTP ${response.status}: ${url}`);
	}

	const result = await response.json();

	if (result.code && result.code !== 0) {
		bgLogger.error('Feishu API business error', { code: result.code, msg: result.msg, url });
		throw new Error(`Feishu API error ${result.code}: ${result.msg || 'unknown'} (${url})`);
	}

	return result;
}

async function fetchFeishuImageAsBase64(fileToken: string): Promise<{ dataUrl: string }> {
	const url = `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`;
	if (!isAllowedFeishuFetchUrl(url)) {
		throw new Error('Blocked Feishu image URL');
	}

	const token = await getFeishuTenantToken();
	const response = await fetch(url, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` },
		cache: 'no-store',
	});

	if (!response.ok) {
		throw new Error(`Feishu image fetch failed: HTTP ${response.status}`);
	}

	const mimeType = response.headers.get('Content-Type') || 'image/png';
	const buffer = await response.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	const base64 = btoa(binary);
	return { dataUrl: `data:${mimeType};base64,${base64}` };
}

// Set Origin header on YouTube innertube API requests from the extension.
// YouTube doesn't accept chrome-extension://...
async function enableYouTubeInnertubeRule(): Promise<void> {
	const dnr = (typeof chrome !== 'undefined' && chrome.declarativeNetRequest)
		|| (typeof browser !== 'undefined' && (browser as any).declarativeNetRequest);
	if (!dnr) return;
	try {
		await dnr.updateSessionRules({
			removeRuleIds: [YOUTUBE_INNERTUBE_RULE_ID],
			addRules: [{
				id: YOUTUBE_INNERTUBE_RULE_ID,
				priority: 1,
				action: {
					type: 'modifyHeaders' as any,
					requestHeaders: [
						{ header: 'Origin', operation: 'set' as any, value: 'https://www.youtube.com' },
						{ header: 'Referer', operation: 'set' as any, value: 'https://www.youtube.com/' },
					]
				},
				condition: {
					urlFilter: '||youtube.com/youtubei/',
					resourceTypes: ['xmlhttprequest' as any],
					initiatorDomains: [chrome?.runtime?.id || ''].filter(Boolean),
				}
			}]
		});
	} catch { /* Firefox/Safari use webRequest or native messaging instead */ }
}

// Firefox/Safari: use webRequest.onBeforeSendHeaders to set Origin/Referer on
// YouTube innertube requests. Fallback for browsers where declarativeNetRequest
// doesn't work or isn't supported.
if (typeof browser !== 'undefined' && browser.webRequest?.onBeforeSendHeaders) {
	try {
		browser.webRequest.onBeforeSendHeaders.addListener(
			(details) => {
				// Only modify requests from tabs showing extension pages
				if (details.tabId && details.tabId > 0) {
					// Check asynchronously would be complex — instead check
					// if the request has an extension origin or referer
					const refHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'referer');
					const refValue = refHeader?.value || '';
					const originHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'origin');
					const originValue = originHeader?.value || '';
					const isFromExtension = refValue.startsWith('moz-extension://') || originValue.startsWith('moz-extension://')
						|| refValue.startsWith('safari-web-extension://') || originValue.startsWith('safari-web-extension://');
					if (!isFromExtension) return { requestHeaders: details.requestHeaders };
				}

				const headers = details.requestHeaders || [];
				const setHeader = (name: string, value: string) => {
					const existing = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
					if (existing) {
						existing.value = value;
					} else {
						headers.push({ name, value });
					}
				};
				setHeader('Origin', 'https://www.youtube.com');
				setHeader('Referer', 'https://www.youtube.com/');
				return { requestHeaders: headers };
			},
			{ urls: ['*://www.youtube.com/*'] },
			['blocking', 'requestHeaders']
		);
	} catch { /* webRequest not available */ }
}

let sidePanelOpenWindows: Set<number> = new Set();
let highlighterModeState: { [tabId: number]: boolean } = {};
let readerModeState: { [tabId: number]: boolean } = {};
let hasHighlights = false;
let isContextMenuCreating = false;
let popupPorts: { [tabId: number]: browser.Runtime.Port } = {};

async function injectContentScript(tabId: number): Promise<void> {
	if (browser.scripting) {
		debugLog('Clipper', 'Using scripting API');
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['content.js']
		});
	} else {
		debugLog('Clipper', 'Using tabs.executeScript fallback');
		await browser.tabs.executeScript(tabId, { file: 'content.js' });
	}
	debugLog('Clipper', 'Injection completed, waiting for init...');

	// Poll until the content script responds, rather than a fixed delay.
	// Try immediately after injection, then back off with 50ms sleeps.
	let ready = false;
	for (let i = 0; i < 8; i++) {
		try {
			await browser.tabs.sendMessage(tabId, { action: "ping" });
			ready = true;
			break;
		} catch {
			// Not ready yet
		}
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	if (!ready) {
		throw new Error('Content script did not respond after injection');
	}
	debugLog('Clipper', 'Post-injection ping succeeded');
}

async function ensureContentScriptLoadedInBackground(tabId: number): Promise<void> {
	try {
		// First, get the tab information
		const tab = await browser.tabs.get(tabId);

		// Check if the URL is valid before proceeding
		if (!tab.url || !isValidUrl(tab.url)) {
			throw new Error('Invalid URL for content script injection');
		}

		// Attempt to send a message to the content script
		await browser.tabs.sendMessage(tabId, { action: "ping" });
		debugLog('Clipper', 'Content script ping succeeded');
	} catch (error) {
		// If the error is about invalid URL, re-throw it
		if (error instanceof Error && error.message.includes('invalid URL')) {
			throw error;
		}

		// If the message fails, the content script is not loaded, so inject it
		debugLog('Clipper', 'Ping failed, injecting content script...', error);
		await injectContentScript(tabId);
	}
}

// Route a message to a tab, handling both normal pages (via content script)
// and extension pages like the reader page (via runtime.sendMessage forwarding).
async function routeMessageToTab(tabId: number, message: any): Promise<any> {
	const tab = await browser.tabs.get(tabId);
	if (isNormalPageUrl(tab.url)) {
		await ensureContentScriptLoadedInBackground(tabId);
		return browser.tabs.sendMessage(tabId, message);
	} else {
		return browser.runtime.sendMessage({
			action: 'extensionPageMessage',
			targetTabId: tabId,
			message
		});
	}
}

function getHighlighterModeForTab(tabId: number): boolean {
	return highlighterModeState[tabId] ?? false;
}

function getReaderModeForTab(tabId: number): boolean {
	return readerModeState[tabId] ?? false;
}

function isReaderPageUrl(url: string | undefined): string | null {
	if (!url) return null;
	const readerPagePrefix = browser.runtime.getURL('reader.html');
	if (url.startsWith(readerPagePrefix)) {
		try {
			const parsed = new URL(url);
			return parsed.searchParams.get('url');
		} catch {}
	}
	return null;
}

async function exitReaderPageIfNeeded(tabId: number, readerUrl?: string): Promise<boolean> {
	let originalUrl: string | null = null;
	try {
		const tab = await browser.tabs.get(tabId);
		originalUrl = isReaderPageUrl(tab.url);
	} catch {}

	// Fallback: the embedded clipper passes the reader URL when
	// tabs.get() can't access the extension page URL
	if (!originalUrl && readerUrl) {
		originalUrl = isReaderPageUrl(readerUrl);
	}

	if (originalUrl) {
		await browser.tabs.update(tabId, { url: originalUrl });
		readerModeState[tabId] = false;
		debouncedUpdateContextMenu(tabId);
		return true;
	}
	return false;
}

async function initialize() {
	try {
		// Set up tab listeners
		await setupTabListeners();

		browser.tabs.onRemoved.addListener((tabId) => {
			delete highlighterModeState[tabId];
			delete readerModeState[tabId];
		});
		
		// Initialize context menu
		await debouncedUpdateContextMenu(-1);

		// Enable Origin header for YouTube innertube API requests
		await enableYouTubeInnertubeRule();

		// Set up action popup based on openBehavior setting
		await updateActionPopup();

		debugLog('Clipper', 'Background script initialized successfully');
	} catch (error) {
		console.error('Error initializing background script:', error);
	}
}

// Check if a popup is open for a given tab
function isPopupOpen(tabId: number): boolean {
	return popupPorts.hasOwnProperty(tabId);
}

browser.runtime.onConnect.addListener((port) => {
	if (port.name === 'popup') {
		const tabId = port.sender?.tab?.id;
		if (tabId) {
			popupPorts[tabId] = port;
			port.onDisconnect.addListener(() => {
				delete popupPorts[tabId];
			});
		}
	}
});

async function sendMessageToPopup(tabId: number, message: any): Promise<void> {
	if (isPopupOpen(tabId)) {
		try {
			await popupPorts[tabId].postMessage(message);
		} catch (error) {
			console.warn(`Error sending message to popup for tab ${tabId}:`, error);
		}
	}
}



// Safari: route fetch through native messaging (URLSession in Swift).
// Called from the background script where sendNativeMessage works reliably.
async function nativeFetch(url: string, options?: any): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
	try {
		const result = await browser.runtime.sendNativeMessage('application.id', {
			type: 'fetchRequest',
			url,
			method: options?.method || 'GET',
			headers: options?.headers || {},
			body: options?.body || null,
		}) as { ok: boolean; status: number; text: string; error?: string };
		return result || { ok: false, status: 0, text: '', error: 'Empty native response' };
	} catch (err) {
		return { ok: false, status: 0, text: '', error: (err as Error).message };
	}
}

// Fetch proxy for extension pages (reader, highlights).
// Returns a Promise for the webextension-polyfill.
// On Firefox MV3, host_permissions require explicit user grant —
// callers detect CORS_PERMISSION_NEEDED and prompt via permissions.request().
browser.runtime.onMessage.addListener((request: unknown) => {
	if (typeof request !== 'object' || request === null) return;
	if ((request as any).action !== 'fetchProxy') return;
	const { url, options } = request as { url: string; options?: any };
	const fetchOptions: RequestInit = {};
	if (options?.method) fetchOptions.method = options.method;
	if (options?.headers) fetchOptions.headers = options.headers;
	if (options?.body) fetchOptions.body = options.body;
	return fetch(url, fetchOptions)
		.then(async (resp) => {
			const text = await resp.text();
			// If YouTube returns bot-detection HTML, try native messaging (Safari)
			if (!resp.ok && (text.includes('Sorry') || text.includes('<html')) && typeof browser.runtime.sendNativeMessage === 'function') {
				return nativeFetch(url, options);
			}
			return { ok: resp.ok, status: resp.status, text, finalUrl: resp.url };
		})
		.catch(async () => {
			// CORS failure — try native messaging (Safari), else report permission needed
			if (typeof browser.runtime.sendNativeMessage === 'function') {
				return nativeFetch(url, options);
			}
			return { ok: false, status: 0, text: '', error: 'CORS_PERMISSION_NEEDED' };
		});
});

browser.runtime.onMessage.addListener((request: unknown, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void): true | undefined => {
	if (typeof request === 'object' && request !== null) {
		const typedRequest = request as { action: string; isActive?: boolean; hasHighlights?: boolean; tabId?: number; text?: string; section?: string; url?: string; readerUrl?: string };
		
		if (typedRequest.action === 'fetchBilibiliJsonViaMainWorld' && typedRequest.url) {
			const tabId = sender.tab?.id;
			if (!tabId) {
				sendResponse({ success: false, error: 'No tab ID' });
				return true;
			}
			fetchBilibiliJsonViaMainWorld(tabId, typedRequest.url).then((data) => {
				sendResponse({ success: true, data });
			}).catch((error) => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		if (typedRequest.action === 'copy-to-clipboard' && typedRequest.text) {
			// Use content script to copy to clipboard
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						const response = await browser.tabs.sendMessage(currentTab.id, {
							action: 'copy-text-to-clipboard',
							text: typedRequest.text
						});
						if ((response as any) && (response as any).success) {
							sendResponse({success: true});
						} else {
							sendResponse({success: false, error: 'Failed to copy from content script'});
						}
					} catch (err) {
						sendResponse({ success: false, error: (err as Error).message });
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		// fetchProxy is handled by a separate listener below

		if (typedRequest.action === "extractContent" && sender.tab && sender.tab.id) {
			browser.tabs.sendMessage(sender.tab.id, request).then(sendResponse);
			return true;
		}

		if (typedRequest.action === "ensureContentScriptLoaded") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				ensureContentScriptLoadedInBackground(tabId)
					.then(() => sendResponse({ success: true }))
					.catch((error) => sendResponse({ 
						success: false, 
						error: error instanceof Error ? error.message : String(error) 
					}));
				return true;
			} else {
				sendResponse({ success: false, error: 'No tab ID provided' });
				return true;
			}
		}

		if (typedRequest.action === "enableYouTubeEmbedRule") {
			const tabId = sender.tab?.id;
			if (tabId) {
				enableYouTubeEmbedRule(tabId).then(() => {
					sendResponse({ success: true });
				}).catch(() => {
					sendResponse({ success: true });
				});
			} else {
				sendResponse({ success: true });
			}
			return true;
		}

		if (typedRequest.action === "disableYouTubeEmbedRule") {
			disableYouTubeEmbedRule().then(() => {
				sendResponse({ success: true });
			}).catch(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (typedRequest.action === "enableBilibiliEmbedRule") {
			const tabId = sender.tab?.id;
			if (tabId) {
				enableBilibiliEmbedRule(tabId).then(() => {
					sendResponse({ success: true });
				}).catch(() => {
					sendResponse({ success: true });
				});
			} else {
				sendResponse({ success: true });
			}
			return true;
		}

		if (typedRequest.action === "disableBilibiliEmbedRule") {
			disableBilibiliEmbedRule().then(() => {
				sendResponse({ success: true });
			}).catch(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (typedRequest.action === 'fetchBilibiliJson' && typedRequest.url) {
			fetchBilibiliJson(typedRequest.url).then((data) => {
				sendResponse({ success: true, data });
			}).catch((error) => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		if (typedRequest.action === 'fetchFeishuApi' && typedRequest.url) {
			const options = (typedRequest as any).options as { method?: string; body?: string; headers?: Record<string, string> } | undefined;
			fetchFeishuApi(typedRequest.url, options).then((data) => {
				sendResponse({ success: true, data });
			}).catch((error) => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		if (typedRequest.action === 'getFeishuApiHost') {
			const tabId = sender.tab?.id;
			if (!tabId) {
				sendResponse({ success: false, apiHost: '' });
				return true;
			}
			// Use chrome.scripting (world: MAIN) to read window.local.apiHost,
			// which is set by the Feishu app and gives the correct internal API base.
			// This bypasses the page CSP that blocks inline <script> injection.
			chrome.scripting.executeScript({
				target: { tabId },
				world: 'MAIN',
				func: () => ((window as any).local?.apiHost as string) || '',
			}).then((results) => {
				const apiHost = (results?.[0]?.result as string) || '';
				sendResponse({ success: true, apiHost });
			}).catch(() => {
				sendResponse({ success: true, apiHost: '' });
			});
			return true;
		}

		if (typedRequest.action === 'fetchFeishuImagesViaMainWorld') {
			const tabId = sender.tab?.id;
			if (!tabId) {
				sendResponse({ success: false, error: 'No tab ID' });
				return true;
			}
			const apiBase = (typedRequest as any).apiBase as string;
			const tokenToCode = (typedRequest as any).tokenToCode as Record<string, string>;
			if (!apiBase || !tokenToCode) {
				sendResponse({ success: false, error: 'Missing apiBase or tokenToCode' });
				return true;
			}
			// Run image resolution in the page's MAIN world so we can use Feishu's
			// runtime PageMain/imageManager APIs before falling back to copy_out.
			// IMPORTANT: must use plain Promise chains, NOT async/await — TypeScript compiles
			// async/await to __awaiter which is not available in the injected page context.
			chrome.scripting.executeScript({
				target: { tabId },
				world: 'MAIN',
				func: (apiBase: string, tokenToCode: Record<string, string>) => {
					const results: Record<string, string> = {};
					const tokens = Object.keys(tokenToCode);

					const fetchDataUrl = function(url: string): Promise<string | undefined> {
						return fetch(url).then(function(res: Response) {
							if (!res.ok) return undefined;
							const contentType = res.headers.get('Content-Type') || '';
							if (contentType.indexOf('application/json') !== -1 || contentType.indexOf('text/') !== -1) {
								return undefined;
							}
							const mimeType = contentType.split(';')[0].trim() || 'image/png';
							return res.arrayBuffer().then(function(buf: ArrayBuffer) {
								const bytes = new Uint8Array(buf);
								let bin = '';
								for (let i = 0; i < bytes.byteLength; i++) {
									bin += String.fromCharCode(bytes[i]);
								}
								return 'data:' + mimeType + ';base64,' + btoa(bin);
							});
						}).catch(function() {
							return undefined;
						});
					};

					const runtimeImageBlocks: Array<{ token: string; block: any }> = [];
					try {
						const rootBlock = (window as any).PageMain?.blockManager?.rootBlockModel;
						const seen = new Set<any>();
						const walk = function(block: any) {
							if (!block || seen.has(block) || seen.size > 500) return;
							seen.add(block);
							const imageToken = block?.snapshot?.image?.token;
							if (imageToken && block?.imageManager?.fetch) {
								runtimeImageBlocks.push({ token: imageToken, block });
							}
							const children = Array.isArray(block.children) ? block.children : [];
							for (let i = 0; i < children.length; i++) walk(children[i]);
						};
						walk(rootBlock);
					} catch {
						// Fall through to copy_out fallback.
					}

					return runtimeImageBlocks
						.filter(function(item) { return tokens.indexOf(item.token) !== -1; })
						.reduce(function(chain, item) {
							return chain.then(function() {
								return new Promise<void>(function(resolve) {
									try {
										item.block.imageManager.fetch(
											{ token: item.token, isHD: true, fuzzy: false },
											{},
											function(sources: any) {
												const sourceUrl = sources?.originSrc || sources?.src || '';
												if (!sourceUrl) {
													resolve();
													return;
												}
												fetchDataUrl(sourceUrl).then(function(dataUrl) {
													if (dataUrl) results[item.token] = dataUrl;
													resolve();
												});
											}
										).catch(function() {
											resolve();
										});
									} catch {
										resolve();
									}
								});
							});
						}, Promise.resolve() as Promise<void | undefined>)
						.then(function() {
							if (Object.keys(results).length > 0) {
								return { success: true as const, results };
							}

							const csrfMatch = /(?:^|;)\s*_csrf_token=([^;]+)/.exec(document.cookie);
							const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : '';
							return fetch(apiBase + '/api/docx/resources/copy_out', {
								method: 'POST',
								headers: { 'X-Csrftoken': csrf },
								body: JSON.stringify({ tokens: tokenToCode }),
							})
							.then(function(res: Response) { return res.json(); })
							.then(function(data: any): Promise<{ success: true; results: Record<string, string> }> | { success: true; results: Record<string, string> } {
								if (data.code !== 0) {
									throw new Error('copy_out code=' + data.code);
								}
								return tokens.reduce(function(chain, token) {
									return chain.then(function() {
										const code = tokenToCode[token];
										return fetchDataUrl(
											apiBase + '/api/box/stream/download/asynccode/?code=' + encodeURIComponent(code)
										).then(function(dataUrl) {
											if (dataUrl) results[token] = dataUrl;
										});
									});
								}, Promise.resolve() as Promise<void | undefined>)
								.then(function() {
									return { success: true as const, results };
								});
							})
							.catch(function(err: unknown) {
								return { success: false as const, error: String(err) };
							});
						});
				},
				args: [apiBase, tokenToCode],
			}).then((scriptResults) => {
				const result = scriptResults?.[0]?.result as { success: boolean; error?: string; results?: Record<string, string> } | undefined;
				sendResponse(result ?? { success: false, error: 'No script result' });
			}).catch((err) => {
				sendResponse({ success: false, error: String(err) });
			});
			return true;
		}

		if (typedRequest.action === 'fetchScysImagesViaMainWorld') {
			const tabId = sender.tab?.id;
			if (!tabId) {
				sendResponse({ success: false, error: 'No tab ID' });
				return true;
			}
			const urls = (typedRequest as any).urls as string[];
			if (!Array.isArray(urls) || urls.length === 0) {
				sendResponse({ success: false, error: 'Missing urls' });
				return true;
			}
			// IMPORTANT: Promise chains only — no async/await in injected MAIN-world function
			// (no __awaiter polyfill is available in page runtime).
			chrome.scripting.executeScript({
				target: { tabId },
				world: 'MAIN',
				func: (urls: string[]) => {
					const results: Record<string, string> = {};
					const fetchOne = function(url: string): Promise<void> {
						return fetch(url, { credentials: 'include' }).then(function(res: Response) {
							if (!res.ok) return;
							const mime = (res.headers.get('Content-Type') || 'image/png').split(';')[0].trim();
							return res.arrayBuffer().then(function(buf: ArrayBuffer) {
								const bytes = new Uint8Array(buf);
								let bin = '';
								for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
								results[url] = 'data:' + mime + ';base64,' + btoa(bin);
							});
						}).catch(function() { /* ignore */ });
					};
					return urls.reduce(function(chain: Promise<void>, u: string) {
						return chain.then(function() { return fetchOne(u); });
					}, Promise.resolve()).then(function() {
						return { success: true as const, results };
					});
				},
				args: [urls],
			}, (injection: any) => {
				const out = injection?.[0]?.result;
				if (out?.success) sendResponse(out);
				else sendResponse({ success: false, error: 'executeScript no result' });
			});
			return true;
		}

		if (typedRequest.action === 'fetchFeishuImage') {
			const fileToken = (typedRequest as any).fileToken as string;
			if (!fileToken) {
				sendResponse({ success: false, error: 'Missing fileToken' });
				return true;
			}
			fetchFeishuImageAsBase64(fileToken).then((result) => {
				sendResponse({ success: true, dataUrl: result.dataUrl });
			}).catch((error) => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		if (typedRequest.action === "sidePanelOpened") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.add(sender.tab.windowId);
				updateCurrentActiveTab(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "sidePanelClosed") {
			if (sender.tab && sender.tab.windowId) {
				sidePanelOpenWindows.delete(sender.tab.windowId);
			}
		}

		if (typedRequest.action === "highlighterModeChanged" && sender.tab && typedRequest.isActive !== undefined) {
			const tabId = sender.tab.id;
			if (tabId) {
				highlighterModeState[tabId] = typedRequest.isActive;
				sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: typedRequest.isActive });
				debouncedUpdateContextMenu(tabId);
			}
		}

		if (typedRequest.action === "readerModeChanged" && sender.tab && typedRequest.isActive !== undefined) {
			const tabId = sender.tab.id;
			if (tabId) {
				readerModeState[tabId] = typedRequest.isActive;
				debouncedUpdateContextMenu(tabId);
			}
		}

		if (typedRequest.action === "highlightsCleared" && sender.tab) {
			hasHighlights = false;
			debouncedUpdateContextMenu(sender.tab.id!);
		}

		if (typedRequest.action === "updateHasHighlights" && sender.tab && typedRequest.hasHighlights !== undefined) {
			hasHighlights = typedRequest.hasHighlights;
			debouncedUpdateContextMenu(sender.tab.id!);
		}

		if (typedRequest.action === "getHighlighterMode") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				sendResponse({ isActive: getHighlighterModeForTab(tabId) });
			} else {
				sendResponse({ isActive: false });
			}
			return true;
		}

		if (typedRequest.action === "getReaderMode") {
			const tabId = typedRequest.tabId || sender.tab?.id;
			if (tabId) {
				sendResponse({ isActive: getReaderModeForTab(tabId) });
			} else {
				sendResponse({ isActive: false });
			}
			return true;
		}

		if (typedRequest.action === "toggleHighlighterMode" && typedRequest.tabId) {
			toggleHighlighterMode(typedRequest.tabId)
				.then(newMode => sendResponse({ success: true, isActive: newMode }))
				.catch(error => sendResponse({ success: false, error: error.message }));
			return true;
		}

		if (typedRequest.action === "openPopup") {
			openPopup()
				.then(() => {
					sendResponse({ success: true });
				})
				.catch((error: unknown) => {
					console.error('Error opening popup in background script:', error);
					sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
				});
			return true;
		}

		if (typedRequest.action === "toggleReaderMode" && typedRequest.tabId) {
			const tabId = typedRequest.tabId;
			// Check if the tab is on the extension's reader.html page
			exitReaderPageIfNeeded(tabId, typedRequest.readerUrl).then((wasReaderPage) => {
				if (wasReaderPage) {
					sendResponse({ success: true, isActive: false });
					return;
				}
				injectReaderScript(tabId).then(() => {
					browser.tabs.sendMessage(tabId, { action: "toggleReaderMode" })
						.then((response: any) => {
							if (response?.success) {
								readerModeState[tabId] = response.isActive ?? false;
								debouncedUpdateContextMenu(tabId);
							}
							sendResponse(response);
						})
						.catch(() => {
							// Page may have reloaded before responding (reader restore)
							sendResponse({ success: true, isActive: false });
						});
				});
			});
			return true;
		}

		if (typedRequest.action === "getActiveTabAndToggleIframe") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				const currentTab = tabs[0];
				if (currentTab && currentTab.id) {
					try {
						await routeMessageToTab(currentTab.id, { action: "toggle-iframe" });
						sendResponse({success: true});
					} catch (error) {
						console.error('Error sending toggle-iframe message:', error);
						sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
					}
				} else {
					sendResponse({success: false, error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "toggleIframe") {
			const tab = sender.tab;
			if (tab?.id) {
				routeMessageToTab(tab.id, { action: "toggle-iframe" })
					.then(() => sendResponse({ success: true }))
					.catch((error) => {
						console.error('Error toggling iframe:', error);
						sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
					});
			} else {
				sendResponse({ success: false, error: 'Cannot open iframe on this page' });
			}
			return true;
		}

		if (typedRequest.action === "getActiveTab") {
			browser.tabs.query({active: true, currentWindow: true}).then(async (tabs) => {
				let currentTab = tabs[0];
				// Fallback for when currentWindow has no tabs (e.g., debugging popup in DevTools)
				if (!currentTab || !currentTab.id) {
					const allActiveTabs = await browser.tabs.query({active: true});
					currentTab = allActiveTabs.find(tab =>
						tab.id && tab.url && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('moz-extension://')
					) || allActiveTabs[0];
				}
				if (currentTab && currentTab.id) {
					sendResponse({tabId: currentTab.id});
				} else {
					sendResponse({error: 'No active tab found'});
				}
			});
			return true;
		}

		if (typedRequest.action === "openOptionsPage") {
			try {
				if (typeof browser.runtime.openOptionsPage === 'function') {
					// Chrome way
					browser.runtime.openOptionsPage();
				} else {
					// Firefox way
					browser.tabs.create({
						url: browser.runtime.getURL('settings.html')
					});
				}
				sendResponse({success: true});
			} catch (error) {
				console.error('Error opening options page:', error);
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "openHighlights") {
			const domain = (typedRequest as any).domain;
			const query = domain ? `?domain=${encodeURIComponent(domain)}` : '';
			browser.tabs.create({ url: browser.runtime.getURL(`highlights.html${query}`) });
			sendResponse({ success: true });
			return true;
		}

		if (typedRequest.action === "openSettings") {
			try {
				const section = typedRequest.section ? `?section=${typedRequest.section}` : '';
				browser.tabs.create({
					url: browser.runtime.getURL(`settings.html${section}`)
				});
				sendResponse({success: true});
			} catch (error) {
				console.error('Error opening settings:', error);
				sendResponse({success: false, error: error instanceof Error ? error.message : String(error)});
			}
			return true;
		}

		if (typedRequest.action === "copyMarkdownToClipboard" || typedRequest.action === "saveMarkdownToFile") {
			if (sender.tab?.id) {
				routeMessageToTab(sender.tab.id, { action: typedRequest.action })
					.then(() => sendResponse({success: true}))
					.catch((error) => sendResponse({success: false, error: error instanceof Error ? error.message : String(error)}));
				return true;
			}
		}

		if (typedRequest.action === "getTabInfo") {
			browser.tabs.get(typedRequest.tabId as number).then((tab) => {
				// For reader page tabs, return the article URL so the
				// clipper treats it as a normal web page
				const url = isReaderPageUrl(tab.url) ?? tab.url;
				sendResponse({
					success: true,
					tab: {
						id: tab.id,
						url: url
					}
				});
			}).catch((error) => {
				console.error('Error getting tab info:', error);
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}

		if (typedRequest.action === "forceInjectContentScript") {
			const tabId = typedRequest.tabId;
			if (tabId) {
				injectContentScript(tabId)
					.then(() => sendResponse({ success: true }))
					.catch((error) => {
						console.error('[Obsidian Clipper] forceInjectContentScript failed:', error);
						sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
					});
				return true;
			} else {
				sendResponse({ success: false, error: 'Missing tabId' });
				return true;
			}
		}

		if (typedRequest.action === "sendMessageToTab") {
			const tabId = (typedRequest as any).tabId;
			const message = (typedRequest as any).message;
			if (tabId && message) {
				routeMessageToTab(tabId, message).then((response) => {
					sendResponse(response);
				}).catch((error) => {
					console.error('[Obsidian Clipper] Error sending message to tab:', error);
					sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					});
				});
				return true;
			} else {
				sendResponse({
					success: false,
					error: 'Missing tabId or message'
				});
				return true;
			}
		}

		if (typedRequest.action === "openReaderPage") {
			const articleUrl = (typedRequest as any).url;
			if (articleUrl && sender.tab?.id) {
				const readerUrl = browser.runtime.getURL('reader.html?url=' + encodeURIComponent(articleUrl));
				browser.tabs.update(sender.tab.id, { url: readerUrl })
					.then(() => sendResponse({ success: true }))
					.catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
			} else {
				sendResponse({ success: false, error: 'Missing URL or tab' });
			}
			return true;
		}

		if (typedRequest.action === "openObsidianUrl") {
			const url = (typedRequest as any).url;
			if (url) {
				browser.tabs.query({active: true, currentWindow: true}).then((tabs) => {
					const currentTab = tabs[0];
					if (currentTab && currentTab.id) {
						browser.tabs.update(currentTab.id, { url: url }).then(() => {
							sendResponse({ success: true });
						}).catch((error) => {
							console.error('Error opening Obsidian URL:', error);
							sendResponse({
								success: false,
								error: error instanceof Error ? error.message : String(error)
							});
						});
					} else {
						sendResponse({
							success: false,
							error: 'No active tab found'
						});
					}
				}).catch((error) => {
					console.error('Error querying tabs:', error);
					sendResponse({
						success: false,
						error: error instanceof Error ? error.message : String(error)
					});
				});
				return true;
			} else {
				sendResponse({
					success: false,
					error: 'Missing URL'
				});
				return true;
			}
		}

		// For other actions that use sendResponse
		if (typedRequest.action === "extractContent" ||
			typedRequest.action === "ensureContentScriptLoaded" ||
			typedRequest.action === "getHighlighterMode" ||
			typedRequest.action === "toggleHighlighterMode" ||
			typedRequest.action === "openObsidianUrl" ||
			typedRequest.action === 'fetchBilibiliJson' ||
			typedRequest.action === 'fetchFeishuApi' ||
			typedRequest.action === 'fetchFeishuImage' ||
			typedRequest.action === 'fetchScysImagesViaMainWorld') {
			return true;
		}
	}
	return undefined;
});

browser.commands.onCommand.addListener(async (command, tab) => {
	// Some browsers (e.g. Orion) don't pass the tab parameter, so fall back to querying
	if (!tab?.id) {
		const tabs = await browser.tabs.query({active: true, currentWindow: true});
		tab = tabs[0];
	}

	if (command === 'quick_clip') {
		if (tab?.id) {
			openPopup();
			setTimeout(() => {
				browser.runtime.sendMessage({action: "triggerQuickClip"})
					.catch(error => console.error("Failed to send quick clip message:", error));
			}, 500);
		}
	}
	if (command === "toggle_highlighter" && tab?.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		toggleHighlighterMode(tab.id);
	}
	if (command === "copy_to_clipboard" && tab?.id) {
		await browser.tabs.sendMessage(tab.id, { action: "copyToClipboard" });
	}
	if (command === "toggle_reader" && tab?.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await injectReaderScript(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "toggleReaderMode" });
	}
});

const debouncedUpdateContextMenu = debounce(async (tabId: number) => {
	if (isContextMenuCreating) {
		return;
	}
	isContextMenuCreating = true;

	try {
		await browser.contextMenus.removeAll();

		let currentTabId = tabId;
		if (currentTabId === -1) {
			const tabs = await browser.tabs.query({ active: true, currentWindow: true });
			if (tabs.length > 0) {
				currentTabId = tabs[0].id!;
			}
		}

		const isHighlighterMode = getHighlighterModeForTab(currentTabId);
		const isReaderMode = getReaderModeForTab(currentTabId);

		const menuItems: {
			id: string;
			title: string;
			contexts: browser.Menus.ContextType[];
		}[] = [
				{
					id: "open-obsidian-clipper",
					title: "Save this page",
					contexts: ["page", "selection", "image", "video", "audio"]
				},
				{
					id: 'copy-markdown-to-clipboard',
					title: browser.i18n.getMessage('copyToClipboard'),
					contexts: ["page", "selection"]
				},
				{
					id: isReaderMode ? "exit-reader" : "enter-reader",
					title: isReaderMode ? browser.i18n.getMessage('disableReader') : browser.i18n.getMessage('readerOn'),
					contexts: ["page", "selection"]
				},
				{
					id: isHighlighterMode ? "exit-highlighter" : "enter-highlighter",
					title: isHighlighterMode ? browser.i18n.getMessage('disableHighlighter') : browser.i18n.getMessage('highlighterOn'),
					contexts: ["page","image", "video", "audio"]
				},
				{
					id: "highlight-selection",
					title: "Add to highlights",
					contexts: ["selection"]
				},
				{
					id: "highlight-element",
					title: "Add to highlights",
					contexts: ["image", "video", "audio"]
				},
				{
					id: 'open-embedded',
					title: browser.i18n.getMessage('openEmbedded'),
					contexts: ["page", "selection"]
				}
			];

		const browserType = await detectBrowser();
		if (browserType === 'chrome') {
			menuItems.push({
				id: 'open-side-panel',
				title: browser.i18n.getMessage('openSidePanel'),
				contexts: ["page", "selection"]
			});
		}

		for (const item of menuItems) {
			await browser.contextMenus.create(item);
		}
	} catch (error) {
		console.error('Error updating context menu:', error);
	} finally {
		isContextMenuCreating = false;
	}
}, 100); // 100ms debounce time

browser.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId === "open-obsidian-clipper") {
		openPopup();
	} else if (info.menuItemId === "enter-highlighter" && tab && tab.id) {
		await setHighlighterMode(tab.id, true);
	} else if (info.menuItemId === "exit-highlighter" && tab && tab.id) {
		await setHighlighterMode(tab.id, false);
	} else if (info.menuItemId === "highlight-selection" && tab && tab.id) {
		await highlightSelection(tab.id, info);
	} else if (info.menuItemId === "highlight-element" && tab && tab.id) {
		await highlightElement(tab.id, info);
	} else if ((info.menuItemId === "enter-reader" || info.menuItemId === "exit-reader") && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await injectReaderScript(tab.id);
		const response = await browser.tabs.sendMessage(tab.id, { action: "toggleReaderMode" }) as { success?: boolean; isActive?: boolean };
		if (response?.success) {
			readerModeState[tab.id] = response.isActive ?? false;
			debouncedUpdateContextMenu(tab.id);
		}
	} else if (info.menuItemId === 'open-embedded' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "toggle-iframe" });
	} else if (info.menuItemId === 'open-side-panel' && tab && tab.id && tab.windowId) {
		chrome.sidePanel.open({ tabId: tab.id });
		sidePanelOpenWindows.add(tab.windowId);
		await ensureContentScriptLoadedInBackground(tab.id);
	} else if (info.menuItemId === 'copy-markdown-to-clipboard' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "copyMarkdownToClipboard" });
	}
});

browser.runtime.onInstalled.addListener(() => {
	debouncedUpdateContextMenu(-1); // Use a dummy tabId for initial creation
});

async function isSidePanelOpen(windowId: number): Promise<boolean> {
	return sidePanelOpenWindows.has(windowId);
}

async function setupTabListeners() {
	const browserType = await detectBrowser();
	if (['chrome', 'brave', 'edge'].includes(browserType)) {
		browser.tabs.onActivated.addListener(handleTabChange);
		browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.status === 'complete') {
				handleTabChange({ tabId, windowId: tab.windowId });
			}
		});
	}
}

const debouncedPaintHighlights = debounce(async (tabId: number) => {
	if (!getHighlighterModeForTab(tabId)) {
		await setHighlighterMode(tabId, false);
	}
	await paintHighlights(tabId);
}, 250);

async function handleTabChange(activeInfo: { tabId: number; windowId?: number }) {
	if (activeInfo.windowId && await isSidePanelOpen(activeInfo.windowId)) {
		updateCurrentActiveTab(activeInfo.windowId);
		await debouncedPaintHighlights(activeInfo.tabId);
	}
}

async function paintHighlights(tabId: number) {
	try {
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url || !isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		await ensureContentScriptLoadedInBackground(tabId);
		await browser.tabs.sendMessage(tabId, { action: "paintHighlights" });

	} catch (error) {
		console.error('Error painting highlights:', error);
	}
}

async function setHighlighterMode(tabId: number, activate: boolean) {
	try {
		// First, check if the tab exists
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url) {
			return;
		}

		// Check if the URL is valid and not a blank page
		if (!isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		// Then, ensure the content script is loaded
		await ensureContentScriptLoadedInBackground(tabId);

		// Now try to send the message
		highlighterModeState[tabId] = activate;
		await browser.tabs.sendMessage(tabId, { action: "setHighlighterMode", isActive: activate });
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: activate });

	} catch (error) {
		console.error('Error setting highlighter mode:', error);
		// If there's an error, assume highlighter mode should be off
		highlighterModeState[tabId] = false;
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: false });
	}
}

async function toggleHighlighterMode(tabId: number): Promise<boolean> {
	try {
		const currentMode = getHighlighterModeForTab(tabId);
		const newMode = !currentMode;
		highlighterModeState[tabId] = newMode;
		await browser.tabs.sendMessage(tabId, { action: "setHighlighterMode", isActive: newMode });
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: "updatePopupHighlighterUI", isActive: newMode });
		return newMode;
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		throw error;
	}
}

async function highlightSelection(tabId: number, info: browser.Menus.OnClickData) {
	highlighterModeState[tabId] = true;
	
	const highlightData: Partial<TextHighlightData> = {
		id: Date.now().toString(),
		type: 'text',
		content: info.selectionText || '',
	};

	await browser.tabs.sendMessage(tabId, { 
		action: "highlightSelection", 
		isActive: true,
		highlightData,
	});
	hasHighlights = true;
	debouncedUpdateContextMenu(tabId);
}

async function highlightElement(tabId: number, info: browser.Menus.OnClickData) {
	highlighterModeState[tabId] = true;

	await browser.tabs.sendMessage(tabId, { 
		action: "highlightElement", 
		isActive: true,
		targetElementInfo: {
			mediaType: info.mediaType === 'image' ? 'img' : info.mediaType,
			srcUrl: info.srcUrl,
			pageUrl: info.pageUrl
		}
	});
	hasHighlights = true;
	debouncedUpdateContextMenu(tabId);
}

async function injectReaderScript(tabId: number) {
	try {
		await browser.scripting.insertCSS({
			target: { tabId },
			files: ['reader.css']
		});
		await browser.scripting.insertCSS({
			target: { tabId },
			files: ['highlighter.css']
		}).catch(() => {});

		// Inject scripts in sequence for all browsers
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['browser-polyfill.min.js']
		});
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['reader-script.js']
		});

		return true;
	} catch (error) {
		console.error('Error injecting reader script:', error);
		return false;
	}
}

// When set to 'reader' or 'embedded', clear the popup so action.onClicked fires
// instead, handling the action directly without briefly opening the popup.
const validOpenBehaviors: Settings['openBehavior'][] = ['popup', 'embedded', 'reader'];

function parseOpenBehavior(raw: string | undefined): Settings['openBehavior'] {
	return validOpenBehaviors.includes(raw as Settings['openBehavior']) ? raw as Settings['openBehavior'] : 'popup';
}

async function updateActionPopup(openBehavior?: Settings['openBehavior']): Promise<void> {
	if (!openBehavior) {
		const data = await browser.storage.sync.get('general_settings');
		openBehavior = parseOpenBehavior((data.general_settings as Record<string, string>)?.openBehavior);
	}
	currentOpenBehavior = openBehavior;
	if (openBehavior === 'reader' || openBehavior === 'embedded') {
		await browser.action.setPopup({ popup: '' });
	} else {
		await browser.action.setPopup({ popup: 'popup.html' });
	}
}

let currentOpenBehavior: Settings['openBehavior'] = 'popup';

// In reader/embedded mode, opens embedded iframe instead of popup.
async function openPopup(): Promise<void> {
	if (currentOpenBehavior === 'reader' || currentOpenBehavior === 'embedded') {
		const tabs = await browser.tabs.query({ active: true, currentWindow: true });
		const tab = tabs[0];
		if (tab?.id && tab.url && isValidUrl(tab.url) && !isBlankPage(tab.url)) {
			await ensureContentScriptLoadedInBackground(tab.id);
			await browser.tabs.sendMessage(tab.id, { action: "toggle-iframe" });
			return;
		}
		// Fall through to popup if tab is invalid
	}
	await browser.action.openPopup();
}

browser.action.onClicked.addListener(async (tab) => {
	if (!tab?.id || !tab.url || !isValidUrl(tab.url) || isBlankPage(tab.url)) return;

	if (currentOpenBehavior === 'reader') {
		await ensureContentScriptLoadedInBackground(tab.id);
		await injectReaderScript(tab.id);
		const response = await browser.tabs.sendMessage(tab.id, { action: "toggleReaderMode" }) as { success?: boolean; isActive?: boolean };
		if (response?.success) {
			readerModeState[tab.id] = response.isActive ?? false;
			debouncedUpdateContextMenu(tab.id);
		}
	} else if (currentOpenBehavior === 'embedded') {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: "toggle-iframe" });
	}
});

browser.storage.onChanged.addListener((changes, area) => {
	if (area === 'sync' && changes.general_settings) {
		updateActionPopup(parseOpenBehavior((changes.general_settings.newValue as Record<string, string>)?.openBehavior));
	}
});

// Initialize the extension
initialize().catch(error => {
	console.error('Failed to initialize background script:', error);
});
