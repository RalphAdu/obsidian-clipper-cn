import browser from './utils/browser-polyfill';
import * as highlighter from './utils/highlighter';
import { removeExistingHighlights } from './utils/highlighter-overlays';
import { loadSettings, generalSettings } from './utils/storage-utils';
import { getDomain, normalizeImageSources } from './utils/string-utils';
import { extractContentBySelector as extractContentBySelectorShared } from './utils/shared';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { flattenShadowDom } from './utils/flatten-shadow-dom';
import { serializeChildren } from './utils/dom-utils';
import { saveFile } from './utils/file-utils';
import { debugLog } from './utils/debug';
import { createLogger } from './utils/logger';
import { extractBilibiliStructuredContent, isBilibiliVideoUrl } from './utils/bilibili-extractor';
import { extractFeishuStructuredContent, isFeishuDocUrl } from './utils/feishu-extractor';
import { extractScysStructuredContent, isScysCourseUrl, isScysDocxUrl, isScysArticleUrl } from './utils/scys-extractor';
import { extractZsxqStructuredContent, isZsxqTopicUrl, isZsxqArticleUrl, isZsxqArticlesHtmlUrl } from './utils/zsxq-extractor';
import { extractDocsQQContent, isDocsQQDocUrl, parseDocsQQUrl } from './utils/docs-qq-extractor';
import {
	extractWeChatPublishedFromDocument,
	normalizePreBlockLineBreaks,
	normalizeMdniceArticle,
} from './utils/weixin-helpers';
import { postProcessExtractorMarkdown } from './utils/markdown-post-process';
import type { Attachment } from './utils/attachment-types';
import { updateSidebarWidth, addResizeHandle, cleanupResizeHandlers } from './utils/iframe-resize';

const contentLogger = createLogger('Content');

declare global {
	interface Window {
		obsidianClipperGeneration?: number;
	}
}

