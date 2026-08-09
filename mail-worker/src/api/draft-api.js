import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import draftService from '../service/draft-service';

app.get('/draft/list', async (c) => {
	const data = await draftService.list(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.post('/draft/set', async (c) => {
	const data = await draftService.set(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.delete('/draft/delete', async (c) => {
	await draftService.delete(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});
