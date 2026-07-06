import type { R2Bucket } from '@cloudflare/workers-types';

declare global {
	namespace App {
		interface Locals {
			username: string | null;
		}
		interface Platform {
			env: {
				EVENTS: R2Bucket;
			};
			cf?: CfProperties;
			ctx?: ExecutionContext;
		}
	}
}

export {};
