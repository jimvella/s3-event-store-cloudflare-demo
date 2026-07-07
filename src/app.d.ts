import type { R2Bucket } from '@cloudflare/workers-types';

declare global {
	namespace App {
		interface Locals {
			username: string | null;
		}
		interface Platform {
			env: {
				EVENTS: R2Bucket;
				/** Base64 of 32 random bytes; wraps every data key (`wrangler secret put`).
				 * Falls back to a published dev constant — set it for real deployments. */
				MASTER_KEY_SECRET?: string;
				/** Pepper for the username → subject keyed hash. Same fallback caveat. */
				SUBJECT_PEPPER?: string;
				/** Shred soft-delete waiting period in ms (default 60s — demo-short). */
				SHRED_WAITING_PERIOD_MS?: string;
			};
			cf?: CfProperties;
			ctx?: ExecutionContext;
		}
	}
}

export {};
