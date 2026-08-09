import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import r2Service from './service/r2-service';
import oauthService from "./service/oauth-service";
import analysisService from './service/analysis-service';
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 return await serveObject({ env }, url.pathname.substring(1));
		 }

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await oauthService.clearNoBindOathUser({ env })
		await emailService.purgeExpiredTrash({ env })
		await analysisService.refreshEchartsCache({ env })
	},
};

/**
 * Serve an object from whichever backend is configured.
 *
 * This used to call kvObjService directly, which reads KV and KV only. On an
 * instance with an R2 (or S3) bucket bound, every request here missed, the
 * handler returned null, and the runtime answered 1101 "Worker threw
 * exception" — so attachments and background images 500'd even though the
 * files were sitting in the bucket. Route through r2Service so the lookup
 * follows the same storage the writes used, and answer a plain 404 when the
 * key genuinely is not there.
 */
async function serveObject(c, key) {
	let obj;
	try {
		obj = await r2Service.getObj(c, key);
	} catch (e) {
		console.error('object fetch failed:', key, e);
		return new Response('Internal error', { status: 500 });
	}

	if (!obj) {
		return new Response('Not found', { status: 404 });
	}

	// KV returns a ready-made Response; R2/S3 return an object with a body stream.
	if (obj instanceof Response) {
		return obj;
	}

	const headers = new Headers();
	headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
	if (obj.httpMetadata?.contentDisposition) {
		headers.set('Content-Disposition', obj.httpMetadata.contentDisposition);
	}
	headers.set('Cache-Control', obj.httpMetadata?.cacheControl || 'public, max-age=259200');
	return new Response(obj.body, { headers });
}
