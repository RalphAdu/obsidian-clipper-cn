// MAIN-world content_script injected at document_start on scys.com/view/docx/*.
// Wraps JSON.parse to sniff Feishu docx block arrays that scys decrypts
// client-side from /upload/doc/*.json. Captured array is mirrored to
// localStorage so the extension's isolated-world content script can read it.
//
// Side effects:
// - JSON.parse is wrapped (transparent: original result always returned).
// - localStorage key '__cnScysDocxBlocks' written when blocks captured.
// - <html> attr 'data-cn-scys-docx-blocks' = block count (debug marker).
//
// Why plain JS not TS: webpack runtime overhead unwarranted for ~30 lines;
// MAIN-world script can't import webextension-polyfill or chrome.* APIs anyway.
(function () {
	if (window.__cnScysDocxPatchInstalled) return;
	window.__cnScysDocxPatchInstalled = true;

	var originalParse = JSON.parse;

	function isFeishuBlockArray(value) {
		if (!Array.isArray(value) || value.length === 0) return false;
		// Sample first 3 — full scan would be O(n) on every parse call.
		var max = Math.min(value.length, 3);
		for (var i = 0; i < max; i++) {
			var b = value[i];
			if (!b || typeof b !== 'object') return false;
			if (typeof b.block_id !== 'string') return false;
			if (typeof b.block_type !== 'number') return false;
		}
		return true;
	}

	function findFeishuBlockArray(value, depth) {
		if (depth > 4) return null;
		if (isFeishuBlockArray(value)) return value;
		if (!value || typeof value !== 'object') return null;
		if (Array.isArray(value)) {
			// Non-block array — walk first few entries
			var arrMax = Math.min(value.length, 5);
			for (var i = 0; i < arrMax; i++) {
				var found = findFeishuBlockArray(value[i], depth + 1);
				if (found) return found;
			}
			return null;
		}
		// Object — walk own properties
		var keys = Object.keys(value);
		for (var k = 0; k < keys.length; k++) {
			var found2 = findFeishuBlockArray(value[keys[k]], depth + 1);
			if (found2) return found2;
		}
		return null;
	}

	function tryCapture(parsed) {
		try {
			var blocks = findFeishuBlockArray(parsed, 0);
			if (!blocks) return;
			var prev = localStorage.getItem('__cnScysDocxBlocks');
			var prevLen = 0;
			if (prev) {
				try { prevLen = originalParse(prev).length; } catch (e) {}
			}
			if (blocks.length > prevLen) {
				localStorage.setItem('__cnScysDocxBlocks', JSON.stringify(blocks));
				document.documentElement.setAttribute('data-cn-scys-docx-blocks', String(blocks.length));
			}
		} catch (e) { /* never throw from a hook */ }
	}

	JSON.parse = function () {
		var result = originalParse.apply(JSON, arguments);
		tryCapture(result);
		return result;
	};
	JSON.parse.__cnOriginal = originalParse;
})();
