import r2Service from '../service/r2-service';
import app from '../hono/hono';

/**
 * Storage-agnostic object read. This is the route clients should use for
 * attachments and inline images: unlike the bare `/attachments/` path it
 * resolves KV / R2 / S3 the same way writes do.
 */
app.get('/oss/*', async (c) => {
	const key = c.req.path.split('/oss/')[1];

	if (!key) {
		return c.text('Not found', 404);
	}

	const obj = await r2Service.getObj(c, key);

	if (!obj) {
		return c.text('Not found', 404);
	}

	// KV and S3 hand back a ready Response; R2 hands back an R2Object.
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
});