// IIFE to scope variables and allow safe re-execution
(function() {
	// Bump the generation counter on every injection. Older listeners close
	// over their own generation value and bail out when they see a newer one,
	// so a zombie content script (runtime invalidated after extension update)
	// will silently yield to the freshly-injected instance.
	window.obsidianClipperGeneration = (window.obsidianClipperGeneration ?? 0) + 1;
	const myGeneration = window.obsidianClipperGeneration;

	debugLog('Clipper', 'Initializing content script, generation', myGeneration);

	// In Reader mode, extract from the article's original HTML (before
	// wireTranscript restructures it) with a neutral URL so site-specific
	// extractors don't re-fetch content (e.g. YouTube)
	function parseForClip(doc: Document) {
		const readerArticle = doc.querySelector('.obsidian-reader-active .obsidian-reader-content article');
		if (readerArticle) {
			const readerDoc = doc.implementation.createHTMLDocument();
			const originalHtml = readerArticle.getAttribute('data-original-html');
			readerDoc.body.innerHTML = originalHtml || readerArticle.innerHTML;
			normalizeImageSources(readerDoc);
			return new Defuddle(readerDoc, { url: '' }).parse();
		}
		normalizeImageSources(doc);
		return new Defuddle(doc, { url: doc.URL }).parse();
	}

	function isWeChatArticleUrl(url: string): boolean {
		try {
			return new URL(url).hostname === 'mp.weixin.qq.com';
		} catch {
			return false;
		}
	}

	function extractWeChatArticleContent(doc: Document): string | null {
		const article = doc.querySelector('#js_content');
		if (!article) {
			return null;
		}

		const articleClone = article.cloneNode(true) as HTMLElement;
		normalizeImageSources(articleClone as unknown as Document);
		articleClone.querySelectorAll('script, style').forEach(el => el.remove());
		normalizeMdniceArticle(articleClone);
		normalizePreBlockLineBreaks(articleClone);
		return articleClone.outerHTML;
	}

	let isHighlighterMode = false;
	const iframeId = 'obsidian-clipper-iframe';
	const containerId = 'obsidian-clipper-container';

	function removeContainer(container: HTMLElement) {
		container.classList.add('is-closing');
		updateSidebarWidth(document, null);
		cleanupResizeHandlers(document);
		container.addEventListener('animationend', () => {
			container.remove();
			highlighter.repositionHighlights();
		}, { once: true });
	}

	async function toggleIframe() {
		const existingContainer = document.getElementById(containerId);
		if (existingContainer) {
			removeContainer(existingContainer);
			return;
		}

		await ensureHighlighterCSS();

		const container = document.createElement('div');
		container.id = containerId;
		container.classList.add('is-open');

		const { clipperIframeWidth, clipperIframeHeight } = await browser.storage.local.get(['clipperIframeWidth', 'clipperIframeHeight']);
		if (clipperIframeWidth) {
			container.style.width = `${clipperIframeWidth}px`;
		}
		if (clipperIframeHeight) {
			container.style.height = `${clipperIframeHeight}px`;
		}

		const iframe = document.createElement('iframe');
		iframe.id = iframeId;
		iframe.allow = 'clipboard-write; web-share';
		iframe.src = browser.runtime.getURL('side-panel.html?context=iframe');
		container.appendChild(iframe);

		const resizeCallbacks = {
			onResize: () => highlighter.repositionHighlights(),
			onResizeEnd: () => highlighter.repositionHighlights(),
		};
		addResizeHandle(document, container, 'w', resizeCallbacks);
		addResizeHandle(document, container, 's', resizeCallbacks);
		addResizeHandle(document, container, 'sw', resizeCallbacks);

		document.body.appendChild(container);
		updateSidebarWidth(document, container);
		container.addEventListener('animationend', () => highlighter.repositionHighlights(), { once: true });
	}

	// Firefox
	browser.runtime.sendMessage({ action: "contentScriptLoaded" });

	interface ContentResponse {
		content: string;
		selectedHtml: string;
		extractedContent: { [key: string]: string };
		schemaOrgData: any;
		fullHtml: string;
		highlights: string[];
		title: string;
		description: string;
		domain: string;
		favicon: string;
		image: string;
		parseTime: number;
		published: string;
		author: string;
		site: string;
		wordCount: number;
		language: string;
		metaTags: { name?: string | null; property?: string | null; content: string | null }[];
		attachments: Attachment[];
		extractorWarnings?: string[];
	}

	browser.runtime.onMessage.addListener((request: any, sender, sendResponse) => {
		// If a newer generation of this content script has been injected,
		// yield to it rather than responding from a potentially stale context.
		if (window.obsidianClipperGeneration !== myGeneration) {
			return;
		}

		if (request.action === "ping") {
			sendResponse({});
			return true;
		}

		if (request.action === "toggle-iframe") {
			toggleIframe().then(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (request.action === "close-iframe") {
			const existingContainer = document.getElementById(containerId);
			if (existingContainer) {
				removeContainer(existingContainer);
			}
			return;
		}

		if (request.action === "copy-text-to-clipboard") {
			const textArea = document.createElement("textarea");
			textArea.value = request.text;
			document.body.appendChild(textArea);
			textArea.select();
			try {
				document.execCommand('copy');
				sendResponse({success: true});
			} catch (err) {
				sendResponse({success: false});
			}
			document.body.removeChild(textArea);
			return true;
		}

		if (request.action === "copyMarkdownToClipboard") {
			flattenShadowDom(document).then(() => {
				try {
					const defuddled = parseForClip(document);

					// Convert HTML content to markdown
					const markdown = createMarkdownContent(defuddled.content, document.URL);

					// Copy to clipboard
					const textArea = document.createElement("textarea");
					textArea.value = markdown;
					document.body.appendChild(textArea);
					textArea.select();
					document.execCommand('copy');
					document.body.removeChild(textArea);

					sendResponse({ success: true });
				} catch (err) {
					console.error('Failed to copy markdown to clipboard:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "saveMarkdownToFile") {
			flattenShadowDom(document).then(async () => {
				try {
					const defuddled = parseForClip(document);
					const markdown = createMarkdownContent(defuddled.content, document.URL);
					const title = defuddled.title || document.title || 'Untitled';
					const fileName = title.replace(/[/\\?%*:|"<>]/g, '-');
					await saveFile({
						content: markdown,
						fileName,
						mimeType: 'text/markdown',
					});
					sendResponse({ success: true });
				} catch (err) {
					console.error('Failed to save markdown file:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "getPageContent") {
			// Flatten shadow DOM before extraction (async, needs main world)
			const flattenTimeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
			Promise.race([flattenShadowDom(document), flattenTimeout]).then(async () => {
				let selectedHtml = '';
				const selection = window.getSelection();

				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0);
					const clonedSelection = range.cloneContents();
					const div = document.createElement('div');
					div.appendChild(clonedSelection);
					selectedHtml = serializeChildren(div);
				}

				// Use parseAsync to ensure async variables like {{transcript}} are available.
				// If it hangs (e.g. another extension has corrupted fetch), fall back to sync parse.
				normalizeImageSources(document);
				const defuddle = new Defuddle(document, { url: document.URL });
				const parseTimeout = new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('parseAsync timeout')), 8000)
				);
				const defuddled = await Promise.race([defuddle.parseAsync(), parseTimeout])
					.catch(() => defuddle.parse());
			const extractorWarnings: string[] = [];
			const bilibiliContent = isBilibiliVideoUrl(document.URL)
				? await extractBilibiliStructuredContent(document).catch((error) => {
					const msg = error instanceof Error ? error.message : String(error);
					contentLogger.warn('Failed to extract Bilibili structured content', { error: msg });
					extractorWarnings.push(`Bilibili: ${msg}`);
					return null;
				})
				: null;
			const feishuContent = isFeishuDocUrl(document.URL)
				? await extractFeishuStructuredContent(document).catch((error) => {
					const msg = error instanceof Error ? error.message : String(error);
					contentLogger.warn('Failed to extract Feishu structured content', { error: msg });
					extractorWarnings.push(`Feishu: ${msg}`);
					return null;
				})
				: null;
			const scysContent = (isScysCourseUrl(document.URL) || isScysDocxUrl(document.URL) || isScysArticleUrl(document.URL))
				? await extractScysStructuredContent(document).catch((error) => {
					const msg = error instanceof Error ? error.message : String(error);
					contentLogger.warn('Failed to extract scys structured content', { error: msg });
					extractorWarnings.push(`scys: ${msg}`);
					return null;
				})
				: null;
			const zsxqContent = (isZsxqTopicUrl(document.URL) || isZsxqArticleUrl(document.URL) || isZsxqArticlesHtmlUrl(document.URL))
				? await extractZsxqStructuredContent(document).catch((error) => {
					const msg = error instanceof Error ? error.message : String(error);
					contentLogger.warn('Failed to extract zsxq structured content', { error: msg });
					extractorWarnings.push(`zsxq: ${msg}`);
					return null;
				})
				: null;
			const docsQQContent = isDocsQQDocUrl(document.URL)
				? await (async () => {
					const parsed = parseDocsQQUrl(document.URL);
					if (!parsed) return null;
					return extractDocsQQContent({
						token: parsed.token,
						url: document.URL,
						doc: document,
					});
				})().catch((error) => {
					const msg = error instanceof Error ? error.message : String(error);
					contentLogger.warn('Failed to extract docs.qq structured content', { error: msg });
					extractorWarnings.push(`docs.qq: ${msg}`);
					return null;
				})
				: null;
			// Site extractor matched URL but returned null (silently — e.g. scys
			// extractScysArticleStandalone returns null on 401 instead of throwing,
			// so the .catch above doesn't fire). Surface to user explicitly.
			if (isScysArticleUrl(document.URL) && !scysContent) {
				extractorWarnings.push('scys article: extractor returned null (likely session expired — try logging in again)');
			}
			const extractedContent: { [key: string]: string } = {
				...defuddled.variables,
			};

			if (bilibiliContent) {
				extractedContent.transcript = bilibiliContent.transcriptMarkdown;
				extractedContent.transcriptMarkdown = bilibiliContent.transcriptMarkdown;
				extractedContent.transcriptText = bilibiliContent.transcriptText;
				extractedContent.chapters = bilibiliContent.chaptersMarkdown;
				extractedContent.bvid = bilibiliContent.bvid;
				extractedContent.cid = String(bilibiliContent.cid);
				extractedContent.page = String(bilibiliContent.page);
			}

			if (feishuContent?.commentsMarkdown) {
				extractedContent.commentsMarkdown = feishuContent.commentsMarkdown;
			}

			// scysContent's title/author/content/wordCount/description are already
			// surfaced via the ContentResponse cascade (line ~352-367) which feeds
			// initializePageContent → buildVariables, where {{title}}/{{author}}/
			// {{content}}/{{words}}/{{description}} are bound from params. Writing
			// them into extractedContent here would re-overwrite {{content}} with
			// raw HTML (extractedContent dict is iterated last in buildVariables
			// shared.ts:70, after content-extractor.ts:160 ran createMarkdownContent).
			// Bug 2026-05-16: Obsidian users saw raw HTML in clipped notes when
			// this block was present. See BACKLOG §X.X.

				// Create a new DOMParser
				const parser = new DOMParser();
				// Parse the document's HTML
				const doc = parser.parseFromString(document.documentElement.outerHTML, 'text/html');
				normalizeImageSources(doc);

				// Remove all script and style elements
				doc.querySelectorAll('script, style').forEach(el => el.remove());

				// Remove style attributes from all elements
				doc.querySelectorAll('*').forEach(el => el.removeAttribute('style'));

				// Convert all relative URLs to absolute
				doc.querySelectorAll('[src], [href]').forEach(element => {
					['src', 'href', 'srcset'].forEach(attr => {
						const value = element.getAttribute(attr);
						if (!value) return;

						if (attr === 'srcset') {
							const newSrcset = value.split(',').map(src => {
								const [url, size] = src.trim().split(' ');
								try {
									const absoluteUrl = new URL(url, document.baseURI).href;
									return `${absoluteUrl}${size ? ' ' + size : ''}`;
								} catch (e) {
									return src;
								}
							}).join(', ');
							element.setAttribute(attr, newSrcset);
						} else if (!value.startsWith('http') && !value.startsWith('data:') && !value.startsWith('#') && !value.startsWith('//')) {
							try {
								const absoluteUrl = new URL(value, document.baseURI).href;
								element.setAttribute(attr, absoluteUrl);
							} catch (e) {
								console.warn(`Failed to process ${attr} URL:`, value);
							}
						}
					});
				});

				// Get the modified HTML without scripts, styles, and style attributes
				const cleanedHtml = doc.documentElement.outerHTML;
				const weChatArticleContent = isWeChatArticleUrl(document.URL)
					? extractWeChatArticleContent(doc)
					: null;
				// Walk live <script> nodes' textContent — do NOT route through
				// documentElement.outerHTML. Empirical browser-runtime behavior:
				// the outerHTML serializer can omit inline <script> bodies
				// (CSP / nonce / Trusted Types vary), even though the script
				// nodes themselves are alive in the DOM. Reading textContent
				// directly is the canonical path.
				const weChatPublished = isWeChatArticleUrl(document.URL)
					? extractWeChatPublishedFromDocument(document)
					: '';

				const response: ContentResponse = {
					author: bilibiliContent?.author || feishuContent?.author || scysContent?.author || zsxqContent?.author || docsQQContent?.author || defuddled.author,
					attachments: scysContent?.attachments || [],
					content: bilibiliContent?.structuredHtml || feishuContent?.content || scysContent?.content || zsxqContent?.content || docsQQContent?.content || weChatArticleContent || defuddled.content,
					description: bilibiliContent?.description || defuddled.description,
					domain: getDomain(document.URL),
					extractedContent: extractedContent,
					favicon: defuddled.favicon,
					fullHtml: cleanedHtml,
					highlights: highlighter.getHighlights(),
					image: bilibiliContent?.image || defuddled.image,
					language: defuddled.language || '',
					parseTime: defuddled.parseTime,
					published: bilibiliContent?.published || feishuContent?.published || scysContent?.published || zsxqContent?.published || docsQQContent?.published || weChatPublished || defuddled.published,
					schemaOrgData: defuddled.schemaOrgData,
					selectedHtml: selectedHtml,
					site: bilibiliContent ? 'Bilibili' : feishuContent ? 'Feishu' : scysContent ? 'Scys' : zsxqContent ? 'ZSXQ' : docsQQContent ? 'DocsQQ' : defuddled.site,
					title: bilibiliContent?.title || feishuContent?.title || scysContent?.title || zsxqContent?.title || docsQQContent?.title || defuddled.title,
					wordCount: docsQQContent?.wordCount || bilibiliContent?.wordCount || feishuContent?.wordCount || scysContent?.wordCount || zsxqContent?.wordCount || defuddled.wordCount,
					metaTags: defuddled.metaTags || [],
					extractorWarnings: extractorWarnings.length > 0 ? extractorWarnings : undefined,
				};
				if (response.title) {
					highlighter.setPageTitle(response.title);
				}
				highlighter.updatePageDomainSettings({ site: response.site, favicon: response.favicon });
				sendResponse(response);
			}).catch((error: unknown) => {
				contentLogger.error('getPageContent error', { error: error instanceof Error ? error.message : String(error) });
				sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
			});
			return true;
		} else if (request.action === "extractContent") {
			const content = extractContentBySelector(request.selector, request.attribute, request.extractHtml);
			sendResponse({ content: content });
		} else if (request.action === "paintHighlights") {
			ensureHighlighterCSS().then(() => highlighter.loadHighlights()).then(() => {
				if (generalSettings.alwaysShowHighlights) {
					highlighter.applyHighlights();
				}
				sendResponse({ success: true });
			});
			return true;
		} else if (request.action === "setHighlighterMode") {
			isHighlighterMode = request.isActive;
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(isHighlighterMode);
			updateHasHighlights();
			sendResponse({ success: true });
			return true;
		} else if (request.action === "getHighlighterMode") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" }).then(sendResponse);
			return true;
		} else if (request.action === "toggleHighlighter") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightSelection") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed) {
				highlighter.handleTextSelection(selection);
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightElement") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			if (request.targetElementInfo) {
				const { mediaType, srcUrl, pageUrl } = request.targetElementInfo;
				
				let elementToHighlight: Element | null = null;

				// Function to compare URLs, handling both absolute and relative paths
				const urlMatches = (elementSrc: string, targetSrc: string) => {
					const elementUrl = new URL(elementSrc, pageUrl);
					const targetUrl = new URL(targetSrc, pageUrl);
					return elementUrl.href === targetUrl.href;
				};

				// Try to find the element using the src attribute
				elementToHighlight = document.querySelector(`${mediaType}[src="${srcUrl}"]`);

				// If not found, try with relative URL
				if (!elementToHighlight) {
					const relativeSrc = new URL(srcUrl).pathname;
					elementToHighlight = document.querySelector(`${mediaType}[src="${relativeSrc}"]`);
				}

				// If still not found, iterate through all elements of the media type
				if (!elementToHighlight) {
					const elements = Array.from(document.getElementsByTagName(mediaType));
					for (const el of elements) {
						if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) {
							if (urlMatches(el.src, srcUrl)) {
								elementToHighlight = el;
								break;
							}
						}
					}
				}

				if (elementToHighlight) {
					highlighter.highlightElement(elementToHighlight);
				} else {
					console.warn('Could not find element to highlight. Info:', request.targetElementInfo);
				}
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "clearHighlights") {
			highlighter.clearHighlights();
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "getHighlighterState") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" })
				.then(response => {
					sendResponse(response);
				})
				.catch(error => {
					console.error("Error getting highlighter mode:", error);
					sendResponse({ isActive: false });
				});
			return true;
		} else if (request.action === "getReaderModeState") {
			sendResponse({ isActive: document.documentElement.classList.contains('obsidian-reader-active') });
			return true;
		}
		return true;
	});

	function extractContentBySelector(selector: string, attribute?: string, extractHtml: boolean = false): string | string[] {
		return extractContentBySelectorShared(document, selector, attribute, extractHtml);
	}

	function updateHasHighlights() {
		const hasHighlights = highlighter.getHighlights().length > 0;
		browser.runtime.sendMessage({ action: "updateHasHighlights", hasHighlights });
	}

	let highlighterCSSPromise: Promise<void> | null = null;
	function ensureHighlighterCSS(): Promise<void> {
		if (!highlighterCSSPromise) {
			highlighterCSSPromise = new Promise<void>((resolve) => {
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.href = browser.runtime.getURL('highlighter.css');
				link.onload = () => resolve();
				link.onerror = () => resolve();
				(document.head || document.documentElement).appendChild(link);
			});
		}
		return highlighterCSSPromise;
	}

	async function initializeHighlighter() {
		await loadSettings();

		if (generalSettings.alwaysShowHighlights) {
			const result = await browser.storage.local.get('highlights');
			const allHighlights = (result.highlights || {}) as Record<string, unknown>;
			if (allHighlights[window.location.href]) {
				await ensureHighlighterCSS();
			}
		}

		await highlighter.loadHighlights();
		highlighter.setPageTitle(document.title);
		updateHasHighlights();
	}

	// Initialize highlighter
	initializeHighlighter();

	// Expose highlighter API on window so reader-script.js (a separate
	// webpack bundle injected when reader mode activates) can delegate
	// all state operations to this single module instance. Without this,
	// both bundles own a copy of highlighter.ts with independent mutable
	// state — the bridge ensures one source of truth per tab.
	window.__obsidianHighlighter = {
		toggleHighlighterMenu: highlighter.toggleHighlighterMenu,
		handleTextSelection: highlighter.handleTextSelection,
		highlightElement: highlighter.highlightElement,
		applyHighlights: highlighter.applyHighlights,
		loadHighlights: highlighter.loadHighlights,
		invalidateHighlightCache: highlighter.invalidateHighlightCache,
		repositionHighlights: highlighter.repositionHighlights,
		getHighlights: highlighter.getHighlights,
		setPageUrl: highlighter.setPageUrl,
		setPageTitle: highlighter.setPageTitle,
		updatePageDomainSettings: highlighter.updatePageDomainSettings,
		clearHighlights: highlighter.clearHighlights,
		saveHighlights: highlighter.saveHighlights,
		updateHighlighterMenu: highlighter.updateHighlighterMenu,
		removeExistingHighlights,
		ensureHighlighterCSS: () => { ensureHighlighterCSS(); },
	} satisfies highlighter.HighlighterAPI;

	// Call updateHasHighlights when the page loads
	window.addEventListener('load', updateHasHighlights);

	// Deactivate highlighter mode on unload
	function handlePageUnload() {
		if (isHighlighterMode) {
			highlighter.toggleHighlighterMenu(false);
			browser.runtime.sendMessage({ action: "highlighterModeChanged", isActive: false });
			browser.storage.local.set({ isHighlighterMode: false });
		}
	}

	window.addEventListener('beforeunload', handlePageUnload);

	// Listen for custom events from the reader script
	document.addEventListener('obsidian-reader-init', async () => {
		// Find the highlighter button
		const button = document.querySelector('[data-action="toggle-highlighter"]');
		if (button) {
			// Handle highlighter button clicks
			button.addEventListener('click', async (e) => {
				try {
					// First try to get the tab ID from the background script
					const response = await browser.runtime.sendMessage({ action: "ensureContentScriptLoaded" });
					
					let tabId: number | undefined;
					if (response && typeof response === 'object') {
						tabId = (response as { tabId: number }).tabId;
					}

					// If we didn't get a tab ID, try to get it from the background script
					if (!tabId) {
						try {
							const response = await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
							if (response && !response.error && response.tabId) {
								tabId = response.tabId;
							}
						} catch (error) {
							console.error('[Content] Failed to get tab ID from background script:', error);
						}
					}

					if (tabId) {
						await browser.runtime.sendMessage({ action: "toggleHighlighterMode", tabId });
					} else {
						console.error('[Content]','Could not determine tab ID');
					}
				} catch (error) {
					console.error('[Content]','Error in toggle flow:', error);
				}
			});
		}
	});

	// Page-world visible marker for debugging — write build timestamp to document
	// root attribute so page-world JS can verify cn content.js injection version.
	try {
		document.documentElement.setAttribute('data-cn-clipper-build', String(Date.now()));
	} catch {}

	// Page-world test bridge: allows automated tests to trigger Feishu extraction
	// from page-world JS via window.postMessage. Result is written to localStorage
	// (shared by isolated/page worlds at same origin) so the caller can poll for
	// completion without holding a synchronous reply channel. Restricted to feishu
	// origins so arbitrary pages can't probe it.
	window.addEventListener('message', async (event) => {
		const data = event.data;
		if (!data || data.type !== '__obsidianClipperTestExtract__') return;
		const origin = location.hostname;
		if (!/feishu\.cn$|larksuite\.com$|^scys\.com$|wx\.zsxq\.com$|^articles\.zsxq\.com$|^mp\.weixin\.qq\.com$|docs\.qq\.com$/.test(origin)) return;
		const testId = data.testId;
		const key = '__obsidianClipperTestResult__:' + testId;
		try {
			localStorage.setItem(key, JSON.stringify({ status: 'running' }));

			// Route by URL: scys.com → scys-extractor; feishu/lark → feishu-extractor;
			// wx.zsxq.com → zsxq-extractor; mp.weixin.qq.com → inline helpers (content.ts
			// main path).
			let result: { title?: string; content?: string; author?: string; published?: string } | null = null;
			let source: 'scys' | 'feishu' | 'zsxq' | 'wechat' | null = null;
			if (isScysCourseUrl(document.URL) || isScysDocxUrl(document.URL) || isScysArticleUrl(document.URL)) {
				result = await extractScysStructuredContent(document);
				source = 'scys';
			} else if (isFeishuDocUrl(document.URL)) {
				result = await extractFeishuStructuredContent(document);
				source = 'feishu';
			} else if (isZsxqTopicUrl(document.URL) || isZsxqArticleUrl(document.URL) || isZsxqArticlesHtmlUrl(document.URL)) {
				result = await extractZsxqStructuredContent(document);
				source = 'zsxq';
			} else if (isDocsQQDocUrl(document.URL)) {
				const parsed = parseDocsQQUrl(document.URL);
				if (!parsed) {
					localStorage.setItem(key, JSON.stringify({ status: 'error', error: 'docs.qq: failed to parse URL token' }));
					return;
				}
				result = await extractDocsQQContent({ token: parsed.token, url: document.URL, doc: document });
				source = 'docsqq' as any;
			} else if (isWeChatArticleUrl(document.URL)) {
				// mp.weixin uses inline helpers in main getPageContent path
				// (not a dedicated extractor function). Replicate that path
				// here so bridge produces equivalent result shape.
				const article = document.querySelector('#js_content');
				if (article) {
					const articleClone = article.cloneNode(true) as HTMLElement;
					normalizeImageSources(articleClone as unknown as Document);
					articleClone.querySelectorAll('script, style').forEach(el => el.remove());
					normalizeMdniceArticle(articleClone);
					normalizePreBlockLineBreaks(articleClone);
					const wxContent = articleClone.outerHTML;
					const wxPublished = extractWeChatPublishedFromDocument(document);
					const titleEl = document.querySelector('h2.rich_media_title, h1.rich_media_title, title');
					const wxTitle = (titleEl?.textContent || '').trim().replace(/\s+/g, ' ');
					const authorEl = document.querySelector('#js_name');
					const wxAuthor = (authorEl?.textContent || '').trim();
					result = { title: wxTitle, content: wxContent, author: wxAuthor, published: wxPublished };
					source = 'wechat';
				}
				if (!result) {
					localStorage.setItem(key, JSON.stringify({ status: 'error', error: 'mp.weixin #js_content not found' }));
					return;
				}
			} else {
				localStorage.setItem(key, JSON.stringify({ status: 'error', error: 'unsupported url for bridge' }));
				return;
			}

			const content = result?.content || '';
			const defuddleMod = await import('defuddle/full');
			const markdown = postProcessExtractorMarkdown(defuddleMod.createMarkdownContent(content, document.URL));

			// --- Popup-path simulation (regression guard for 2026-05-16 HTML-leak bug) ---
			// The real clip flow goes through popup → initializePageContent →
			// buildVariables, where extractedContent dict overrides {{content}}.
			// Bridge previously stopped at createMarkdownContent and missed bugs in
			// the dict-overlay step. Simulate that step locally and POST what the
			// template engine would actually see.
			const sharedMod = await import('./utils/shared');
			const simulatedExtractedContent: Record<string, string> = {};
			// Mirror exactly what content.ts builds for the main path (no scys
			// content/title override — bug 2026-05-16). Comments here would be a
			// good place to add other extractor-specific dict entries if any branch
			// re-introduces the pattern.
			const simulatedVars = sharedMod.buildVariables({
				title: result?.title || '',
				author: (result as any)?.author || '',
				content: markdown,
				contentHtml: content,
				url: document.URL,
				fullHtml: '',
				description: '',
				favicon: '',
				image: '',
				published: (result as any)?.published || '',
				site: source === 'scys' ? 'Scys' : source === 'feishu' ? 'Feishu' : source === 'zsxq' ? 'ZSXQ' : (source as any) === 'docsqq' ? 'DocsQQ' : '',
				language: '',
				wordCount: (result as any)?.wordCount || 0,
				extractedContent: simulatedExtractedContent,
			});
			const popupMarkdown = simulatedVars['{{content}}'] || '';
			const popupMatchesBridge = popupMarkdown === markdown;

			// --- Obsidian-note simulation ---
			// Reproduce the final .md file that user's default template would
			// emit to Obsidian's Clippings/ folder (assembled via cn's default
			// 7-property frontmatter + {{content}} body). The result is what
			// Obsidian receives via obsidian://new?file=...&content=... —
			// equivalent to user-triggered clip output, sans Obsidian's own
			// file write. Lets e2e validation read this without any UI step.
			const fmEscape = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
			const today = new Date().toISOString().slice(0, 10);
			const fmTitle = fmEscape(simulatedVars['{{title}}'] || '');
			const fmDescription = fmEscape(simulatedVars['{{description}}'] || '');
			const fmAuthor = fmEscape(simulatedVars['{{author}}'] || '');
			const fmPublished = fmEscape(simulatedVars['{{published}}'] || '');
			const obsidianNote = [
				'---',
				`title: "${fmTitle}"`,
				`source: "${document.URL}"`,
				`author:${fmAuthor ? ` "${fmAuthor}"` : ''}`,
				`published:${fmPublished ? ` ${fmPublished}` : ''}`,
				`created: ${today}`,
				`description: ${fmDescription ? `"${fmDescription}"` : ''}`,
				`tags:`,
				`  - "clippings"`,
				'---',
				popupMarkdown,
			].join('\n');

			// Security: only upload to localhost / 127.0.0.1 (BACKLOG §5.2 option B).
			// Upload the full simulated Obsidian note (frontmatter + popup-path
			// markdown). The result file equals what user would see in
			// Clippings/, enabling fully automated e2e validation without
			// requiring the user to click the extension icon.
			let uploadedTo: string | null = null;
			let uploadError: string | null = null;
			if (data.uploadUrl && typeof data.uploadUrl === 'string') {
				try {
					const u = new URL(data.uploadUrl);
					if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
						const resp = await fetch(data.uploadUrl, { method: 'POST', body: obsidianNote });
						uploadedTo = data.uploadUrl;
						if (!resp.ok) uploadError = `HTTP ${resp.status}`;
					} else {
						uploadError = `hostname rejected: ${u.hostname}`;
					}
				} catch (e) {
					uploadError = String(e);
				}
			}
			localStorage.setItem(key, JSON.stringify({
				status: 'done',
				source,
				title: result?.title,
				contentLength: content.length,
				contentHead: content.slice(0, 500),
				contentTail: content.slice(-2000),
				markdownLength: markdown.length,
				markdownHead: markdown.slice(0, 500),
				markdownTail: markdown.slice(-1000),
				popupMarkdownLength: popupMarkdown.length,
				popupMatchesBridge,
				popupMarkdownHead: popupMarkdown.slice(0, 500),
				uploadedTo,
				uploadError,
			}));
		} catch (err) {
			localStorage.setItem(key, JSON.stringify({ status: 'error', error: String(err) }));
		}
	});

})();
