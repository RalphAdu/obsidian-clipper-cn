// Force TZ=UTC before any dayjs / Date consumer is imported.
// Must be imported FIRST in any test file that compares dayjs-formatted output
// (e.g. {{date}} → "YYYY-MM-DDTHH:mm:ssZ"), otherwise the test is locked to
// whatever timezone the recording machine was in.
process.env.TZ = 'UTC';
