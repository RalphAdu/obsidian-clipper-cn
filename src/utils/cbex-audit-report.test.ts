import { describe, it, expect } from 'vitest';
import { buildReport } from '../../scripts/cbex-audit-report';

describe('buildReport', () => {
	it('emits PASS=100% report when all results pass', () => {
		const md = buildReport({
			stats: {
				totalIds: 1,
				pass: 1,
				fail: 0,
				e2eError: 0,
				auditInfraError: 0,
				startedAt: '2026-05-30 14:00:00',
				endedAt: '2026-05-30 14:01:00',
				roundCount: 1,
				fixCommitCount: 0,
				extractorSha: 'abc123',
				removedIds: [],
			},
			results: [{
				id: '522611',
				status: 'pass',
				fieldResults: [
					{
						field: 'title',
						pass: true,
						expected: 'X',
						groundTruths: [
							{ source: 's1', value: 'X', match: true },
							{ source: 's2', value: 'X', match: true },
						],
					},
				],
			}],
			stepReports: [
				{ step: '02', type: 'audit-round', path: 'step-reports/step-02.md', summary: 'Round 1 PASS' },
			],
			e2eErrors: [],
			auditInfraErrors: [],
		});
		expect(md).toContain('# cbex 批量 audit 报告 — 2238');
		expect(md).toContain('PASS (33 audit point 全通过) | 1 |');
		expect(md).toMatch(/\| title \| 2 \| 1 \/ 1 \|/);
		expect(md).toContain('擅自降级 audit 标准: **0 次**');
	});

	it('marks A1-A6 checkboxes correctly for PASS=100%', () => {
		const md = buildReport({
			stats: {
				totalIds: 542, pass: 542, fail: 0, e2eError: 0, auditInfraError: 0,
				startedAt: '2026-05-30 14:00:00', endedAt: '2026-05-30 16:00:00',
				roundCount: 3, fixCommitCount: 2, extractorSha: 'abc123', removedIds: [],
			},
			results: Array.from({ length: 542 }, (_, i) => ({
				id: String(521000 + i),
				status: 'pass' as const,
				fieldResults: [],
			})),
			stepReports: [],
			e2eErrors: [],
			auditInfraErrors: [],
		});
		expect(md).toContain('- [x] A1.');
		expect(md).toContain('- [x] A2.');
		expect(md).toContain('- [x] A3.');
		expect(md).toContain('- [x] A4.');
		expect(md).toContain('- [x] A5.');
		expect(md).toContain('- [x] A6.');
	});

	it('lists e2e_error and audit_infrastructure_error sections when present', () => {
		const md = buildReport({
			stats: {
				totalIds: 100, pass: 95, fail: 2, e2eError: 2, auditInfraError: 1,
				startedAt: 't1', endedAt: 't2', roundCount: 1, fixCommitCount: 0, extractorSha: 'sha', removedIds: [],
			},
			results: [],
			stepReports: [],
			e2eErrors: [{ id: '521234', error: 'net::ERR_CONNECTION_RESET', attempts: 3 }],
			auditInfraErrors: [{ id: '523456', failedXhr: 'ggnr', attempts: 3 }],
		});
		expect(md).toContain('## e2e_error 列表');
		expect(md).toContain('521234');
		expect(md).toContain('## audit_infrastructure_error 列表');
		expect(md).toContain('ggnr');
	});

	it('omits empty optional sections', () => {
		const md = buildReport({
			stats: {
				totalIds: 1, pass: 1, fail: 0, e2eError: 0, auditInfraError: 0,
				startedAt: 't1', endedAt: 't2', roundCount: 1, fixCommitCount: 0, extractorSha: 'sha', removedIds: [],
			},
			results: [],
			stepReports: [],
			e2eErrors: [],
			auditInfraErrors: [],
		});
		expect(md).not.toContain('## e2e_error 列表');
		expect(md).not.toContain('## audit_infrastructure_error 列表');
		expect(md).not.toContain('## 移除 ID');
	});
});
