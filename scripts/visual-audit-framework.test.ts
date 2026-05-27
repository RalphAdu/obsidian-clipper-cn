// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { runVisualAudit, defaultNormalizeText, defaultNormalizeForCompare } from './visual-audit-framework';

describe('runVisualAudit', () => {
	it('returns 0 mismatch when markdown contains all block text', () => {
		const html = '<div id="root"><p>Hello world this is a test</p><p>Second paragraph here</p></div>';
		const md = 'Hello world this is a test\n\nSecond paragraph here';
		const r = runVisualAudit(html, md, { rootSelector: '#root' });
		expect(r.mismatches).toEqual([]);
		expect(r.totalBlocks).toBe(2);
	});

	it('reports missing text when markdown lacks a block', () => {
		const html = '<div id="root"><p>This text is present</p><p>This text is MISSING from markdown</p></div>';
		const md = 'This text is present';
		const r = runVisualAudit(html, md, { rootSelector: '#root' });
		expect(r.mismatches.length).toBe(1);
		expect(r.mismatches[0].tag).toBe('p');
		expect(r.mismatches[0].excerpt).toContain('MISSING');
	});

	it('reports root not found when rootSelector misses', () => {
		const html = '<div id="other"><p>text</p></div>';
		const r = runVisualAudit(html, 'md', { rootSelector: '#missing' });
		expect(r.mismatches.length).toBe(1);
		expect(r.mismatches[0].tag).toBe('root');
		expect(r.totalBlocks).toBe(0);
	});

	it('validates img src appears in markdown', () => {
		const html = '<div id="root"><img src="https://example.com/pic.jpg?token=abc"></div>';
		const md = '![](https://example.com/pic.jpg)';
		const r = runVisualAudit(html, md, { rootSelector: '#root' });
		expect(r.mismatches).toEqual([]);
		expect(r.totalBlocks).toBe(1);
	});

	it('reports missing img src', () => {
		const html = '<div id="root"><img src="https://example.com/missing.jpg"></div>';
		const md = 'no image link here';
		const r = runVisualAudit(html, md, { rootSelector: '#root' });
		expect(r.mismatches.length).toBe(1);
		expect(r.mismatches[0].tag).toBe('img');
	});

	it('skips data: URI images (lazy-load placeholders)', () => {
		const html = '<div id="root"><img src="data:image/png;base64,iVBOR..."></div>';
		const r = runVisualAudit(html, '', { rootSelector: '#root' });
		expect(r.mismatches).toEqual([]);
		expect(r.totalBlocks).toBe(0);
	});

	it('replaces <br> with newlines so <pre> blocks match', () => {
		const html = '<div id="root"><pre>line1<br>line2<br>line3</pre></div>';
		const md = 'line1\nline2\nline3';
		const r = runVisualAudit(html, md, { rootSelector: '#root' });
		expect(r.mismatches).toEqual([]);
	});

	it('whitespace-insensitive substring match (HTML inline ≠ markdown newlines)', () => {
		const html = '<div id="root"><li>label:<pre>code line</pre></li></div>';
		const md = '- label:\n\n  ```\n  code line\n  ```';
		const r = runVisualAudit(html, md, { rootSelector: '#root' });
		expect(r.mismatches).toEqual([]);
	});

	it('uses custom rootSelector + blockSelectors', () => {
		const html = '<article class="content"><h1>Title</h1><div>body content goes here</div></article>';
		const md = 'Title\nbody is here';
		const r = runVisualAudit(html, md, {
			rootSelector: 'article.content',
			blockSelectors: ['h1', 'div'],
		});
		expect(r.mismatches.length).toBe(1);
		expect(r.mismatches[0].tag).toBe('div');
	});

	it('uses custom imageAssert override (strict match)', () => {
		const html = '<div id="root"><img src="https://example.com/pic.jpg?v=1"></div>';
		const md = '![](https://example.com/pic.jpg)'; // missing ?v=1
		const r = runVisualAudit(html, md, {
			rootSelector: '#root',
			imageAssert: (src, md) => md.includes(src),
		});
		expect(r.mismatches.length).toBe(1);
	});
});

describe('defaultNormalizeText', () => {
	it('replaces NBSP and collapses whitespace', () => {
		expect(defaultNormalizeText('a  b   c')).toBe('a b c');
	});
	it('strips zero-width chars', () => {
		expect(defaultNormalizeText('a​b‌c﻿d')).toBe('abcd');
	});
});

describe('defaultNormalizeForCompare', () => {
	it('strips markdown emphasis markers and all whitespace', () => {
		expect(defaultNormalizeForCompare('**bold** _italic_ `code` text')).toBe('bolditaliccodetext');
	});
	it('unwraps markdown links', () => {
		expect(defaultNormalizeForCompare('[link text](http://x)')).toBe('linktext');
	});
});
