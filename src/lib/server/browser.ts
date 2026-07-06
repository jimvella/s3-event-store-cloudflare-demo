// A thin read-only window onto the raw R2 bucket, for the "Storage" page. This
// deliberately bypasses the event-store library and talks to the R2 binding
// directly, so it shows exactly the objects (files) that exist in the bucket
// and their bytes verbatim — the payoff of "it's all just files in S3".

import type { R2Bucket } from '@cloudflare/workers-types';

export interface StoreObject {
	key: string;
	size: number;
	uploaded: string;
	etag: string;
}

export interface StoreObjectBody extends StoreObject {
	/** The stored bytes, verbatim (the event store uses plain JSON). */
	text: string;
}

/** List every object in the bucket, paginating through the cursor. */
export async function listObjects(bucket: R2Bucket): Promise<StoreObject[]> {
	const out: StoreObject[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ limit: 1000, cursor });
		for (const o of page.objects) {
			out.push({
				key: o.key,
				size: o.size,
				uploaded: o.uploaded.toISOString(),
				etag: o.etag
			});
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	out.sort((a, b) => a.key.localeCompare(b.key));
	return out;
}

/** Fetch one object's verbatim contents plus its metadata. */
export async function getObjectBody(
	bucket: R2Bucket,
	key: string
): Promise<StoreObjectBody | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;
	return {
		key,
		size: obj.size,
		uploaded: obj.uploaded.toISOString(),
		etag: obj.etag,
		text: await obj.text()
	};
}

/** Delete every object in the bucket. Returns how many were removed. */
export async function wipeBucket(bucket: R2Bucket): Promise<number> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ limit: 1000, cursor });
		for (const o of page.objects) keys.push(o.key);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	// R2 delete accepts up to 1000 keys per call.
	for (let i = 0; i < keys.length; i += 1000) {
		await bucket.delete(keys.slice(i, i + 1000));
	}
	return keys.length;
}
