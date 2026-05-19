// src/utils/attachment-types.ts
export interface Attachment {
	name: string;
	url: string;
	size?: number;
	mimeType?: string;
}
