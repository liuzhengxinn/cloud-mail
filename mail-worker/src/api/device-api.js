import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import pushService from '../service/push-service';

app.post('/device/reg', async (c) => {
	await pushService.register(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.delete('/device/unreg', async (c) => {
	await pushService.unregister(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});
